use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn export_kaleidoscope(
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

    let result_buffer = kaleidomo_core::render_kaleidoscope_with_auto_backend(&img, settings);

    // 3. Save directly to the chosen path
    result_buffer.save(path_to_save.to_string())
        .map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(format!("Successfully exported to {}", path_to_save))
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use base64::{Engine as _, engine::general_purpose};
use std::io::Cursor;

#[tauri::command]
async fn generate_kaleidoscope(
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

    let output = kaleidomo_core::render_kaleidoscope_with_auto_backend(&img, settings);

    // 3. Convert RgbaImage to Base64 so React can show it in an <img /> tag
    let mut buffer = Cursor::new(Vec::new());
    output.write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    
    let base64_str = general_purpose::STANDARD.encode(buffer.into_inner());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init()) // For saving later
        .plugin(tauri_plugin_dialog::init()) // For picking files
        .invoke_handler(tauri::generate_handler![generate_kaleidoscope, generate_video, export_kaleidoscope])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}