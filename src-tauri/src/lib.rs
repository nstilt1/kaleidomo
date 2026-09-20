// src-tauri/src/lib.rs
const PRODUCT_NAME: &str = "Kaleidomo";
const DOWNLOADS_URL: &str = "https://alteredbrainchemistry.com/downloads/kaleidomo";
const STORE_PAGE_URL: &str = "https://alteredbrainchemistry.com/downloads/kaleidomo";
const VERSION_URL: &str = "https://hephaestus.alteredbrainchemistry.com/downloads/kaleidomo-version.txt";

use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use std::{collections::HashMap, sync::{Arc, Mutex}};
use kaleidomo_core::{KaleidoSettings, pollster};
use tauri::{Emitter, Manager, State};

use std::fs;
use std::io::Cursor;
use image::io::Reader as ImageReader;

use kaleidomo_core::backends::gpu::GpuBackend;

fn enhancement_config(reconstruction: &str, derivatives: bool, anisotropy: u8, edge: &str, taa: bool, feedback: f32) -> kaleidomo_core::enhancement::EnhancementConfig {
    kaleidomo_core::enhancement::EnhancementConfig::from_wire(reconstruction, derivatives, anisotropy, edge, taa, feedback)
}

struct EnhancingVideoSink<'a> {
    inner: &'a mut dyn kaleidomo_core::VideoFrameSink,
    width: u32,
    height: u32,
    pipeline: kaleidomo_core::enhancement::EnhancementPipeline,
}

impl kaleidomo_core::VideoFrameSink for EnhancingVideoSink<'_> {
    fn write_rgba_frame(&mut self, rgba: &[u8]) -> Result<(), kaleidomo_core::VideoSinkError> {
        let frame = image::RgbaImage::from_raw(self.width, self.height, rgba.to_vec())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid video RGBA frame dimensions"))?;
        let enhanced = self.pipeline.finish_frame(&frame);
        self.inner.write_rgba_frame(enhanced.as_raw())
    }

    fn finish(&mut self) -> Result<(), kaleidomo_core::VideoSinkError> { self.inner.finish() }
}

mod licensing;
use licensing::*;

mod live_preview;
pub use live_preview::render_live_preview_frame;

#[cfg(target_os = "macos")]
mod native_preview_surface;
#[cfg(not(target_os = "macos"))]
mod native_preview_surface {
    #[derive(Default)]
    pub struct NativePreviewSurfaceState;

    #[tauri::command]
    pub async fn mount_native_preview_surface() -> Result<(), String> {
        Err("native Metal preview is only available on macOS".into())
    }

    #[tauri::command]
    pub async fn unmount_native_preview_surface() -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn update_native_preview_surface() -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn present_native_preview_frame() -> Result<(), String> {
        Err("native Metal preview is only available on macOS".into())
    }
}

mod ffmpeg_sink;

mod preview_server;

mod audio_loopback;
pub use audio_loopback::{
    LoopbackState,
    list_loopback_sources,
    start_loopback_capture,
    stop_loopback_capture,
    get_loopback_peak,
};

use tokio::sync::Mutex as AsyncMutex;

use std::fs::File;
use std::io::BufReader;

fn apply_exif_orientation(img: image::DynamicImage, path: &str) -> image::DynamicImage {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return img,
    };

    let mut reader = BufReader::new(file);

    let exif = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(v) => v,
        Err(_) => return img,
    };

    let orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .unwrap_or(1);

    match orientation {
        1 => img,
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.fliph().rotate90(),
        6 => img.rotate90(),
        7 => img.fliph().rotate270(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn load_source_image(path: &str) -> Result<image::DynamicImage, String> {
    let bytes = fs::read(path)
        .map_err(|e| format!("failed to read image '{}': {}", path, e))?;

    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| format!("failed to guess image format for '{}': {}", path, e))?;

    let img = reader
        .decode()
        .map_err(|e| format!("failed to decode image '{}': {}", path, e))?;

    Ok(apply_exif_orientation(img, path))
}

#[cfg(feature = "logging")]
use log::*;

#[cfg(feature = "logging")]
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {{
        log::error!("{}", &::std::format!($($arg)*))
    }};
}

#[macro_export]
#[cfg(not(feature = "logging"))]
macro_rules! log_error {
    ($($arg:tt)*) => {{
    }};
}

#[cfg(feature = "logging")]
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {{
        log::info!("{}", &::std::format!($($arg)*))
    }};
}

#[macro_export]
#[cfg(not(feature = "logging"))]
macro_rules! log_info {
    ($($arg:tt)*) => {{
    }};
}

#[cfg(feature = "logging")]
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {{
        log::warn!("{}", &::std::format!($($arg)*))
    }};
}

#[macro_export]
#[cfg(not(feature = "logging"))]
macro_rules! log_warn {
    ($($arg:tt)*) => {{
    }};
}

use std::backtrace::Backtrace;
use std::panic;

fn install_panic_hook() {
    panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic payload".to_string()
        };

        // Always print to stderr so panics are visible in `bun run tauri:dev`
        // regardless of whether the `logging` feature is enabled.
        eprintln!("PANIC at {location}: {payload}");

        let backtrace = Backtrace::force_capture();
        eprintln!("Backtrace:\n{backtrace}");

        #[cfg(feature = "logging")]
        error!(
            "PANIC at {}: {}\nBacktrace:\n{}",
            location,
            payload,
            backtrace
        );
    }));
}

pub struct AppState {
    pub gpu: Arc<Mutex<Option<GpuBackend>>>,
    pub gpu_arc: Arc<Mutex<Option<GpuBackend>>>,
    /// Port the local WebSocket preview server is listening on.
    pub preview_ws_port: u16,
    pub use_gpu_acceleration: Mutex<bool>,
    pub gpu_available: bool,
    pub license_status: kaleidomo_core::LicenseStatus,
    pub license_data: kaleidomo_core::LicenseData,
    pub license_sync_cooldown: AsyncMutex<licensing::cooldown::LicenseSyncCooldownState>,
    pub loaded_gpu_image_path: Mutex<Option<String>>,
    pub last_version_fetch: AsyncMutex<Option<u64>>,
    pub live_enhancement: Arc<Mutex<Option<(kaleidomo_core::enhancement::EnhancementConfig, kaleidomo_core::enhancement::EnhancementPipeline)>>>,
    /// Path to a preset/project file (.json) passed on the command line, e.g.
    /// `kaleidomo.exe C:\presets\my-preset.kmo.json`. When present, the
    /// frontend loads it on startup and enters fullscreen "kiosk" mode
    /// (main window fullscreen, controls window never shown) instead of the
    /// normal windowed UI. `None` for a regular double-click/dev launch.
    pub cli_preset_path: Option<String>,
    // Note: LoopbackState is NOT a field here. It is registered separately via
    // app.manage(LoopbackState::new()) in run() so that tauri::State<'_, LoopbackState>
    // resolves correctly in start_loopback_capture / stop_loopback_capture / get_loopback_peak.
    // Nesting it inside AppState would make it inaccessible to those commands.
}

/// Looks for a preset/project file path passed as a command-line argument,
/// e.g. `Kaleidomo.exe "C:\presets\my-preset.kmo.json"`. Skips flags
/// (anything starting with "-") and only accepts a path that actually exists
/// on disk, so a normal double-click launch (no args) or dev-tooling flags
/// are never misinterpreted as a preset path.
fn parse_cli_preset_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && std::path::Path::new(arg).is_file())
}

/// Returns the preset/project file path (if any) that this instance of the
/// app was launched with on the command line. The frontend calls this once
/// on startup to decide whether to auto-load a preset and enter kiosk-mode
/// fullscreen instead of showing the normal windowed UI.
#[tauri::command]
fn get_cli_preset_path(state: State<'_, AppState>) -> Option<String> {
    state.cli_preset_path.clone()
}

/// Enters fullscreen on the main window WITHOUT creating, showing, or
/// focusing the controls window. Used for CLI/kiosk launches where a preset
/// path is supplied and the controls window should never be visible.
/// Contrast with `set_fullscreen`, which always shows the controls window.
#[tauri::command]
async fn set_fullscreen_kiosk(app: tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    main.set_fullscreen(true)
        .map_err(|e| format!("set_fullscreen(true) error: {e}"))?;

    // In kiosk launches the main window starts hidden (see .setup()) to avoid
    // a flash of the normal windowed UI before the preset loads, so it must
    // be explicitly shown here.
    main.show()
        .map_err(|e| format!("show main window error: {e}"))?;

    main.set_focus()
        .map_err(|e| format!("focus main window error: {e}"))?;

    Ok(())
}

fn ensure_controls_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(controls) = app.get_webview_window("controls") {
        return Ok(controls);
    }

    tauri::WebviewWindowBuilder::new(
        app,
        "controls",
        tauri::WebviewUrl::App("index.html?window=controls".into()),
    )
    .title("Kaleidomo Controls")
    .inner_size(320.0, 900.0)
    .min_inner_size(280.0, 400.0)
    .resizable(true)
    .always_on_top(true)
    .decorations(true)
    .visible(false)
    .build()
    .map_err(|e| format!("failed to create controls window: {e}"))
}

/// Show the floating controls window, recreating it if it was previously
/// destroyed rather than hidden. This is an async command so WebView2 creation
/// does not block Tauri's synchronous IPC dispatcher on Windows.
#[tauri::command]
async fn open_controls_window(app: tauri::AppHandle) -> Result<(), String> {
    let controls = ensure_controls_window(&app)?;

    controls
        .unminimize()
        .map_err(|e| format!("unminimize controls window error: {e}"))?;
    controls
        .show()
        .map_err(|e| format!("show controls window error: {e}"))?;
    controls
        .set_focus()
        .map_err(|e| format!("focus controls window error: {e}"))?;

    Ok(())
}

/// Hide the floating controls window without destroying its WebView.
/// Keeping it alive avoids recreating WebView2 while the app is running.
#[tauri::command]
async fn close_controls_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(controls) = app.get_webview_window("controls") {
        controls
            .hide()
            .map_err(|e| format!("hide controls window error: {e}"))?;
    }

    Ok(())
}

fn exit_fullscreen_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    // Native fullscreen already handles the Windows frame. Do not mutate
    // decorations before or after fullscreen; doing so can leave a borderless
    // window that visually appears to remain fullscreen.
    main
        .set_fullscreen(false)
        .map_err(|e| format!("set_fullscreen(false) error: {e}"))?;

    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();

    if let Some(controls) = app.get_webview_window("controls") {
        let _ = controls.hide();
    }

    Ok(())
}

#[tauri::command]
async fn set_fullscreen(app: tauri::AppHandle, fullscreen: bool) -> Result<(), String> {
    if !fullscreen {
        return exit_fullscreen_impl(&app);
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    // Fullscreen must never fail merely because the optional controls window
    // was not instantiated. The setup hook creates it as a fallback, but this
    // command remains tolerant so the main window can always enter fullscreen.
    main
        .set_fullscreen(true)
        .map_err(|e| format!("set_fullscreen(true) error: {e}"))?;

    let controls = ensure_controls_window(&app)?;
    controls
        .unminimize()
        .map_err(|e| format!("unminimize controls window error: {e}"))?;
    controls
        .show()
        .map_err(|e| format!("show controls window error: {e}"))?;
    controls
        .set_focus()
        .map_err(|e| format!("focus controls window error: {e}"))?;

    Ok(())
}

/// Explicit exit command used by Escape handlers in either webview.
#[tauri::command]
async fn exit_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    exit_fullscreen_impl(&app)
}

#[tauri::command]
fn get_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    window
        .is_fullscreen()
        .map_err(|e| format!("is_fullscreen error: {e}"))
}

fn round_to_nearest_multiple(value: u32, multiple: u32) -> u32 {
    if multiple == 0 {
        return value; // Avoid division by zero
    }
    ((value + multiple - 1) / multiple) * multiple
}

pub(crate) fn clamp(value: &mut f32, min: f32, max: f32) {
    *value = value.max(min);
    *value = value.min(max);
}

fn adjust_wedge_params(settings: &mut KaleidoSettings, img_width: u32, img_height: u32, _use_gpu: bool) {
    // #[cfg(target_os = "windows")]
    // if true {
    //     settings.triangle_center_x = (img_width - 1) as f32 - settings.triangle_center_x;
    //     settings.triangle_center_y = (img_height - 1) as f32 - settings.triangle_center_y;
    //     settings.triangle_rotation_rad -= core::f32::consts::PI;
    // }

    clamp(&mut settings.triangle_center_x, 0f32, img_width as f32 - 1.0);
    clamp(&mut settings.triangle_center_y, 0f32, img_height as f32 - 1.0);
}

fn adjust_path(path: &String) -> String {
    let path_str = path.to_string();

    #[cfg(target_os = "windows")]
    let path_str = path_str.replace("\\", "/");

    path_str
}

/// Limiting the license using a macro since it copies all of the code 
/// at compile time.
macro_rules! limit_license {
    ($state:expr, $output_size_w:expr, $output_size_h:expr, $offset_x:expr, $offset_y:expr, $zoom:expr, $tile_count:expr, $is_exporting:expr) => {
        let (unlocked, _license_type) = match $state.license_status.check_license(true).await {
            Ok(v) => {
                //$license_data = v.1.clone();
                log_info!("limit_license initial check was Ok(({}, {}))", v.0, v.1.license_type);
                (v.0, v.1.license_type)
            },
            Err(e) => {
                log_error!("limit_license initial check was Err({})", e.1.error_message);
                (false, "".to_string())
            }
        };
        if !unlocked && $is_exporting {
            if $output_size_h > 1280 || $output_size_w > 1280 {
                let ratio = $output_size_w as f32 / $output_size_h as f32;
                if ratio > 1.0 {
                    $output_size_w = 1280;
                    $output_size_h = (1280.0 / ratio) as u32;
                } else {
                    $output_size_h = 1280;
                    $output_size_w = (1280.0 * ratio) as u32;
                    $output_size_w = round_to_nearest_multiple($output_size_w, 8);
                }
            }
            if $zoom > 3.0 {
                $zoom = 3.0;
            } else if $zoom < 0.8 {
                $zoom = 0.8;
            }
        }
        let is_unlocked = $state.license_status.is_unlocked().await;
        log_info!("limit_license is_unlocked = {}", is_unlocked);
        if !is_unlocked || !unlocked {
            $offset_x = 0;
            $offset_y = 0;

            if $tile_count > 3.5 {
                $tile_count = 3.5;
            }

            if $output_size_h > 1280 || $output_size_w > 1280 {
                let ratio = $output_size_w as f32 / $output_size_h as f32;
                if ratio > 1.0 {
                    $output_size_w = 1280;
                    $output_size_h = (1280.0 / ratio) as u32;
                } else {
                    $output_size_h = 1280;
                    $output_size_w = (1280.0 * ratio) as u32;
                    $output_size_w = round_to_nearest_multiple($output_size_w, 8);
                }
            }
        }
    };
}

#[tauri::command]
async fn init_gpu(state: State<'_, AppState>) -> Result<(), String> {
    let backend = GpuBackend::new()
        .await
        .map_err(|e| format!("failed to initialize GPU backend: {e}"))?;

    let mut guard = state
        .gpu
        .lock()
        .map_err(|_| "failed to lock GPU state".to_string())?;

    *guard = Some(backend);
    Ok(())
}

#[tauri::command]
fn set_source_image_from_path(
    state: State<'_, AppState>,
    image_path: String,
) -> Result<(), String> {
    let image = image::open(&image_path)
        .map_err(|e| format!("failed to open image '{}': {e}", image_path))?;

    let mut guard = state
        .gpu
        .lock()
        .map_err(|_| "failed to lock GPU state".to_string())?;

    if let Some(gpu) = guard.as_mut() {
        gpu.set_source_image(&image)
        .map_err(|e| format!("failed to select source image: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn select_image(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let normalized_path = adjust_path(&path);

    {
        let current_path = state
            .loaded_gpu_image_path
            .lock()
            .map_err(|_| "failed to lock loaded GPU image path".to_string())?;

        if current_path.as_deref() == Some(normalized_path.as_str()) {
            return Ok(());
        }
    }

    let _use_gpu = {
        let guard = match state
            .use_gpu_acceleration
            .lock()
            .map_err(|_| "Failed to lock GPU preference state".to_string()) {
                Ok(v) => v,
                Err(e) => {
                    log_error!("Error select_image: {}", e);
                    return Err(e);
                }
            };
        *guard
    };

    let img = match load_source_image(&normalized_path) {
        Ok(v) => v,
        Err(e) => {
            log_error!("Error select_image open: {}", e);
            return Err(e);
        }
    };

    let mut gpu = state
        .gpu
        .lock()
        .map_err(|_| "failed to lock GPU backend".to_string())?;

    if let Some(gpu) = gpu.as_mut() {
        match gpu.set_source_image(&img).map_err(|e| e.to_string()) {
            Ok(_) => (),
            Err(e) => {
                log_error!("select_image error set_source_image: {}", e);
                return Err(e);
            }
        };
    } else {
        return Err("GPU backend is unavailable".into());
    }

    let mut current_path = match state
        .loaded_gpu_image_path
        .lock()
        .map_err(|_| "failed to lock loaded GPU image path".to_string()) {
            Ok(v) => v,
            Err(e) => {
                log_error!("select_image error current_path = ... {}", e);
                return Err(e);
            }
        };

    *current_path = Some(normalized_path);

    Ok(())
}

#[tauri::command]
async fn export_kaleidoscope(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    x: f32,
    y: f32,
    rotation: f32, 
    mut zoom: f32,
    count: u32,
    mut output_size_h: u32,
    mut output_size_w: u32,
    mut offset_x: i32,
    mut offset_y: i32,
    kaleido_type: String,
    mut tile_count: f32,
    hue_rotation: u32,
    recolor_enabled: bool,
    recolor_seed: String,
    recolor_mode: u8,
    recolor_threshold: f32,
    recolor_cell_size: f32,
    img_width: u32,
    img_height: u32,
    // ── Enhancements — see `KaleidoSettings` in kaleidomo-core/src/lib.rs ──
    anti_alias: u8,
    super_sample: u8,
    aspect_correct: bool,
    reconstruction_filter: String,
    derivative_mipmapping: bool,
    anisotropy_level: u8,
    edge_post_process: String,
    taa_enabled: bool,
    taa_feedback_alpha: f32,
) -> Result<String, String> {
    let is_exporting = true;
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom, tile_count, is_exporting);

    // 1. Open the Save Dialog first (don't render if they hit cancel)
    let file_path = app.dialog()
        .file()
        .add_filter("PNG Image", &["png"])
        .set_file_name("my_kaleidoscope.png")
        .blocking_save_file();

    let Some(path_to_save) = file_path else {
        return Err("Export cancelled".into());
    };

    // 2. Perform the high-res render
    let img = match load_source_image(&path) {
        Ok(v) => v,
        Err(e) => {
            log_error!("error export_kaleidoscope: {}", e);
            return Err(e);
        }
    };
    
    let mut settings = kaleidomo_core::KaleidoSettings {
        count,
        output_size_h,
        output_size_w,
        offset_x,
        offset_y,
        zoom,
        tile_count,
        triangle_center_x: x,
        triangle_center_y: y,
        triangle_rotation_rad: rotation,
        kaleido_type: match kaleido_type.to_lowercase().as_str() {
            "radial" => kaleidomo_core::KaleidoType::Radial,
            "square" => kaleidomo_core::KaleidoType::Square,
            "diamond" => kaleidomo_core::KaleidoType::Diamond,
            "hexagonal" => kaleidomo_core::KaleidoType::Hexagonal,
            "hexagonal_flat_top" => kaleidomo_core::KaleidoType::HexagonalFlatTop,
            _ => return Err("Invalid kaleidoscope type".into()),
        },
        hue_rotation,
        recolor_enabled,
        recolor_seed,
        recolor_mode,
        recolor_threshold,
        recolor_cell_size,
        anti_alias,
        derivative_mipmapping,
        anisotropy_level,
        super_sample: super_sample.clamp(1, 4),
        aspect_correct,
    };

    let use_gpu = {
        let guard = state
            .use_gpu_acceleration
            .lock()
            .map_err(|_| "Failed to lock GPU preference state".to_string())?;
        *guard
    };

    adjust_wedge_params(&mut settings, img_width, img_height, use_gpu);
    let enhancement = enhancement_config(&reconstruction_filter, derivative_mipmapping, anisotropy_level, &edge_post_process, taa_enabled, taa_feedback_alpha);

    if use_gpu {
        let gpu_arc = Arc::clone(&state.gpu_arc);
        let path_str = path_to_save.to_string();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut gpu_guard = gpu_arc
                .lock()
                .map_err(|_| "failed to lock GPU backend".to_string())?;
            let gpu = gpu_guard.as_mut().ok_or("GPU backend is unavailable")?;
            // `super_sample`: render at `output_size * factor` internally, then
            // box-downsample back down before saving, same as the CPU path (which
            // gets this for free via `render_kaleidoscope_with_auto_backend`).
            let factor = kaleidomo_core::safe_super_sample(settings.super_sample, settings.output_size_w, settings.output_size_h);
            let pixels = if factor > 1 {
                let render_w = output_size_w * factor as u32;
                let render_h = output_size_h * factor as u32;
                let render_settings = kaleidomo_core::KaleidoSettings {
                    output_size_w: render_w,
                    output_size_h: render_h,
                    offset_x: settings.offset_x * factor as i32,
                    offset_y: settings.offset_y * factor as i32,
                    // Keep source framing invariant when the intermediate render
                    // width grows for supersampling.
                    zoom: settings.zoom * factor as f32,
                    ..settings.clone()
                };
                let render_pixel_count = (render_w as usize)
                    .checked_mul(render_h as usize)
                    .and_then(|v| v.checked_mul(4))
                    .ok_or_else(|| "output dimensions overflowed".to_string())?;
                let mut big = vec![0u8; render_pixel_count];
                gpu.render_into_buffer(&render_settings, &mut big).map_err(|e| e.to_string())?;
                kaleidomo_core::downsample_box(&big, render_w, render_h, factor, output_size_w, output_size_h)
            } else {
                let pixel_count = (output_size_w as usize)
                    .checked_mul(output_size_h as usize)
                    .and_then(|v| v.checked_mul(4))
                    .ok_or_else(|| "output dimensions overflowed".to_string())?;
                let mut pixels = vec![0u8; pixel_count];
                gpu.render_into_buffer(&settings, &mut pixels).map_err(|e| e.to_string())?;
                pixels
            };
            let result_buffer = image::RgbaImage::from_raw(output_size_w, output_size_h, pixels)
                .ok_or_else(|| "failed to create image from GPU output".to_string())?;
            let mut pipeline = kaleidomo_core::enhancement::EnhancementPipeline::new(enhancement);
            pipeline.finish_frame(&result_buffer).save(&path_str).map_err(|e| format!("Failed to save image: {}", e))
        })
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    } else {
        let result_buffer =
            kaleidomo_core::render_kaleidoscope_with_auto_backend(
                &img,
                settings,
            );

        let mut pipeline = kaleidomo_core::enhancement::EnhancementPipeline::new(enhancement);
        pipeline.finish_frame(&result_buffer)
            .save(path_to_save.to_string())
            .map_err(|e| format!("Failed to save image: {}", e))?;
    }

    Ok(format!("Successfully exported to {}", path_to_save))
}

use base64::Engine as _;

#[tauri::command]
async fn preprocess_source_preview(
    path: String,
    seed_input: String,
    threshold: f32,
    mode: u8,
    cell_size: f32,
) -> Result<String, String> {
    let mut rgba = load_source_image(&adjust_path(&path))?.to_rgba8();
    kaleidomo_core::preprocess::preprocess_source_frame_with_mode_and_cell_size(
        &mut rgba,
        seed_input.as_bytes(),
        threshold,
        match mode {
            1 => kaleidomo_core::preprocess::RecolorMode::BorderedCells,
            2 => kaleidomo_core::preprocess::RecolorMode::SeededVoronoi,
            3 => kaleidomo_core::preprocess::RecolorMode::ConnectedComponents,
            4 => kaleidomo_core::preprocess::RecolorMode::SlicSuperpixels,
            _ => kaleidomo_core::preprocess::RecolorMode::ColorBands,
        },
        cell_size,
    ).map_err(|e| e.to_string())?;
    let mut buffer = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

#[tauri::command]
async fn generate_kaleidoscope(
    state: tauri::State<'_, AppState>,
    path: String,
    x: f32,
    y: f32,
    rotation: f32,
    count: u32,
    mut output_size_h: u32,
    mut output_size_w: u32,
    offset_x: i32,
    offset_y: i32,
    mut zoom: f32,
    kaleido_type: String,
    mut tile_count: f32,
    hue_rotation: u32,
    recolor_enabled: bool,
    recolor_seed: String,
    recolor_mode: u8,
    recolor_threshold: f32,
    recolor_cell_size: f32,
    img_width: u32,
    img_height: u32,
    // ── Enhancements — see `KaleidoSettings` in kaleidomo-core/src/lib.rs ──
    anti_alias: u8,
    super_sample: u8,
    aspect_correct: bool,
    reconstruction_filter: String,
    derivative_mipmapping: bool,
    anisotropy_level: u8,
    edge_post_process: String,
    taa_enabled: bool,
    taa_feedback_alpha: f32,
) -> Result<String, String> {
    let mut _offset_x = 0;
    let mut _offset_y = 0;
    let is_exporting = false;
    limit_license!(state, output_size_w, output_size_h, _offset_x, _offset_y, zoom, tile_count, is_exporting);

    let path = adjust_path(&path);
    // 1. Load the image from the absolute path
    let mut settings = kaleidomo_core::KaleidoSettings {
        count,
        output_size_h, // High-res preview
        output_size_w,
        offset_x,
        offset_y,
        zoom,
        tile_count,
        triangle_center_x: x,
        triangle_center_y: y,
        triangle_rotation_rad: rotation,
        kaleido_type: match kaleido_type.to_lowercase().as_str() {
            "radial" => kaleidomo_core::KaleidoType::Radial,
            "square" => kaleidomo_core::KaleidoType::Square,
            "diamond" => kaleidomo_core::KaleidoType::Diamond,
            "hexagonal" => kaleidomo_core::KaleidoType::Hexagonal,
            "hexagonal_flat_top" => kaleidomo_core::KaleidoType::HexagonalFlatTop,
            _ => return Err("Invalid kaleidoscope type".into()),
        },
        hue_rotation,
        recolor_enabled,
        recolor_seed,
        recolor_mode,
        recolor_threshold,
        recolor_cell_size,
        anti_alias,
        derivative_mipmapping,
        anisotropy_level,
        super_sample: super_sample.clamp(1, 4),
        aspect_correct,
    };

    let use_gpu = {
        let guard = state
            .use_gpu_acceleration
            .lock()
            .map_err(|_| "Failed to lock GPU preference state".to_string())?;
        *guard
    };

    adjust_wedge_params(&mut settings, img_width, img_height, use_gpu);

    let output = if use_gpu {
        let gpu_arc = Arc::clone(&state.gpu_arc);
        tauri::async_runtime::spawn_blocking(move || -> Result<image::RgbaImage, String> {
            let mut gpu_guard = gpu_arc
                .lock()
                .map_err(|_| "Failed to lock GPU backend".to_string())?;
            let gpu = gpu_guard.as_mut().ok_or("GPU backend is unavailable")?;
            // `super_sample`: see `export_kaleidoscope` above for the same wrapper.
            let factor = kaleidomo_core::safe_super_sample(settings.super_sample, settings.output_size_w, settings.output_size_h);
            let pixels = if factor > 1 {
                let render_w = output_size_w * factor as u32;
                let render_h = output_size_h * factor as u32;
                let render_settings = kaleidomo_core::KaleidoSettings {
                    output_size_w: render_w,
                    output_size_h: render_h,
                    offset_x: settings.offset_x * factor as i32,
                    offset_y: settings.offset_y * factor as i32,
                    // Keep source framing invariant when the intermediate render
                    // width grows for supersampling.
                    zoom: settings.zoom * factor as f32,
                    ..settings.clone()
                };
                let mut big = vec![0u8; (render_w * render_h * 4) as usize];
                gpu.render_into_buffer(&render_settings, &mut big).map_err(|e| e.to_string())?;
                kaleidomo_core::downsample_box(&big, render_w, render_h, factor, output_size_w, output_size_h)
            } else {
                let mut pixels = vec![0u8; (output_size_w * output_size_h * 4) as usize];
                gpu.render_into_buffer(&settings, &mut pixels).map_err(|e| e.to_string())?;
                pixels
            };
            image::RgbaImage::from_raw(output_size_w, output_size_h, pixels)
                .ok_or_else(|| "Failed to construct image".to_string())
        })
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??
    } else {
        let img = match load_source_image(&path)
            .map_err(|e| format!("Failed to open image at path '{}': {}", path, e)) {
                Ok(v) => v,
                Err(e) => {
                    log_error!("error generate_kaleidoscope: {}", e);
                    return Err(e);
                }
            };

        kaleidomo_core::render_kaleidoscope_with_auto_backend(&img, settings)
    };

    let mut pipeline = kaleidomo_core::enhancement::EnhancementPipeline::new(enhancement_config(&reconstruction_filter, derivative_mipmapping, anisotropy_level, &edge_post_process, taa_enabled, taa_feedback_alpha));
    let output = pipeline.finish_frame(&output);

    // 3. Convert RgbaImage to Base64 so React can show it in an <img /> tag
    let mut buffer = std::io::Cursor::new(Vec::new());
    output
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    let base64_str = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[tauri::command]
async fn generate_video(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    x: f32,
    y: f32,
    rotation: f32,
    count: u32,
    mut output_size_h: u32,
    mut output_size_w: u32,
    mut offset_x: i32,
    mut offset_y: i32,
    mut zoom: f32,
    kaleido_type: String,
    mut tile_count: f32,
    hue_rotation: u32,
    recolor_enabled: bool,
    recolor_seed: String,
    recolor_mode: u8,
    recolor_threshold: f32,
    recolor_cell_size: f32,
    still_frame_ending: u32,
    fps: u32,
    quality: f32,
    mut zoom_max: f32,
    mut zoom_min: f32,
    zoom_fn: String,
    zoom_start_offset: f32,
    num_zoom_loops: u32,
    img_width: u32,
    img_height: u32,
    // new video settings
    animation_duration: f32,
    rotation_range: f32,
    rotation_cycles: f32,
    rotation_start_offset: f32,
    rotation_fn: String,
    hue_range: i32,
    hue_cycles: f32,
    hue_start_offset: f32,
    hue_fn: String,
    audio_file_path: Option<String>,
    audio_reactive_enabled: bool,
    audio_peak_smoothing: f32,
    orientation_base_speed: f32,
    orientation_peak_multiplier: f32,
    audio_peaks: Vec<f32>,
    hero_circle_left_x: f32,
    hero_circle_right_x: f32,
    hero_circle_y: f32,
    // ── Enhancements — see `KaleidoSettings` in kaleidomo-core/src/lib.rs ──
    anti_alias: u8,
    super_sample: u8,
    aspect_correct: bool,
    reconstruction_filter: String,
    derivative_mipmapping: bool,
    anisotropy_level: u8,
    edge_post_process: String,
    taa_enabled: bool,
    taa_feedback_alpha: f32,
) -> Result<String, String> {
    let is_exporting = true;
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom, tile_count, is_exporting);
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom_max, tile_count, is_exporting);
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom_min, tile_count, is_exporting);
    let file_path = app.dialog()
        .file()
        .add_filter("MP4 Video", &["mp4"])
        .set_file_name("my_kaleidoscope.mp4")
        .blocking_save_file();
    let file_path = if let Some(fp) = file_path {
        fp
    } else {
        return Err("Video export cancelled".into());
    };
    // 1. Load the image from the absolute path
    let img = match load_source_image(&path) {
        Ok(v) => v,
        Err(e) => {
            log_error!("error generate_video: {}", e);
            return Err(e);
        }
    };

    let mut settings = kaleidomo_core::KaleidoSettings {
        count,
        output_size_h, // High-res preview
        output_size_w,
        offset_x,
        offset_y,
        zoom,
        tile_count,
        triangle_center_x: x,
        triangle_center_y: y,
        triangle_rotation_rad: rotation,
        kaleido_type: match kaleido_type.to_lowercase().as_str() {
            "radial" => kaleidomo_core::KaleidoType::Radial,
            "square" => kaleidomo_core::KaleidoType::Square,
            "diamond" => kaleidomo_core::KaleidoType::Diamond,
            "hexagonal" => kaleidomo_core::KaleidoType::Hexagonal,
            "hexagonal_flat_top" => kaleidomo_core::KaleidoType::HexagonalFlatTop,
            _ => return Err("Invalid kaleidoscope type".into()),
        },
        hue_rotation,
        recolor_enabled,
        recolor_seed,
        recolor_mode,
        recolor_threshold,
        recolor_cell_size,
        anti_alias,
        derivative_mipmapping,
        anisotropy_level,
        super_sample: super_sample.clamp(1, 4),
        aspect_correct,
    };

    let video_settings = kaleidomo_core::VideoSettings {
        animation_duration,
        rotation_range,
        rotation_cycles,
        rotation_start_offset,
        rotation_fn,
        hue_range,
        hue_cycles,
        hue_start_offset,
        hue_fn,
        still_frame_ending,
        fps,
        quality,
        zoom_max,
        zoom_min,
        zoom_fn,
        zoom_start_offset,
        num_zoom_loops,

        audio_reactive_enabled,
        audio_peak_smoothing,
        orientation_base_speed,
        orientation_peak_multiplier,
        audio_peaks,

        hero_circle_left_x,
        hero_circle_right_x,
        hero_circle_y,
        hero_desired_left_rotation: rotation,
    };
    let total_export_frames =
        (animation_duration * fps as f32).round() as u64 + still_frame_ending as u64;

    let use_gpu = {
        let guard = state
            .use_gpu_acceleration
            .lock()
            .map_err(|_| "Failed to lock GPU preference state".to_string())?;
        *guard
    };

    adjust_wedge_params(&mut settings, img_width, img_height, use_gpu);

    let video_enhancement = enhancement_config(&reconstruction_filter, derivative_mipmapping, anisotropy_level, &edge_post_process, taa_enabled, taa_feedback_alpha);

    // Validate the audio file (if any) up front, before we spend time
    // rendering, and resolve it to a `PathBuf` for `FfmpegSink`.
    let audio_path: Option<std::path::PathBuf> = match audio_file_path {
        Some(p) if !p.is_empty() => {
            log_info!("[generate_video] audio_file_path={p}");
            if !std::path::Path::new(&p).exists() {
                return Err(format!("Audio file does not exist: {p}"));
            }
            Some(std::path::PathBuf::from(p))
        }
        _ => None,
    };

    // Bitrate mapping carried over unchanged from the previous
    // openh264-based pipeline: resolution * fps * quality.
    let bitrate_bps =
        (output_size_w as f32 * output_size_h as f32 * fps as f32 * quality).round() as u32;
    let final_path = std::path::PathBuf::from(file_path.to_string());
    log_info!("[generate_video] video_path={}", final_path.display());

    if use_gpu {
        let gpu_arc = Arc::clone(&state.gpu_arc);
        let app_handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut sink = ffmpeg_sink::FfmpegSink::create(
                &app_handle,
                &final_path,
                output_size_w,
                output_size_h,
                fps,
                bitrate_bps,
                audio_path.as_deref(),
                total_export_frames,
            )?;
            let mut enhanced_sink = EnhancingVideoSink { inner: &mut sink, width: output_size_w, height: output_size_h, pipeline: kaleidomo_core::enhancement::EnhancementPipeline::new(video_enhancement) };
            let mut gpu_guard = gpu_arc
                .lock()
                .map_err(|_| "Failed to lock GPU backend".to_string())?;
            let gpu = gpu_guard.as_mut().ok_or("GPU backend is unavailable")?;
            kaleidomo_core::render_video_gpu(settings, video_settings, &mut enhanced_sink, gpu)
                .map_err(|e| format!("Video generation failed: {}", e))
        })
        .await
        .map_err(|e| format!("spawn_blocking error: {e}"))??;
    } else {
        let mut sink = ffmpeg_sink::FfmpegSink::create(
            &app,
            &final_path,
            output_size_w,
            output_size_h,
            fps,
            bitrate_bps,
            audio_path.as_deref(),
            total_export_frames,
        )?;
        let mut enhanced_sink = EnhancingVideoSink { inner: &mut sink, width: output_size_w, height: output_size_h, pipeline: kaleidomo_core::enhancement::EnhancementPipeline::new(video_enhancement) };
        if let Err(e) = kaleidomo_core::render_video_with_auto_backend(
            &img,
            settings,
            video_settings,
            &mut enhanced_sink,
        ) {
            return Err(format!("Video generation failed: {}", e));
        }
    };

    Ok(format!("data:video/mp4"))
}

#[tauri::command]
fn set_use_gpu_acceleration(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    if enabled && !state.gpu_available {
        return Err("GPU acceleration is not available on this system".into());
    }

    let mut guard = state
        .use_gpu_acceleration
        .lock()
        .map_err(|_| "Failed to lock GPU state")?;

    *guard = enabled;

    Ok(())
}

#[tauri::command]
fn get_use_gpu_acceleration(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let guard = state
        .use_gpu_acceleration
        .lock()
        .map_err(|_| "failed to lock GPU preference state".to_string())?;

    Ok(*guard)
}

#[tauri::command]
fn gpu_available(state: tauri::State<'_, AppState>) -> bool {
    state.gpu_available
}

#[tauri::command]
fn get_preview_ws_port(state: tauri::State<'_, AppState>) -> u16 {
    state.preview_ws_port
}

#[cfg(target_os = "macos")]
fn begin_macos_shutdown(app: &tauri::AppHandle) {
    static SHUTDOWN_STARTED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    if SHUTDOWN_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }

    // Let every WebView stop animation frames, WebSockets, media playback,
    // and WASM/native preview engines before WebKit starts destroying them.
    let _ = app.emit("kd://app-will-exit", ());

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        // macOS 14 can trap inside WebPageProxy::~WebPageProxy while tearing
        // down a busy WKWebView. The cleanup event above releases the app's
        // resources; exiting directly then avoids WebKit's faulty destructor
        // path. This only runs after an explicit close or quit request.
        std::process::exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    assert!(verify_cert() == 1);
    let gpu_backend = match pollster::block_on(GpuBackend::new()) {
        Ok(gpu) => {
            println!("GPU backend initialized");
            Some(gpu)
        }
        Err(e) => {
            eprintln!("GPU initialization failed: {e}");
            None
        }
    };

    let gpu_available_b = gpu_backend.is_some();

    // Parsed once here (rather than inside .setup()) since std::env::args()
    // reflects the process's original invocation regardless of where it's read.
    let cli_preset_path = parse_cli_preset_path();
    let is_cli_kiosk_launch = cli_preset_path.is_some();

    // Create the Arc before the Builder so it can be cloned into both the
    // kframe:// scheme handler and AppState.
    let gpu_arc_init = Arc::new(Mutex::new(gpu_backend));

    // Start the WebSocket preview server. It binds on a random localhost port
    // and serves JPEG frames outside the JSC heap (blob delivery).
    let preview_ws_port = tauri::async_runtime::block_on(
        preview_server::start(Arc::clone(&gpu_arc_init))
    );

    let mut product_id_hashmap = HashMap::with_capacity(1);
    product_id_hashmap.insert(
        "KALEIDOM-lmeFJbHEr_TBYqpeOSGjbsNl".to_string(),
        "BJiM2lHBDzyXk5dUoVo7Fg9A/CcyTDCZvSWchDYHnAyZ5v29c2rr4BTXJ+n3WEh96zljmgZC3Hn1PRsgmdjTkwgU8uvkAFiNNlxnQDVqPpvrUJEsvg5vpcggqXN1ZzC3lQ==".to_string(),
    );

    let (license_status, license_data_1) = tauri::async_runtime::block_on(async {
        kaleidomo_core::LicenseStatus::new(
            "ABCw9mRN-TeSq_IoJZi/W0JtBM0YbrlxAgNFnPm3I9U95lxksl5IIyHORLjqXT18a",
            "AlteredBrainChemistry",
            product_id_hashmap,
            true,
            "KALEIDOM-lmeFJbHEr_TBYqpeOSGjbsNl"
        )
        .await
    });

    tauri::Builder::default()
        .setup(move |app| {
            let ts = load_timestamp(app.handle());
            let cooldown_state = licensing::cooldown::load_state(&app.handle())
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            let gpu_arc = Arc::clone(&gpu_arc_init);
            app.manage(AppState {
                gpu: Arc::clone(&gpu_arc),
                gpu_arc,
                preview_ws_port,
                use_gpu_acceleration: Mutex::new(gpu_available_b),
                gpu_available: gpu_available_b,
                license_status,
                license_data: license_data_1,
                license_sync_cooldown: AsyncMutex::new(cooldown_state),
                loaded_gpu_image_path: Mutex::new(None),
                last_version_fetch: AsyncMutex::new(ts),
                live_enhancement: Arc::new(Mutex::new(None)),
                cli_preset_path: cli_preset_path.clone(),
            });
            // LoopbackState is managed independently so that tauri::State<'_, LoopbackState>
            // resolves in start_loopback_capture / stop_loopback_capture / get_loopback_peak.
            app.manage(LoopbackState::new());
            #[cfg(target_os = "macos")]
            app.manage(native_preview_surface::NativePreviewSurfaceState::default());

            // Paths chosen through the Tauri dialog plugin are automatically
            // added to the fs plugin scope. A preset supplied on the command
            // line bypasses that dialog, so explicitly allow only that exact
            // preset file before the frontend calls readTextFile().
            if let Some(preset_path) = cli_preset_path.as_deref() {
                app.fs_scope()
                    .allow_file(preset_path)
                    .map_err(|e| -> Box<dyn std::error::Error> {
                        format!("failed to allow CLI preset path '{preset_path}': {e}").into()
                    })?;
            }

            // Remove the default Tauri menu ("App / File / Edit").
            // On Windows this native menu bar sits above the WebView and would
            // remain visible even in fullscreen unless explicitly removed here.
            // On macOS the OS always shows a menu bar so this only removes the
            // Tauri-generated items; the bar itself remains but stays empty.
            if let Err(e) = app.remove_menu() {
                eprintln!("remove_menu failed (non-fatal): {e}");
            }

            // Some Tauri development configurations do not instantiate a
            // hidden secondary window from tauri.conf.json. Create the controls
            // webview here, during application setup, rather than from an IPC
            // command. Creating WebView2 from a synchronous command can block
            // the Windows event loop and leave the controls window blank.
            if app.get_webview_window("controls").is_none() {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "controls",
                    tauri::WebviewUrl::App("index.html?window=controls".into()),
                )
                .title("Kaleidomo Controls")
                .inner_size(320.0, 900.0)
                .min_inner_size(280.0, 400.0)
                .resizable(true)
                .always_on_top(true)
                .decorations(true)
                .visible(false)
                .build()
                .map_err(|e| -> Box<dyn std::error::Error> {
                    format!("failed to create controls window during setup: {e}").into()
                })?;
            }

            #[cfg(feature = "logging")]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            // Kiosk launch: hide the main window immediately so the user never
            // sees the normal windowed UI. The frontend (via get_cli_preset_path)
            // loads the preset and then calls set_fullscreen_kiosk, which shows
            // the window again already in fullscreen.
            if cli_preset_path.is_some() {
                if let Some(main) = app.get_webview_window("main") {
                    if let Err(e) = main.hide() {
                        eprintln!("failed to hide main window for kiosk launch: {e}");
                    }
                }
            }

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing the main window does not necessarily emit
                // RunEvent::ExitRequested while the hidden controls window is
                // still alive. Intercept it before Tauri drops the WKWebView so
                // the live-preview callbacks can shut down first.
                #[cfg(target_os = "macos")]
                if window.label() == "main" {
                    api.prevent_close();
                    begin_macos_shutdown(window.app_handle());
                    return;
                }

                // A CLI/kiosk launch keeps the controls WebView hidden. If the
                // main window is closed without exiting the app, that hidden
                // controls window keeps the Tauri event loop (and kaleidomo.exe)
                // alive, which also locks target/release/deps/kaleidomo.exe on
                // Windows and causes LNK1104 on the next build.
                if is_cli_kiosk_launch && window.label() == "main" {
                    window.app_handle().exit(0);
                    return;
                }

                if window.label() == "controls" {
                    // Keep the pre-created WebView2 alive during a normal app
                    // session. The title-bar X behaves like "hide controls" so
                    // the same window can be shown next time fullscreen is entered.
                    api.prevent_close();
                    if let Err(e) = window.hide() {
                        eprintln!("failed to hide controls window: {e}");
                    }
                }
            }
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("kaleidomo".to_string()),
                    },
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Webview,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            generate_kaleidoscope,
            preprocess_source_preview,
            generate_video,
            export_kaleidoscope,
            init_gpu,
            set_source_image_from_path,
            set_use_gpu_acceleration,
            get_use_gpu_acceleration,
            select_image,
            gpu_available,
            render_live_preview_frame,
            native_preview_surface::mount_native_preview_surface,
            native_preview_surface::unmount_native_preview_surface,
            native_preview_surface::update_native_preview_surface,
            native_preview_surface::present_native_preview_frame,
            get_preview_ws_port,
            license_data,
            is_unlocked,
            read_reply_from_webserver,
            is_new_version_available,
            current_version,
            display_system_stats,
            get_current_cloud_info,
            update_license,
            delete_hardware_info_from_cloud,
            product_name,
            downloads_url,
            store_page_url,
            accept_eula,
            get_eula_status,
            // Fullscreen
            set_fullscreen,
            set_fullscreen_kiosk,
            exit_fullscreen,
            get_fullscreen,
            // CLI / kiosk launch
            get_cli_preset_path,
            // Controls window
            open_controls_window,
            close_controls_window,
            // System audio loopback
            list_loopback_sources,
            start_loopback_capture,
            stop_loopback_capture,
            get_loopback_peak,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                // On macOS, destroying WKWebView while its live-preview
                // WebSocket/requestAnimationFrame callbacks are still active can
                // trip a WebKit WebPageProxy destructor assertion. Give both
                // webviews a short, explicit teardown phase before the real exit.
                if cfg!(target_os = "macos") && code.is_none() {
                    api.prevent_exit();
                    #[cfg(target_os = "macos")]
                    begin_macos_shutdown(app);
                }
            }
        });
}
