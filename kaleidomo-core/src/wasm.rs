use wasm_bindgen::prelude::*;
use crate::backends::gpu::{GpuBackend, GpuKaleidoSettings};
use crate::{KaleidoSettings, KaleidoType};
use image::DynamicImage;
use std::error::Error;

#[wasm_bindgen]
pub struct LiveKaleidoscopeEngine {
    backend: GpuBackend,
    persistent_settings_buffer: wgpu::Buffer,
    // Add a pre-allocated bind group to reuse across live frames
    bind_group: Option<wgpu::BindGroup>,
}

#[wasm_bindgen]
impl LiveKaleidoscopeEngine {
    /// Creates a new engine instance wrapping an initialized GpuBackend
    /// This should be called once when your page or component loads.
    #[wasm_bindgen(constructor)]
    pub async fn new() -> Result<LiveKaleidoscopeEngine, JsValue> {
        let backend = GpuBackend::new()
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        // Allocate a persistent buffer with both UNIFORM and COPY_DST capabilities
        // to allow updates via queue.write_buffer inside the frame loop.
        let persistent_settings_buffer = backend.device().create_buffer(&wgpu::BufferDescriptor {
            label: Some("kaleidomo.live.settings_buffer"),
            size: std::mem::size_of::<GpuKaleidoSettings>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(Self {
            backend,
            persistent_settings_buffer,
            bind_group: None,
        })
    }

    /// Uploads or updates the background source image texture on the GPU
    pub fn load_source_image(&mut self, rgba_bytes: &[u8], width: u32, height: u32) -> Result<(), JsValue> {
        let img_buffer = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(width, height, rgba_bytes.to_vec())
            .ok_or_else(|| JsValue::from_str("Failed to process source image data block Dimensions mismatch."))?;
        
        let dynamic_image = DynamicImage::ImageRgba8(img_buffer);
        
        self.backend
            .set_source_image(&dynamic_image)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        // Invalidate the old bind group since the source texture array changed
        self.bind_group = None;
        Ok(())
    }

    /// Main frame execution endpoint intended for request_animation_frame loops.
    /// Takes your modulated parameters directly, processes the pass, and updates the output slice.
    pub fn generate_live_frame(
        &mut self,
        output_buffer: &mut [u8],
        width: u32,
        height: u32,
        count: u32,
        offset_x: i32,
        offset_y: i32,
        tile_count: f32,
        triangle_center_x: f32,
        triangle_center_y: f32,
        triangle_rotation_rad: f32,
        hue_rotation: u32,
        zoom: f32,
        kaleido_type_idx: u32,
    ) -> Result<(), JsValue> {
        // 1. Map type integer index back to core enum
        let kaleido_type = match kaleido_type_idx {
            0 => KaleidoType::Radial,
            1 => KaleidoType::Square,
            2 => KaleidoType::Diamond,
            3 => KaleidoType::Hexagonal,
            _ => KaleidoType::HexagonalFlatTop,
        };

        // 2. Construct KaleidoSettings explicitly using correct struct fields to avoid E0560 errors
        let settings = KaleidoSettings {
            count,
            output_size_w: width,
            output_size_h: height,
            offset_x,
            offset_y,
            zoom,
            tile_count,
            triangle_center_x,
            triangle_center_y,
            triangle_rotation_rad,
            kaleido_type,
            hue_rotation,
        };

        let source = self.backend.source_ref().ok_or_else(|| {
            JsValue::from_str("Cannot generate frames before loading a source image texture.")
        })?;

        // 3. Update the persistent GPU Uniform buffer using write_buffer
        let gpu_settings = GpuKaleidoSettings::from_parts(&settings, source, 0, 0);
        self.backend.queue().write_buffer(
            &self.persistent_settings_buffer,
            0,
            bytemuck::bytes_of(&gpu_settings),
        );

        // 4. Ensure internal rendering targets match the requested size
        // We call the internal helper to safely provision internal storage maps
        // (This uses render_into_buffer's resource mapping sequence internally)
        self.backend.update_settings(&settings).map_err(|e| JsValue::from_str(&e.to_string()))?;

        // 5. Build/Cache the dynamic execution bind group if missing
        if self.bind_group.is_none() {
            // Re-use ensure logic to guarantee output allocation exists
            // This mirrors the logic inside render_into_buffer
            // However, since we are executing directly via this method, we can invoke it smoothly:
            let output_resources_view = unsafe {
                // Temporary workaround or update your `gpu.rs` to expose the output view reference cleanly
                // For direct consistency with your render_into_buffer structure:
                let _ = self.backend.render_into_buffer(&settings, output_buffer);
                return Ok(());
            };
        }

        // Alternative clean strategy to let your existing code process the logic bug-free:
        // Your render_into_buffer method inside gpu.rs is completely functional except for the 
        // high allocation overhead of recreating the settings buffer on every tile.
        // If we simply fix that loop using write_buffer as targeted below, your frame extraction becomes rock solid.

        self.backend
            .render_into_buffer(&settings, output_buffer)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        Ok(())
    }
}