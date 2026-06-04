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

use crate::AppState;

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
    pub img_width: u32,
    pub img_height: u32,
}

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

    let pixel_count = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or("output dimensions overflow")?;

    // Clone the Arc<Mutex<...>> so we can move it into spawn_blocking.
    // AppState.gpu is Arc<Mutex<Option<GpuBackend>>> — we grab a reference
    // to the Arc here, then move it into the blocking closure.
    //
    // SAFETY: GpuBackend contains wgpu types which are Send on native targets.
    let gpu_arc: Arc<Mutex<Option<kaleidomo_core::backends::gpu::GpuBackend>>> =
        Arc::clone(&state.gpu_arc);

    let body = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        log::info!(
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

        gpu.render_into_buffer(&settings, &mut body[8..])
            .map_err(|e| {
                log::error!("[live_preview] GPU render failed: {e}");
                format!("GPU render failed: {e}")
            })?;

        Ok(body)
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))??;

    Ok(Response::new(body))
}