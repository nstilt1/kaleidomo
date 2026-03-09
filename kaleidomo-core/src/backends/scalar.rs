use image::{DynamicImage, GenericImageView};

use super::KaleidoBackend;

impl KaleidoBackend for f32 {
    const NUM_FLOATS: usize = 1;

    #[cfg(test)]
    #[inline]
    unsafe fn load_f32s(input: &[f32]) -> Vec<Self> {
        input.to_vec()
    }

    #[cfg(test)]
    #[inline]
    unsafe fn store_f32s(&self, output: &mut [f32]) {
        output[0] = *self;
    }

    #[inline]
    unsafe fn load_with_single_f32(input: f32) -> Self {
        input
    }

    #[inline]
    unsafe fn load_coords(x: u32, y: u32) -> (Self, Self) {
        (x as f32, y as f32)
    }

    #[inline]
    unsafe fn normalize_coords(&mut self, center: Self) {
        *self -= center;
    }

    #[inline]
    unsafe fn atan2_k(&self, other: Self) -> Self {
        self.atan2(other)
    }

    #[inline]
    unsafe fn map_to_polar(dx: Self, dy: Self, zoom: f32) -> (Self, Self) {
        let r = (dx * dx + dy * dy).sqrt();
        let r_sampled = r / zoom;
        let mut theta = dy.atan2(dx);
        if theta < 0.0 {
            theta += 2.0 * core::f32::consts::PI;
        }
        (r_sampled, theta)
    }

    #[inline]
    unsafe fn compute_angle(theta: Self, slice_angle: f32, triangle_rotation_rad: f32) -> Self {
        let slice_idx = (theta / slice_angle).floor();
        let local_theta = if slice_idx as i32 % 2 != 0 {
            slice_angle - (theta % slice_angle)
        } else {
            theta % slice_angle
        };
        local_theta + triangle_rotation_rad
    }

    #[inline]
    unsafe fn compute_source_pixel_coords(
        computed_angle: Self,
        r_sampled: Self,
        triangle_center_x: f32,
        triangle_center_y: f32,
    ) -> (Self, Self) {
        let sx = computed_angle.cos() * r_sampled + triangle_center_x;
        let sy = computed_angle.sin() * r_sampled + triangle_center_y;
        (sx, sy)
    }

    #[inline]
    unsafe fn store_pixel(
        output: &mut [u8],
        _x: u32,
        sx: Self,
        sy: Self,
        source: &DynamicImage,
        sw: u32,
        sh: u32,
    ) {
        let sx_i = sx.round() as u32;
        let sy_i = sy.round() as u32;
        if sx_i < sw && sy_i < sh {
            let pixel = source.get_pixel(sx_i, sy_i);
            output[0..4].copy_from_slice(&pixel.0);
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

    #[inline]
    unsafe fn map_square(
        dx: Self,
        dy: Self,
        center: Self,
        slice_angle: Self,
        two_pi: Self,
        tile_count: Self,
        zoom: Self,
        triangle_rotation_rad: f32,
        triangle_center_x: Self,
        triangle_center_y: Self,
    ) -> (Self, Self) {
        let screen_size = center * 2.0;
        let tile_size = screen_size / tile_count.max(0.0001);
        let half = tile_size * 0.5;

        // Wrap into one square tile centered at the origin.
        let local_x = (dx + half).rem_euclid(tile_size) - half;
        let local_y = (dy + half).rem_euclid(tile_size) - half;

        // Normalize into a canonical square domain.
        let x = local_x / half;
        let y = local_y / half;

        // Fold into the canonical mirrored wedge using fixed-cost Cartesian ops.
        let (fx, fy) = unsafe { Self::fold_point_into_wedge_fixed(x, y, slice_angle, two_pi) };

        // Source scale depends only on zoom, not tile_count.
        let source_scale = center / zoom.max(0.0001);

        let sx_local = fx * source_scale;
        let sy_local = fy * source_scale;

        // Apply source-space rotation.
        let sin_r = triangle_rotation_rad.sin();
        let cos_r = triangle_rotation_rad.cos();

        let rx = sx_local * cos_r - sy_local * sin_r;
        let ry = sx_local * sin_r + sy_local * cos_r;

        (triangle_center_x + rx, triangle_center_y + ry)
    }

    #[inline]
    unsafe fn map_diamond(
        dx: Self,
        dy: Self,
        center: Self,
        slice_angle: Self,
        two_pi: Self,
        tile_count: Self,
        zoom: Self,
        rotation: f32,
        tx: Self,
        ty: Self,
    ) -> (Self, Self) {
        let screen_size = center * 2.0;
        let tile = screen_size / tile_count.max(0.0001);
        let half = tile * 0.5;

        // Rotate output coordinates by 45° so rectangular wrapping becomes
        // a diamond lattice in screen space.
        let inv_sqrt2 = 0.70710678118_f32;
        let u = (dx + dy) * inv_sqrt2;
        let v = (dy - dx) * inv_sqrt2;

        // Wrap into one diamond cell centered at the origin.
        let local_u = (u + half).rem_euclid(tile) - half;
        let local_v = (v + half).rem_euclid(tile) - half;

        // Normalize to a canonical local domain independent of tile_count.
        let x = local_u / half;
        let y = local_v / half;

        // Fold into the canonical mirrored wedge.
        let (fx, fy) = unsafe { Self::fold_point_into_wedge_fixed(x, y, slice_angle, two_pi) };

        // Source sampling scale depends only on zoom.
        let source_scale = center / zoom.max(0.0001);

        let sx_local = fx * source_scale;
        let sy_local = fy * source_scale;

        let sin_r = rotation.sin();
        let cos_r = rotation.cos();

        let rx = sx_local * cos_r - sy_local * sin_r;
        let ry = sx_local * sin_r + sy_local * cos_r;

        (tx + rx, ty + ry)
    }

    #[inline]
    unsafe fn map_hexagonal(
        dx: Self,
        dy: Self,
        center: Self,
        slice_angle: Self,
        two_pi: Self,
        tile_count: Self,
        zoom: Self,
        triangle_rotation_rad: f32,
        triangle_center_x: Self,
        triangle_center_y: Self,
        sqrt3: Self,
    ) -> (Self, Self) {
        let screen_size = center * 2.0;

        // Pointy-top hex radius. This gives roughly tile_count hexes across.
        let hex_radius = screen_size / (tile_count.max(0.0001) * sqrt3);

        // Convert pixel-space point to axial hex coordinates.
        let q = (sqrt3 / 3.0 * dx - 1.0 / 3.0 * dy) / hex_radius;
        let r = (2.0 / 3.0 * dy) / hex_radius;

        let (rq, rr) = unsafe { Self::hex_round(q, r) };

        // Convert the chosen hex center back to pixel space.
        let hex_cx = hex_radius * sqrt3 * (rq + rr * 0.5);
        let hex_cy = hex_radius * 1.5 * rr;

        // Local point relative to the hex center.
        let local_x = dx - hex_cx;
        let local_y = dy - hex_cy;

        // Normalize local point so tile_count only changes on-screen tile size.
        let x = local_x / hex_radius;
        let y = local_y / hex_radius;

        // Fold into the canonical mirrored wedge.
        let (fx, fy) = unsafe { Self::fold_point_into_wedge_fixed(x, y, slice_angle, two_pi) };

        // Source sampling scale depends only on zoom.
        let source_scale = center / zoom.max(0.0001);

        let sx_local = fx * source_scale;
        let sy_local = fy * source_scale;

        let sin_r = triangle_rotation_rad.sin();
        let cos_r = triangle_rotation_rad.cos();

        let rx = sx_local * cos_r - sy_local * sin_r;
        let ry = sx_local * sin_r + sy_local * cos_r;

        (triangle_center_x + rx, triangle_center_y + ry)
    }

    #[inline]
    unsafe fn map_hexagonal_flat_top(
        dx: Self,
        dy: Self,
        center: Self,
        slice_angle: Self,
        two_pi: Self,
        tile_count: Self,
        zoom: Self,
        triangle_rotation_rad: f32,
        triangle_center_x: Self,
        triangle_center_y: Self,
        sqrt3: Self,
    ) -> (Self, Self) {
        let screen_size = center * 2.0;

        // Flat-top hex radius / side length.
        // This is still a reasonable "roughly tile_count across" control.
        let hex_radius = screen_size / (tile_count.max(0.0001) * 1.5);

        // Convert pixel-space point to axial hex coordinates for FLAT-TOP hexes.
        let q = (2.0 / 3.0 * dx) / hex_radius;
        let r = (-1.0 / 3.0 * dx + sqrt3 / 3.0 * dy) / hex_radius;

        let (rq, rr) = unsafe { Self::hex_round(q, r) };

        // Convert the chosen hex center back to pixel space for FLAT-TOP hexes.
        let hex_cx = hex_radius * 1.5 * rq;
        let hex_cy = hex_radius * sqrt3 * (rr + rq * 0.5);

        // Local point relative to the hex center.
        let local_x = dx - hex_cx;
        let local_y = dy - hex_cy;

        // Normalize local point so tile_count only changes on-screen tile size.
        let x = local_x / hex_radius;
        let y = local_y / hex_radius;

        // Fold into the canonical mirrored wedge.
        let (fx, fy) = unsafe { Self::fold_point_into_wedge_fixed(x, y, slice_angle, two_pi) };

        // Source sampling scale depends only on zoom.
        let source_scale = center / zoom.max(0.0001);

        let sx_local = fx * source_scale;
        let sy_local = fy * source_scale;

        let sin_r = triangle_rotation_rad.sin();
        let cos_r = triangle_rotation_rad.cos();

        let rx = sx_local * cos_r - sy_local * sin_r;
        let ry = sx_local * sin_r + sy_local * cos_r;

        (triangle_center_x + rx, triangle_center_y + ry)
    }

    #[inline]
    unsafe fn hex_round(q: Self, r: Self) -> (Self, Self) {
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

    #[inline]
    unsafe fn fold_point_into_wedge_fixed(x: f32, y: f32, slice_angle: Self, two_pi: Self) -> (f32, f32) {
        let mut theta = y.atan2(x);
        if theta < 0.0 {
            theta += two_pi;
        }

        let sector = (theta / slice_angle).floor() as i32;
        let sector_angle = sector as f32 * slice_angle;

        // Rotate into the base sector [0, slice_angle)
        let sin_s = sector_angle.sin();
        let cos_s = sector_angle.cos();

        let xr = x * cos_s + y * sin_s;
        let yr = -x * sin_s + y * cos_s;

        // Odd sectors are mirrored versions of even sectors.
        if sector & 1 != 0 {
            let mid_angle = slice_angle * 0.5;
            let lx = mid_angle.cos();
            let ly = mid_angle.sin();
            unsafe { Self::reflect_across_line(xr, yr, lx, ly) }
        } else {
            (xr, yr)
        }
    }

    #[inline]
    unsafe fn reflect_across_line(x: f32, y: f32, lx: f32, ly: f32) -> (f32, f32) {
        let dot = x * lx + y * ly;
        let rx = 2.0 * dot * lx - x;
        let ry = 2.0 * dot * ly - y;
        (rx, ry)
    }
}
