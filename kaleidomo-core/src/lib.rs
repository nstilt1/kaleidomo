use image::{DynamicImage, GenericImageView};
mod backends;

use image::{ImageBuffer, Rgba};
use rayon::prelude::*;
use std::f32::consts::PI;

pub use image;

pub use crate::backends::{KaleidoBackend, Register, inner_loop};

#[derive(Clone)]
pub enum KaleidoType {
    Radial,
    Square,
    Diamond,
    Hexagonal,
    HexagonalFlatTop,
}

#[derive(Clone)]
pub struct KaleidoSettings {
    pub count: u32,       // Number of reflections (e.g., 8)
    pub output_size: u32, // Width/Height of square output
    pub zoom: f32,        // How much of the triangle to show
    pub tile_count: f32,
    pub triangle_center_x: f32, // Center of the triangle in source image
    pub triangle_center_y: f32,
    pub triangle_rotation_rad: f32, // Rotation of the triangle in radians
    pub kaleido_type: KaleidoType,  // Type of kaleidoscope (radial, square, etc.)
}

pub fn render_kaleidoscope(
    source: &DynamicImage,
    settings: KaleidoSettings,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let (sw, sh) = source.dimensions();
    let size = settings.output_size;
    let center = size as f32 / 2.0;
    let slice_angle = (2.0 * PI) / settings.count as f32;

    // Create a flat vector for the pixels
    let mut pixels = vec![0u8; (size * size * 4) as usize];

    // Rayon parallelizes the rows automatically
    pixels
        .par_chunks_exact_mut((size * 4) as usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..size {
                // 1. Normalize coordinates relative to center
                let dx = x as f32 - center;
                let dy = y as f32 - center;

                // 2. Map to Polar
                let r = (dx * dx + dy * dy).sqrt();
                let r_sampled = r / settings.zoom;
                let mut theta = dy.atan2(dx);

                // 3. Kaleidoscope logic
                // Ensure theta is positive [0, 2pi]
                if theta < 0.0 {
                    theta += 2.0 * PI;
                }

                let slice_idx = (theta / slice_angle).floor();
                let local_theta = if slice_idx as i32 % 2 != 0 {
                    slice_angle - (theta % slice_angle)
                } else {
                    theta % slice_angle
                };

                // Use the angle from the UI (converted to radians)
                let final_angle = local_theta + settings.triangle_rotation_rad;

                // zoom/scale affects how 'far' into the source image we look
                // A higher zoom means the triangle in the source image is smaller
                //let r_scaled = r * settings.zoom;

                // Compute source image sample coordinates from the polar-mapped
                // output pixel. `r_sampled` is the radial distance (scaled by
                // `zoom`) and `final_angle` is the mapped angle for this slice
                // (including triangle rotation and mirroring). We convert these
                // back to Cartesian coordinates around the configured triangle
                // center to get `sx`,`sy`. Then ensure the coordinates fall
                // within the source image bounds and, if so, fetch that pixel
                // and copy its RGBA bytes into the output row buffer.
                let sx = settings.triangle_center_x + (r_sampled * final_angle.cos());
                let sy = settings.triangle_center_y + (r_sampled * final_angle.sin());

                // Final check: Convert to u32 only for the fetch
                if sx >= 0.0 && sx < (sw as f32) && sy >= 0.0 && sy < (sh as f32) {
                    let pixel = source.get_pixel(sx as u32, sy as u32);
                    let offset = (x * 4) as usize;
                    row[offset..offset + 4].copy_from_slice(&pixel.0);
                }

                // 4. Map back to Source Image
                // This is where you'd use your specific triangle coordinates.
                // For simplicity, we sample relative to the source center:
                //let sx = (r * local_theta.cos() * settings.zoom + (sw as f32 / 2.0)) as i32;
                //let sy = (r * local_theta.sin() * settings.zoom + (sh as f32 / 2.0)) as i32;
            }
        });

    ImageBuffer::from_raw(size, size, pixels).unwrap()
}

pub fn render_kaleidoscope_with_auto_backend(
    source: &DynamicImage,
    settings: KaleidoSettings,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if is_x86_feature_detected!("avx2") {
            return render_kaleidoscope_with_backend::<backends::avx2::__m256>(source, settings);
        } else if is_x86_feature_detected!("sse2") {
            return render_kaleidoscope_with_backend::<backends::sse2::__m128>(source, settings);
        } else {
            return render_kaleidoscope_with_backend::<f32>(source, settings);
        }
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        render_kaleidoscope_with_backend::<Register>(source, settings)
        //render_kaleidoscope_with_backend::<f32>(source, settings)
    }
}

#[inline(always)]
pub fn render_kaleidoscope_with_backend<B: KaleidoBackend>(
    source: &DynamicImage,
    settings: KaleidoSettings,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let (sw, sh) = source.dimensions();
    let size = settings.output_size;
    let center = size as f32 / 2.0;
    let slice_angle = (2.0 * PI) / settings.count as f32;

    // Create a flat vector for the pixels
    let mut pixels = vec![0u8; (size * size * 4) as usize];

    // Rayon parallelizes the rows automatically
    pixels
        .par_chunks_exact_mut((size * 4) as usize)
        .enumerate()
        .for_each(|(y, row)| {
            inner_loop::<B>(
                y,
                row,
                settings.zoom,
                source,
                &settings,
                center,
                slice_angle,
                sw,
                sh,
            );
        });

    ImageBuffer::from_raw(size, size, pixels).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, RgbaImage};

    #[test]
    fn test_simd_vs_scalar_parity() {
        // 1. Setup a dummy source image (e.g., a 100x100 gradient)
        let sw = 100;
        let sh = 100;
        let mut source_pixels = Vec::new();
        for y in 0..sh {
            for x in 0..sw {
                source_pixels.extend_from_slice(&[x as u8, y as u8, 128, 255]);
            }
        }
        let source = DynamicImage::ImageRgba8(RgbaImage::from_raw(sw, sh, source_pixels).unwrap());

        // 2. Setup Kaleidoscope settings
        let settings = KaleidoSettings {
            output_size: 64, // Keep it small for fast tests
            count: 6,        // Hexagonal symmetry
            zoom: 1.0,
            triangle_center_x: 50.0,
            triangle_center_y: 50.0,
            triangle_rotation_rad: 0.0,
            kaleido_type: KaleidoType::HexagonalFlatTop,
            tile_count: 4.0,
        };

        // 3. Render using Scalar Backend
        // Note: You may need to expose these functions or make them generic
        // to call specific backends in the same test.
        //let scalar_image = render_kaleidoscope_with_backend::<f32>(&source, settings.clone());
        let scalar_image = render_kaleidoscope_with_backend::<f32>(&source, settings.clone());

        // 4. Render using Aarch64 (Neon) Backend
        let simd_image = render_kaleidoscope_with_backend::<Register>(&source, settings.clone());

        // 5. Compare pixels
        let mut diff_count = 0;
        let threshold = 1; // Allow for 1-bit rounding difference in color channels

        for (p_scalar, p_simd) in scalar_image.pixels().zip(simd_image.pixels()) {
            for i in 0..4 {
                // Check R, G, B, A
                let diff = (p_scalar[i] as i16 - p_simd[i] as i16).abs();
                if diff > threshold {
                    diff_count += 1;
                }
            }
        }

        let total_pixels = settings.output_size * settings.output_size;
        let error_rate = diff_count as f32 / (total_pixels * 4) as f32;

        // We allow a very small error rate due to float precision differences
        // in trig approximations (Polynomial vs libm)
        assert!(
            error_rate < 0.001,
            "Neon output diverged from Scalar! Error rate: {:.4}%",
            error_rate * 100.0
        );
    }
}
