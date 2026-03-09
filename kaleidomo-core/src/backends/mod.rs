use image::DynamicImage;

use crate::{KaleidoSettings, KaleidoType};

#[cfg(any(all(test, target_arch = "aarch64"), target_arch = "aarch64"))]
mod neon;

#[cfg(any(all(test, any(target_arch = "x86_64", target_arch = "x86")), any(target_arch = "x86_64", target_arch = "x86")))]
pub mod avx2;

#[cfg(any(all(test, any(target_arch = "x86_64", target_arch = "x86")), any(target_arch = "x86_64", target_arch = "x86")))]
pub mod sse2;

//#[cfg(any(not(any(target_arch = "aarch64", target_arch = "x86_64")), test))]
mod scalar;

pub trait KaleidoBackend: Sized + Copy {
    /// The number of floats that the register can hold.
    const NUM_FLOATS: usize;
    /// Loads an array of floats into the registers. Only works with cfg test.
    #[cfg(test)]
    fn load_f32s(input: &[f32]) -> Vec<Self>;
    /// Extracts the computed floats from the register and stores them into the output buffer. Only works with cfg test.
    #[cfg(test)]
    fn store_f32s(&self, output: &mut [f32]);
    /// Loads a single f32 value into all lanes of the register.
    fn load_with_single_f32(input: f32) -> Self;
    /// Loads coordinates into a register, loading NUM_FLOATS pairs.
    fn load_coords(x: u32, y: u32) -> (Self, Self);
    /// Normalizes coordinates relative to the center.
    fn normalize_coords(&mut self, center: Self);
    /// Performs the four quadrant arctangent of self (y) and other (x) in radians.
    fn atan2_k(&self, other: Self) -> Self;
    /// Maps the coordinates to polar coordinates, returning a register of (r, theta).
    fn map_to_polar(dx: Self, dy: Self, zoom: f32) -> (Self, Self);
    /// Computes the final angle from the UI.
    fn compute_angle(theta: Self, slice_angle: f32, triangle_rotation_rad: f32) -> Self;
    /// Computes the source pixel coordinates from the computed angle and radial distance.
    fn compute_source_pixel_coords(computed_angle: Self, r_sampled: Self, triangle_center_x: Self, triangle_center_y: Self) -> (Self, Self);
    /// Stores pixels into the output buffer from the source image, given the computed source coordinates.
    fn store_pixel(output: &mut [u8], x: u32, sx: Self, sy: Self, source: &DynamicImage, sw: u32, sh: u32);

    /// Folds the coordinates for square kaleidoscope.
    //fn fold_square(input: Self, count: u32, tile_size: Self) -> Self;

    fn map_square(
        dx: Self,
        dy: Self,
        center: Self,
        count: u32,
        tile_count: Self,
        zoom: Self,
        rotation: f32,
        tx: Self,
        ty: Self,
    ) -> (Self, Self);

    fn map_isoceles(
        dx: Self,
        dy: Self,
        center: Self,
        count: u32,
        tile_count: Self,
        zoom: Self,
        rotation: f32,
        tx: Self,
        ty: Self,
    ) -> (Self, Self);

    fn map_hexagonal(
        dx: Self,
        dy: Self,
        center: Self,
        count: u32,
        tile_count: Self,
        zoom: Self,
        rotation: f32,
        tx: Self,
        ty: Self,
    ) -> (Self, Self);

    fn polar_from_local(x: Self, y: Self) -> (Self, Self);
    fn fold_angle(theta: Self, count: u32) -> Self;
    fn normalize_radius_to_shape(r: Self, max_r: Self) -> Self;

    fn max_radius_square(theta: Self, half: Self) -> Self;
    fn max_radius_diamond(theta: Self, half: Self) -> Self;
    fn max_radius_hex(theta: Self, radius: Self) -> Self;

    fn hex_round(q: Self, r: Self) -> (Self, Self);
}

#[cfg(target_arch = "aarch64")]
pub type Register = core::arch::aarch64::float32x4_t;
#[cfg(target_arch = "x86_64")]
pub type Register = core::arch::x86_64::__m256;
#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
pub type Register = f32;

pub fn inner_loop<B: KaleidoBackend>(y: usize, row: &mut [u8], zoom: f32, source: &DynamicImage, settings: &KaleidoSettings, center: f32, slice_angle: f32, source_width: u32, source_height: u32) {
    let triangle_center_x = B::load_with_single_f32(settings.triangle_center_x);
    let triangle_center_y = B::load_with_single_f32(settings.triangle_center_y);
    let center = B::load_with_single_f32(center);
    let z = B::load_with_single_f32(zoom);
    let tile_count = B::load_with_single_f32(settings.tile_count);
    row.chunks_exact_mut(B::NUM_FLOATS * size_of::<f32>()).enumerate().for_each(|(x, buff)| {
        let x = x as u32 * B::NUM_FLOATS as u32;
        let (mut dx, mut dy) = B::load_coords(x as u32, y as u32);
        dx.normalize_coords(center);
        dy.normalize_coords(center);
        let (sx, sy) = match settings.kaleido_type {
            KaleidoType::Radial => {
                let (r_sampled, theta) = B::map_to_polar(dx, dy, zoom);
                let computed_angle = B::compute_angle(theta, slice_angle, settings.triangle_rotation_rad);
                B::compute_source_pixel_coords(computed_angle, r_sampled, triangle_center_x, triangle_center_y)
            },
            KaleidoType::Square => {
                B::map_square(
                    dx,
                    dy,
                    center,
                    settings.count,
                    tile_count,
                    z,
                    settings.triangle_rotation_rad,
                    triangle_center_x,
                    triangle_center_y,
                )
            },
            KaleidoType::Isoceles => {
                B::map_isoceles(
                    dx,
                    dy,
                    center,
                    settings.count,
                    tile_count,
                    z,
                    settings.triangle_rotation_rad,
                    triangle_center_x,
                    triangle_center_y,
                )
            },
            KaleidoType::Hexagonal => {
                B::map_hexagonal(
                    dx,
                    dy,
                    center,
                    settings.count,
                    tile_count,
                    z,
                    settings.triangle_rotation_rad,
                    triangle_center_x,
                    triangle_center_y,
                )
            },
        };

        B::store_pixel(buff, x, sx, sy, source, source_width, source_height);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atan2() {
        let x_arr = [
                0.0, 1.0, 0.0, -1.0, 1.0, 1.0, -1.0, -1.0
        ];
        let x = Register::load_f32s(
            &x_arr
        );
        let y_arr = [
                1.0, 0.0, -1.0, 0.0, 1.0, -1.0, 1.0, -1.0
        ];
        let y = Register::load_f32s(
            &y_arr
        );
        let result = x.iter().zip(y.iter()).map(|(x, y)| x.atan2_k(*y)).collect::<Vec<_>>();
        let expected: Vec<f32> = x_arr.iter().zip(y_arr.iter()).map(|(x, y)| x.atan2_k(*y)).collect();

        result.iter().zip(expected.chunks_exact(Register::NUM_FLOATS)).for_each(|(reg, expected_chunk)| {
            let mut output = [0.0; Register::NUM_FLOATS];
            reg.store_f32s(&mut output);
            output.iter_mut().zip(expected_chunk.iter()).for_each(|(o, e)| {
                *o = (*o - e).abs();
                assert!(*o < 0.0001, "Expected {}, got {}, diff {}", e, o, *o - e);
            });
        });
    }

    #[test]
    fn test_map_to_polar() {
        let x_arr = [
                0.0, 1.0, 0.0, -1.0
        ];
        let x = Register::load_f32s(
            &x_arr
        );
        let y_arr = [
                1.0, 0.0, -1.0, 0.0
        ];
        let y = Register::load_f32s(
            &y_arr
        );
        let zoom = 1.0;
        let result = x.iter().zip(y.iter()).map(|(x, y)| Register::map_to_polar(*x, *y, zoom)).collect::<Vec<_>>();
        let expected: Vec<(f32, f32)> = x_arr.iter().zip(y_arr.iter()).map(|(x, y)| {
            f32::map_to_polar(*x, *y, zoom)
        }).collect();

        let result_r = result.iter().map(|(r, _)| *r).collect::<Vec<_>>();
        let result_theta = result.iter().map(|(_, theta)| *theta).collect::<Vec<_>>();
        // Extract expected values into separate flat lists
        let expected_r: Vec<f32> = expected.iter().map(|(r, _)| *r).collect();
        let expected_theta: Vec<f32> = expected.iter().map(|(_, theta)| *theta).collect();

        result_r.iter().zip(expected_r.chunks_exact(Register::NUM_FLOATS)).for_each(|(reg, expected_chunk)| {
            let mut output = [0.0; Register::NUM_FLOATS];
            reg.store_f32s(&mut output);
            output.iter().zip(expected_chunk.iter()).for_each(|(o, e)| {
                assert!((*o - *e).abs() < 0.0001, "Expected {}, got {}, diff {}", e, o, *o - *e);
            });
        });
        result_theta.iter().zip(expected_theta.chunks_exact(Register::NUM_FLOATS)).for_each(|(reg, expected_chunk)| {
            let mut output = [0.0; Register::NUM_FLOATS];
            reg.store_f32s(&mut output);
            output.iter().zip(expected_chunk.iter()).for_each(|(o, e)| {
                assert!((*o - *e).abs() < 0.0001, "Expected {}, got {}, diff {}", e, o, *o - *e);
            });
        });
    }
}