// kaleidomo-core src-tauri/src/live_preview.rs
/// Native live-preview command for macOS (wgpu / Metal).
///
/// ## Why spawn_blocking?
///
/// `GpuBackend::render_into_buffer` calls `device.poll(wait_indefinitely())`
/// internally, which **parks the current OS thread** until the GPU readback
/// completes.  Tauri commands run on Tokio async worker threads; parking an
/// async worker thread deadlocks the runtime.  `spawn_blocking` moves the
/// work onto a dedicated blocking thread pool that is allowed to park.
///
/// ## Wire format (Response body)
///   [0..4]  width  LE u32
///   [4..8]  height LE u32
///   [8..]   raw RGBA pixels (width * height * 4 bytes)

use std::sync::{Arc, Mutex};

use kaleidomo_core::{KaleidoSettings, KaleidoType};
use tauri::{ipc::Response, State};

use crate::{AppState, log_error, log_info};

// ---------------------------------------------------------------------------
// Parameter struct
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LivePreviewParams {
    pub count: u32,
    pub output_size_w: u32,
    pub output_size_h: u32,
    pub offset_x: i32,
    pub offset_y: i32,
    pub zoom: f32,
    pub tile_count: f32,
    pub x: f32,
    pub y: f32,
    pub rotation: f32,
    pub kaleido_type: String,
    pub hue_rotation: u32,
    #[serde(default)]
    pub recolor_enabled: bool,
    #[serde(default)]
    pub recolor_seed: String,
    #[serde(default)]
    pub recolor_mode: u8,
    #[serde(default = "default_recolor_threshold")]
    pub recolor_threshold: f32,
    pub img_width: u32,
    pub img_height: u32,
    // ── Enhancements (see `KaleidoSettings` in kaleidomo-core/src/lib.rs) ──
    /// Bilinear texture filtering instead of nearest-neighbor. Default: `false`.
    #[serde(default)]
    pub anti_alias: u8,
    /// Internal supersampling factor, `1`-`4` (`1` disables it). Default: `1`.
    #[serde(default = "default_super_sample")]
    pub super_sample: u8,
    /// Corrects stretching of the pattern on non-square canvases. Default: `false`.
    #[serde(default)]
    pub aspect_correct: bool,
    #[serde(default = "default_reconstruction")]
    pub reconstruction_filter: String,
    #[serde(default = "default_true")]
    pub derivative_mipmapping: bool,
    #[serde(default = "default_anisotropy")]
    pub anisotropy_level: u8,
    #[serde(default = "default_edge_filter")]
    pub edge_post_process: String,
    #[serde(default)]
    pub taa_enabled: bool,
    #[serde(default = "default_taa_feedback")]
    pub taa_feedback_alpha: f32,
}

/// Default for `LivePreviewParams::super_sample` so requests sent before this
/// field existed still deserialize with supersampling disabled (`1`).
fn default_super_sample() -> u8 {
    1
}
fn default_reconstruction() -> String { "bilinear".into() }
fn default_true() -> bool { true }
fn default_anisotropy() -> u8 { 1 }
fn default_edge_filter() -> String { "disabled".into() }
fn default_taa_feedback() -> f32 { 0.9 }
fn default_recolor_threshold() -> f32 { 0.08 }

impl LivePreviewParams {
    fn to_kaleido_settings(&self) -> Result<KaleidoSettings, String> {
        let kaleido_type = match self.kaleido_type.to_lowercase().as_str() {
            "radial"            => KaleidoType::Radial,
            "square"            => KaleidoType::Square,
            "diamond"           => KaleidoType::Diamond,
            "hexagonal"         => KaleidoType::Hexagonal,
            "hexagonal_flat_top" => KaleidoType::HexagonalFlatTop,
            other => return Err(format!("unknown kaleido_type: {other}")),
        };

        Ok(KaleidoSettings {
            count: self.count,
            output_size_w: self.output_size_w,
            output_size_h: self.output_size_h,
            offset_x: self.offset_x,
            offset_y: self.offset_y,
            zoom: self.zoom,
            tile_count: self.tile_count,
            triangle_center_x: self.x,
            triangle_center_y: self.y,
            triangle_rotation_rad: self.rotation,
            kaleido_type,
            hue_rotation: self.hue_rotation,
            recolor_enabled: self.recolor_enabled,
            recolor_seed: self.recolor_seed.clone(),
            recolor_mode: self.recolor_mode,
            recolor_threshold: self.recolor_threshold,
            anti_alias: self.anti_alias,
            derivative_mipmapping: self.derivative_mipmapping,
            anisotropy_level: self.anisotropy_level,
            super_sample: self.super_sample.clamp(1, 4),
            aspect_correct: self.aspect_correct,
        })
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn render_live_preview_frame(
    state: State<'_, AppState>,
    params: LivePreviewParams,
) -> Result<Response, String> {
    let mut settings = params.to_kaleido_settings()?;

    // Clamp triangle centre to source image bounds.
    crate::clamp(
        &mut settings.triangle_center_x,
        0.0,
        params.img_width.saturating_sub(1) as f32,
    );
    crate::clamp(
        &mut settings.triangle_center_y,
        0.0,
        params.img_height.saturating_sub(1) as f32,
    );

    let w = settings.output_size_w;
    let h = settings.output_size_h;

    // `super_sample`: render at `w/h * factor` internally, then box-downsample
    // back down to `w x h` before it goes into the response body (whose header
    // always reports the requested `w`/`h`, not the oversized render size).
    let factor = kaleidomo_core::safe_super_sample(settings.super_sample, settings.output_size_w, settings.output_size_h);
    let (render_w, render_h) = (w * factor as u32, h * factor as u32);

    let pixel_count = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or("output dimensions overflow")?;

    let render_pixel_count = (render_w as usize)
        .checked_mul(render_h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or("output dimensions overflow")?;

    // Clone the Arc<Mutex<...>> so we can move it into spawn_blocking.
    // AppState.gpu is Arc<Mutex<Option<GpuBackend>>> — we grab a reference
    // to the Arc here, then move it into the blocking closure.
    //
    // SAFETY: GpuBackend contains wgpu types which are Send on native targets.
    let gpu_arc: Arc<Mutex<Option<kaleidomo_core::backends::gpu::GpuBackend>>> =
        Arc::clone(&state.gpu_arc);
    let enhancement_state = Arc::clone(&state.live_enhancement);
    let enhancement_config = kaleidomo_core::enhancement::EnhancementConfig::from_wire(
        &params.reconstruction_filter,
        params.derivative_mipmapping,
        params.anisotropy_level,
        &params.edge_post_process,
        params.taa_enabled,
        params.taa_feedback_alpha,
    );

    let body = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        log_info!(
            "[live_preview] rendering {}x{} x={:.1} y={:.1} rot={:.4} zoom={:.3} hue={}",
            w, h, settings.triangle_center_x, settings.triangle_center_y,
            settings.triangle_rotation_rad, settings.zoom, settings.hue_rotation,
        );

        let mut body = Vec::with_capacity(8 + pixel_count);
        body.extend_from_slice(&w.to_le_bytes());
        body.extend_from_slice(&h.to_le_bytes());
        body.resize(8 + pixel_count, 0u8);

        let mut guard = gpu_arc
            .lock()
            .map_err(|_| "GPU mutex poisoned".to_string())?;

        let gpu = guard
            .as_mut()
            .ok_or_else(|| "GPU backend unavailable".to_string())?;

        if factor > 1 {
            let render_settings = kaleidomo_core::KaleidoSettings {
                output_size_w: render_w,
                output_size_h: render_h,
                offset_x: settings.offset_x * factor as i32,
                offset_y: settings.offset_y * factor as i32,
                // `source_scale = width_over_2 / zoom` ties visible source
                // content to the actual render width, which just grew by
                // `factor` (render_w/h vs w/h) — without this, supersampling
                // silently zoomed the preview out relative to `w x h`.
                zoom: settings.zoom * factor as f32,
                ..settings.clone()
            };
            let mut big = vec![0u8; render_pixel_count];
            gpu.render_into_buffer(&render_settings, &mut big)
                .map_err(|e| {
                    log_error!("[live_preview] GPU render failed: {e}");
                    format!("GPU render failed: {e}")
                })?;
            let downsampled = kaleidomo_core::downsample_box(&big, render_w, render_h, factor, w, h);
            body[8..].copy_from_slice(&downsampled);
        } else {
            gpu.render_into_buffer(&settings, &mut body[8..])
                .map_err(|e| {
                    log_error!("[live_preview] GPU render failed: {e}");
                    format!("GPU render failed: {e}")
                })?;
        }

        let resolved = image::RgbaImage::from_raw(w, h, body[8..].to_vec())
            .ok_or_else(|| "invalid live-preview RGBA dimensions".to_string())?;
        let mut enhancement = enhancement_state.lock()
            .map_err(|_| "enhancement mutex poisoned".to_string())?;
        if enhancement.as_ref().map(|(config, _)| *config) != Some(enhancement_config) {
            *enhancement = Some((enhancement_config, kaleidomo_core::enhancement::EnhancementPipeline::new(enhancement_config)));
        }
        let enhanced = enhancement.as_mut().expect("enhancement initialized").1.finish_frame(&resolved);
        body[8..].copy_from_slice(enhanced.as_raw());

        Ok(body)
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))??;

    Ok(Response::new(body))
}
