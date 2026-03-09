use image::{DynamicImage, GenericImageView};

use super::KaleidoBackend;

impl KaleidoBackend for f32 {
    const NUM_FLOATS: usize = 1;

    #[cfg(test)]
    fn load_f32s(input: &[f32]) -> Vec<Self> {
        input.to_vec()
    }

    #[cfg(test)]
    fn store_f32s(&self, output: &mut [f32]) {
        output[0] = *self;
    }

    fn load_with_single_f32(input: f32) -> Self {
        input
    }

    fn load_coords(x: u32, y: u32) -> (Self, Self) {
        (x as f32, y as f32)
    }

    fn normalize_coords(&mut self, center: Self) {
        *self -= center;
    }

    fn atan2_k(&self, other: Self) -> Self {
        self.atan2(other)
    }

    fn map_to_polar(dx: Self, dy: Self, zoom: f32) -> (Self, Self) {
        let r = (dx * dx + dy * dy).sqrt();
        let r_sampled = r / zoom;
        let mut theta = dy.atan2(dx);
        if theta < 0.0 { theta += 2.0 * core::f32::consts::PI; }
        (r_sampled, theta)
    }

    fn compute_angle(theta: Self, slice_angle: f32, triangle_rotation_rad: f32) -> Self {
        let slice_idx = (theta / slice_angle).floor();
        let local_theta = if slice_idx as i32 % 2 != 0 {
            slice_angle - (theta % slice_angle)
        } else {
            theta % slice_angle
        };
        local_theta + triangle_rotation_rad
    }

    fn compute_source_pixel_coords(computed_angle: Self, r_sampled: Self, triangle_center_x: f32, triangle_center_y: f32) -> (Self, Self) {
        let sx = computed_angle.cos() * r_sampled + triangle_center_x;
        let sy = computed_angle.sin() * r_sampled + triangle_center_y;
        (sx, sy)
    }

    fn store_pixel(output: &mut [u8], _x: u32, sx: Self, sy: Self, source: &DynamicImage, sw: u32, sh: u32) {
        let sx_i = sx.round() as u32;
        let sy_i = sy.round() as u32;
        if sx_i < sw && sy_i < sh {
            let pixel = source.get_pixel(sx_i, sy_i);
            output[0.. 4].copy_from_slice(&pixel.0);
        }
    }

    //fn fold_square(input: Self, tile_size: Self) -> Self {
    //    let period = tile_size * 2.0;
    //    ((input % period + period) % period - tile_size).abs()
    //}

    // fn fold_square(input: Self, count: u32, tile_size: Self) -> Self {
    //     let folds_per_axis = (count as f32 / 4.0).max(1.0);
    //     let effective_tile = tile_size / folds_per_axis;
    //     let period = tile_size * 2.0;
    //     ((input % period + period) % period - effective_tile).abs()
    // }

    fn map_square(
        dx: Self,
        dy: Self,
        center: Self,
        count: u32,
        tile_count: Self,
        zoom: Self,
        triangle_rotation_rad: f32,
        triangle_center_x: Self,
        triangle_center_y: Self,
    ) -> (Self, Self) {
        let count = count.clamp(3, 40) as f32;
        let two_pi = 2.0 * core::f32::consts::PI;

        let screen_size = center * 2.0;
        let tile_size = screen_size / tile_count.max(0.0001);
        let half = tile_size * 0.5;

        let local_x = (dx + half).rem_euclid(tile_size) - half;
        let local_y = (dy + half).rem_euclid(tile_size) - half;

        // Canonical square domain independent of tile size
        let mut x = local_x / half;
        let mut y = local_y / half;

        // First fold to a full-angle wedge using repeated symmetry.
        let slice_angle = two_pi / count;

        // Bring into principal half-plane first
        if y < 0.0 {
            y = -y;
        }

        // Because a single reflection only handles one boundary pair,
        // iterate a few times to settle into the wedge.
        for _ in 0..4 {
            let (fx, fy) = fold_point_into_wedge(x, y, slice_angle);
            if (fx - x).abs() < 1.0e-6 && (fy - y).abs() < 1.0e-6 {
                break;
            }
            x = fx;
            y = fy;
        }

        let source_scale = center / zoom.max(0.0001);

        let sx_local = x * source_scale;
        let sy_local = y * source_scale;

        let sin_r = triangle_rotation_rad.sin();
        let cos_r = triangle_rotation_rad.cos();

        let rx = sx_local * cos_r - sy_local * sin_r;
        let ry = sx_local * sin_r + sy_local * cos_r;

        (
            triangle_center_x + rx,
            triangle_center_y + ry,
        )
    }


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
    ) -> (Self, Self) {
        let screen_size = center * 2.0;
        let tile = screen_size / tile_count.max(0.0001);
        let half = tile * 0.5;

        let inv_sqrt2 = 0.70710678118_f32;
        let u = (dx + dy) * inv_sqrt2;
        let v = (dy - dx) * inv_sqrt2;

        let local_u = (u + half).rem_euclid(tile) - half;
        let local_v = (v + half).rem_euclid(tile) - half;

        let (r, theta) = Self::polar_from_local(local_u, local_v);
        let folded_theta = Self::fold_angle(theta, count);
        let final_theta = folded_theta + rotation;

        let max_r = Self::max_radius_diamond(final_theta, half);
        let normalized_r = Self::normalize_radius_to_shape(r, max_r);

        let source_scale = center / zoom.max(0.0001);
        let sample_r = normalized_r * source_scale;

        (
            tx + sample_r * final_theta.cos(),
            ty + sample_r * final_theta.sin(),
        )
    }

    fn map_hexagonal(
        dx: Self,
        dy: Self,
        center: Self,
        count: u32,
        tile_count: Self,
        zoom: Self,
        triangle_rotation_rad: f32,
        triangle_center_x: Self,
        triangle_center_y: Self,
    ) -> (Self, Self) {
        let count = count.clamp(3, 40) as f32;
        let sqrt3 = (3.0f32).sqrt();

        let screen_size = center * 2.0;

        // Approximate "tile_count across" control for pointy-top hexes.
        let hex_radius = screen_size / (tile_count.max(0.0001) * sqrt3);

        let q = (sqrt3 / 3.0 * dx - 1.0 / 3.0 * dy) / hex_radius;
        let r = (2.0 / 3.0 * dy) / hex_radius;

        let (rq, rr) = Self::hex_round(q, r);

        let hex_cx = hex_radius * sqrt3 * (rq + rr * 0.5);
        let hex_cy = hex_radius * 1.5 * rr;

        let local_x = dx - hex_cx;
        let local_y = dy - hex_cy;

        let r_local = (local_x * local_x + local_y * local_y).sqrt();
        let mut theta = local_y.atan2(local_x);
        if theta < 0.0 {
            theta += 2.0 * core::f32::consts::PI;
        }

        let slice_angle = 2.0 * core::f32::consts::PI / count;
        let slice_idx = (theta / slice_angle).floor();
        let local_theta = theta % slice_angle;
        let folded_theta = if (slice_idx as i32) % 2 != 0 {
            slice_angle - local_theta
        } else {
            local_theta
        };

        // Use the ORIGINAL theta for tile-boundary normalization.
        let geom_dir_x = theta.cos();
        let geom_dir_y = theta.sin();

        let b1 = geom_dir_x.abs();
        let b2 = (0.5 * geom_dir_x + (sqrt3 * 0.5) * geom_dir_y).abs();
        let b3 = (0.5 * geom_dir_x - (sqrt3 * 0.5) * geom_dir_y).abs();
        let denom = b1.max(b2).max(b3);

        let max_r = if denom > 1.0e-6 {
            hex_radius / denom
        } else {
            0.0
        };

        let normalized_r = if max_r > 1.0e-6 {
            (r_local / max_r).clamp(0.0, 1.0)
        } else {
            0.0
        };

        // Use the folded/rotated angle only for source sampling.
        let final_theta = folded_theta + triangle_rotation_rad;

        let source_scale = center / zoom.max(0.0001);
        let sample_r = normalized_r * source_scale;

        let sx = triangle_center_x + sample_r * final_theta.cos();
        let sy = triangle_center_y + sample_r * final_theta.sin();

        (sx, sy)
    }

    fn fold_angle(theta: Self, count: u32) -> Self {
        let count = count.clamp(3, 40) as f32;
        let two_pi = 2.0 * core::f32::consts::PI;
        let theta = theta.rem_euclid(two_pi);

        let slice_angle = two_pi / count;
        let slice_idx = (theta / slice_angle).floor();
        let local_theta = theta % slice_angle;

        if (slice_idx as i32) % 2 != 0 {
            slice_angle - local_theta
        } else {
            local_theta
        }
    }

    fn polar_from_local(x: Self, y: Self) -> (Self, Self) {
        let r = (x * x + y * y).sqrt();
        let theta = y.atan2(x).rem_euclid(2.0 * core::f32::consts::PI);
        (r, theta)
    }

    fn max_radius_square(theta: Self, half: Self) -> Self {
        let dir_x = theta.cos().abs();
        let dir_y = theta.sin().abs();

        let max_r_x = if dir_x > 1.0e-6 { half / dir_x } else { f32::INFINITY };
        let max_r_y = if dir_y > 1.0e-6 { half / dir_y } else { f32::INFINITY };

        max_r_x.min(max_r_y)
    }

    fn max_radius_diamond(theta: Self, half: Self) -> Self {
        let denom = theta.cos().abs() + theta.sin().abs();
        if denom > 1.0e-6 {
            half / denom
        } else {
            0.0
        }
    }

    fn max_radius_hex(theta: Self, radius: Self) -> Self {
        let sqrt3 = (3.0f32).sqrt();
        let dir_x = theta.cos();
        let dir_y = theta.sin();

        let b1 = dir_x.abs();
        let b2 = (0.5 * dir_x + 0.5 * sqrt3 * dir_y).abs();
        let b3 = (0.5 * dir_x - 0.5 * sqrt3 * dir_y).abs();

        let denom = b1.max(b2).max(b3);

        if denom > 1.0e-6 {
            radius / denom
        } else {
            0.0
        }
    }
    
    fn normalize_radius_to_shape(r: Self, max_r: Self) -> Self {
        if max_r > 1.0e-6 {
            (r / max_r).clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    fn hex_round(q: Self, r: Self) -> (Self, Self) {
        let s = -q - r;
        let mut rq = q.round();
        let mut rr = r.round();
        let rs = s.round();

        let q_diff = (rq - q).abs();
        let r_diff = (rr - r).abs();
        let s_diff = (rs - s).abs();

        if q_diff > r_diff && q_diff > s_diff {
            rq = -rr - rs;
        } else if r_diff > s_diff {
            rr = -rq - rs;
        }
        // rs is implicitly -rq - rr
        (rq, rr)
    }
}

fn reflect_across_line(x: f32, y: f32, lx: f32, ly: f32) -> (f32, f32) {
    let dot = x * lx + y * ly;
    let rx = 2.0 * dot * lx - x;
    let ry = 2.0 * dot * ly - y;
    (rx, ry)
}

fn fold_point_into_wedge(mut x: f32, mut y: f32, slice_angle: f32) -> (f32, f32) {
    // Reflect across x-axis
    if y < 0.0 {
        y = -y;
    }

    // Reflect across upper wedge boundary if needed
    let bx = slice_angle.cos();
    let by = slice_angle.sin();

    // outward normal for the boundary line
    let nx = -by;
    let ny = bx;

    let side = x * nx + y * ny;
    if side > 0.0 {
        let (rx, ry) = reflect_across_line(x, y, bx, by);
        x = rx;
        y = ry;
    }

    (x, y)
}
