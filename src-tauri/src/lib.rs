const PRODUCT_NAME: &str = "Kaleidomo";
const DOWNLOADS_URL: &str = "https://alteredbrainchemistry.com/dashboard/downloads";
const STORE_PAGE_URL: &str = "https://alteredbrainchemistry.com/shop/kaleidomo-kaleidoscope-generator/";
const VERSION_URL: &str = "https://0-plugin-versioning.s3.us-east-1.amazonaws.com/kaleidomo-version.txt";

use tauri_plugin_dialog::DialogExt;

use std::{collections::HashMap, sync::Mutex};
use kaleidomo_core::{KaleidoSettings, pollster};
use tauri::{Manager, State};

use std::fs;
use std::io::Cursor;
use image::io::Reader as ImageReader;

use kaleidomo_core::backends::gpu::GpuBackend;

mod licensing;
use licensing::*;

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

        let backtrace = Backtrace::force_capture();
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
    pub gpu: Mutex<Option<GpuBackend>>,
    pub use_gpu_acceleration: Mutex<bool>,
    pub gpu_available: bool,
    pub license_status: kaleidomo_core::LicenseStatus,
    pub license_data: kaleidomo_core::LicenseData,
    pub license_sync_cooldown: AsyncMutex<licensing::cooldown::LicenseSyncCooldownState>,
    pub loaded_gpu_image_path: Mutex<Option<String>>,
    pub last_version_fetch: AsyncMutex<Option<u64>>,
}

fn round_to_nearest_multiple(value: u32, multiple: u32) -> u32 {
    if multiple == 0 {
        return value; // Avoid division by zero
    }
    ((value + multiple - 1) / multiple) * multiple
}

fn clamp(value: &mut f32, min: f32, max: f32) {
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
    ($state:expr, $output_size_w:expr, $output_size_h:expr, $offset_x:expr, $offset_y:expr, $zoom:expr, $tile_count:expr) => {
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
        if !unlocked {
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
    img_width: u32,
    img_height: u32,
) -> Result<String, String> {
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom, tile_count);

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
        hue_rotation
    };

    let use_gpu = {
        let guard = state
            .use_gpu_acceleration
            .lock()
            .map_err(|_| "Failed to lock GPU preference state".to_string())?;
        *guard
    };

    adjust_wedge_params(&mut settings, img_width, img_height, use_gpu);

    if use_gpu {
        let mut gpu = state
            .gpu
            .lock()
            .map_err(|_| "failed to lock GPU backend".to_string())?;

        let gpu = match gpu.as_mut() {
            Some(gpu) => gpu,
            None => {
                return Err("GPU backend is unavailable".into());
            }
        };

        //gpu.set_source_image(&img).map_err(|e| e.to_string())?;

        let mut pixels = vec![
            0u8;
            (output_size_w as usize)
                .checked_mul(output_size_h as usize)
                .and_then(|v| v.checked_mul(4))
                .ok_or_else(|| "output dimensions overflowed".to_string())?
        ];

        gpu.render_into_buffer(&settings, &mut pixels)
            .map_err(|e| e.to_string())?;

        let result_buffer = image::RgbaImage::from_raw(output_size_w, output_size_h, pixels)
            .ok_or_else(|| "failed to create image from GPU output".to_string())?;

        result_buffer
            .save(path_to_save.to_string())
            .map_err(|e| format!("Failed to save image: {}", e))?;
    } else {
        let result_buffer =
            kaleidomo_core::render_kaleidoscope_with_auto_backend(
                &img,
                settings,
            );

        result_buffer
            .save(path_to_save.to_string())
            .map_err(|e| format!("Failed to save image: {}", e))?;
    }

    Ok(format!("Successfully exported to {}", path_to_save))
}

use base64::Engine as _;

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
    img_width: u32,
    img_height: u32,
) -> Result<String, String> {
    let mut _offset_x = 0;
    let mut _offset_y = 0;
    limit_license!(state, output_size_w, output_size_h, _offset_x, _offset_y, zoom, tile_count);

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
        let mut gpu_guard = state
            .gpu
            .lock()
            .map_err(|_| "Failed to lock GPU backend".to_string())?;

        let gpu = match gpu_guard.as_mut() {
            Some(gpu) => gpu,
            None => {
                return Err("GPU backend is unavailable".into());
            }
        };

        let mut pixels = vec![0u8; (output_size_w * output_size_h * 4) as usize];

        gpu.render_into_buffer(&settings, &mut pixels)
            .map_err(|e| e.to_string())?;

        image::RgbaImage::from_raw(output_size_w, output_size_h, pixels)
            .ok_or_else(|| "Failed to construct image".to_string())?
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
    frame_count: u32,
    still_frame_ending: u32,
    fps: u32,
    quality: f32,
    triangle_rotation_degrees_per_frame: f32,
    hue_rotation_degrees_per_frame: f32,
    mut zoom_max: f32,
    mut zoom_min: f32,
    zoom_fn: String,
    zoom_start_offset: f32,
    num_zoom_loops: u32,
    img_width: u32,
    img_height: u32,
) -> Result<String, String> {
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom, tile_count);
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom_max, tile_count);
    limit_license!(state, output_size_w, output_size_h, offset_x, offset_y, zoom_min, tile_count);
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
    };

    let video_settings = kaleidomo_core::VideoSettings {
        frame_count,
        still_frame_ending,
        fps,
        quality,
        triangle_rotation_degrees_per_frame,
        hue_rotation_degrees_per_frame,
        zoom_max,
        zoom_min,
        zoom_fn,
        zoom_start_offset,
        num_zoom_loops,
    };

    let use_gpu = {
        let guard = state
            .use_gpu_acceleration
            .lock()
            .map_err(|_| "Failed to lock GPU preference state".to_string())?;
        *guard
    };

    adjust_wedge_params(&mut settings, img_width, img_height, use_gpu);

    let _output = if use_gpu {
        let mut gpu_guard = state
            .gpu
            .lock()
            .map_err(|_| "Failed to lock GPU backend".to_string())?;

        let gpu = match gpu_guard.as_mut() {
            Some(gpu) => gpu,
            None => {
                return Err("GPU backend is unavailable".into());
            }
        };

        kaleidomo_core::render_video_gpu(settings, video_settings, &file_path.to_string(), gpu)
            .map_err(|e| format!("Video generation failed: {}", e))?
    } else {
        match kaleidomo_core::render_video_with_auto_backend(&img, settings, video_settings, &file_path.to_string()) {
            Ok(_) => (),
            Err(e) => return Err(format!("Video generation failed: {}", e)),
        };
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

            app.manage(AppState {
                gpu: Mutex::new(gpu_backend),
                use_gpu_acceleration: Mutex::new(gpu_available_b),
                gpu_available: gpu_available_b,
                license_status,
                license_data: license_data_1,
                license_sync_cooldown: AsyncMutex::new(cooldown_state),
                loaded_gpu_image_path: Mutex::new(None),
                last_version_fetch: AsyncMutex::new(ts),
            });
            
            #[cfg(feature = "logging")]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            Ok(())
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
            generate_video,
            export_kaleidoscope,
            init_gpu,
            set_source_image_from_path,
            set_use_gpu_acceleration,
            get_use_gpu_acceleration,
            select_image,
            gpu_available,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}