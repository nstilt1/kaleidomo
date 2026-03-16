use tauri_plugin_dialog::DialogExt;

use std::sync::Mutex;
use kaleidomo_core::{KaleidoSettings, anyhow::Context, pollster};
use image::DynamicImage;
use kaleidomo_core::log::error;
use serde::{Deserialize, Serialize};
use tauri::State;

use kaleidomo_core::backends::gpu::GpuBackend;
pub struct AppState {
    gpu: Mutex<GpuBackend>,
    pub use_gpu_acceleration: Mutex<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderResponse {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
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

    *guard = backend;
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

    guard
        .set_source_image(&image)
        .map_err(|e| format!("failed to upload source image: {e}"))
}

#[tauri::command]
fn render_kaleido_with_gpu(
    state: State<'_, AppState>,
    settings: KaleidoSettings,
) -> Result<RenderResponse, String> {
    let mut guard = state
        .gpu
        .lock()
        .map_err(|_| "failed to lock GPU state".to_string())?;

    let len = (settings.output_size_w as usize)
        .checked_mul(settings.output_size_h as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| "output dimensions overflowed".to_string())?;

    let mut output = vec![0u8; len];

    guard
        .render_into_buffer(&settings, &mut output)
        .map_err(|e| format!("failed to render kaleidoscope: {e}"))?;

    Ok(RenderResponse {
        width: settings.output_size_w,
        height: settings.output_size_h,
        rgba: output,
    })
}

#[tauri::command]
async fn export_kaleidoscope(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    x: f32,
    y: f32,
    rotation: f32, 
    zoom: f32,
    count: u32,
    output_size_h: u32,
    output_size_w: u32,
    offset_x: i32,
    offset_y: i32,
    kaleido_type: String,
    tile_count: f32,
    hue_rotation: u32,
) -> Result<String, String> {
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
            .map_err(|_| "failed to lock GPU preference state".to_string())?;
        *guard
    };

    if use_gpu {
        let mut gpu = state
            .gpu
            .lock()
            .map_err(|_| "failed to lock GPU backend".to_string())?;

        gpu.set_source_image(&img).map_err(|e| e.to_string())?;

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

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
    output_size_h: u32,
    output_size_w: u32,
    offset_x: i32,
    offset_y: i32,
    zoom: f32,
    kaleido_type: String,
    tile_count: f32,
    hue_rotation: u32,
) -> Result<String, String> {
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
            .map_err(|_| "failed to lock GPU preference state".to_string())?;
        *guard
    };

    let output = if use_gpu {
        let mut gpu = state
            .gpu
            .lock()
            .map_err(|_| "failed to lock GPU backend".to_string())?;

        gpu.set_source_image(&img).map_err(|e| e.to_string())?;

        let mut pixels = vec![
            0u8;
            (output_size_w as usize)
                .checked_mul(output_size_h as usize)
                .and_then(|v| v.checked_mul(4))
                .ok_or_else(|| "output dimensions overflowed".to_string())?
        ];

        gpu.render_into_buffer(&settings, &mut pixels)
            .map_err(|e| e.to_string())?;

        image::RgbaImage::from_raw(output_size_w, output_size_h, pixels)
            .ok_or_else(|| "failed to create image from GPU output".to_string())?
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
    app: tauri::AppHandle,
    path: String,
    x: f32,
    y: f32,
    rotation: f32,
    count: u32,
    output_size_h: u32,
    output_size_w: u32,
    offset_x: i32,
    offset_y: i32,
    zoom: f32,
    kaleido_type: String,
    tile_count: f32,
    hue_rotation: u32,
    frame_count: u32,
    still_frame_ending: u32,
    fps: u32,
    quality: f32,
    triangle_rotation_degrees_per_frame: f32,
    hue_rotation_degrees_per_frame: f32,
    zoom_max: f32,
    zoom_min: f32,
    zoom_fn: String,
    zoom_start_offset: f32,
    num_zoom_loops: u32,
) -> Result<String, String> {
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

    match kaleidomo_core::render_video_with_auto_backend(&img, settings, video_settings, &file_path.to_string()) {
        Ok(_) => (),
        Err(e) => return Err(format!("Video generation failed: {}", e)),
    };

    Ok(format!("data:video/mp4"))
}

#[tauri::command]
fn set_use_gpu_acceleration(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut guard = state
        .use_gpu_acceleration
        .lock()
        .map_err(|_| "failed to lock GPU preference state".to_string())?;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let backend = pollster::block_on(GpuBackend::new()).unwrap_or_else(|e| {
        error!("failed to create initial GpuBackend: {e}");
        panic!("failed to create initial GpuBackend: {e}");
    });

    tauri::Builder::default()
        .manage(AppState {
            gpu: Mutex::new(backend),
            use_gpu_acceleration: Mutex::new(true),
        })
        .plugin(tauri_plugin_fs::init()) // For saving later
        .plugin(tauri_plugin_dialog::init()) // For picking files
        .invoke_handler(tauri::generate_handler![
            generate_kaleidoscope, 
            generate_video, 
            export_kaleidoscope,
            init_gpu,
            set_source_image_from_path,
            render_kaleido_with_gpu,
            set_use_gpu_acceleration,
            get_use_gpu_acceleration,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}