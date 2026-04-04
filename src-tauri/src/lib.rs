const VERSION: &str = "0.9.1";
const PRODUCT_NAME: &str = "Kaleidomo";
const DOWNLOADS_URL: &str = "https://alteredbrainchemistry.com/dashboard/downloads";
const STORE_PAGE_URL: &str = "https://alteredbrainchemistry.com/shop/kaleidomo-kaleidoscope-generator/";

use tauri_plugin_dialog::DialogExt;

use std::{collections::HashMap, sync::Mutex};
use kaleidomo_core::pollster;
use tauri::{Manager, State};

use tauri::menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder};


use kaleidomo_core::backends::gpu::GpuBackend;

mod licensing;
use licensing::*;

use tokio::sync::Mutex as AsyncMutex;

pub struct AppState {
    pub gpu: Mutex<Option<GpuBackend>>,
    pub use_gpu_acceleration: Mutex<bool>,
    pub gpu_available: bool,
    pub license_status: kaleidomo_core::LicenseStatus,
    pub license_data: kaleidomo_core::LicenseData,
    pub license_sync_cooldown: AsyncMutex<licensing::cooldown::LicenseSyncCooldownState>,
}

fn round_to_nearest_multiple(value: u32, multiple: u32) -> u32 {
    if multiple == 0 {
        return value; // Avoid division by zero
    }
    ((value + multiple - 1) / multiple) * multiple
}

/// Limiting the license using a macro since it copies all of the code 
/// at compile time.
macro_rules! limit_license {
    ($state:expr, $output_size_w:expr, $output_size_h:expr, $offset_x:expr, $offset_y:expr, $zoom:expr, $tile_count:expr) => {
        let (unlocked, license_type) = match $state.license_status.check_license(true).await {
            Ok(v) => {
                //$license_data = v.1.clone();
                (v.0, v.1.license_type)
            },
            Err(_) => (false, "".to_string())
        };
        if license_type.to_lowercase().as_str() != "perpetual" || !unlocked {
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
    let img = image::open(&path).map_err(|e| e.to_string())?;
    
    let mut gpu = state
        .gpu
        .lock()
        .map_err(|_| "failed to lock GPU backend".to_string())?;

    if let Some(gpu) = gpu.as_mut() {
        gpu.set_source_image(&img).map_err(|e| e.to_string())?;
    }
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
    let img = image::open(&path).map_err(|e| e.to_string())?;
    
    let settings = kaleidomo_core::KaleidoSettings {
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
) -> Result<String, String> {
    let mut _offset_x = 0;
    let mut _offset_y = 0;
    limit_license!(state, output_size_w, output_size_h, _offset_x, _offset_y, zoom, tile_count);
    // 1. Load the image from the absolute path
    let img = image::open(&path).map_err(|e| e.to_string())?;

    let settings = kaleidomo_core::KaleidoSettings {
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
    let img = image::open(&path).map_err(|e| e.to_string())?;

    let settings = kaleidomo_core::KaleidoSettings {
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
            let cooldown_state = licensing::cooldown::load_state(&app.handle())
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

            app.manage(AppState {
                gpu: Mutex::new(gpu_backend),
                use_gpu_acceleration: Mutex::new(gpu_available_b),
                gpu_available: gpu_available_b,
                license_status,
                license_data: license_data_1,
                license_sync_cooldown: AsyncMutex::new(cooldown_state),
            });

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&edit_menu)
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}