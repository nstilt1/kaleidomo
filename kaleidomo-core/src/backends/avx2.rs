#[cfg(target_arch = "x86")]
pub use core::arch::x86::*;
#[cfg(target_arch = "x86_64")]
pub use core::arch::x86_64::*;

use image::GenericImageView;

use crate::{DynamicImage, KaleidoBackend};

#[target_feature(enable = "avx2")]
#[inline]
unsafe fn atan(x: __m256) -> __m256 {
    unsafe {
        // Coefficients for the polynomial approximation of atan(z) on [0, 1]
        let a1 = _mm256_set1_ps(0.99997726);
        let a3 = _mm256_set1_ps(-0.33262347);
        let a5 = _mm256_set1_ps(0.19354346);
        let a7 = _mm256_set1_ps(-0.11643287);
        let a9 = _mm256_set1_ps(0.05265332);
        let a11 = _mm256_set1_ps(-0.01172120);

        let x2 = _mm256_mul_ps(x, x); // z^2

        // atan(z) ≈ c1*z + c3*z^3 + c5*z^5 + c7*z^7 + c9*z^9
        let mut result = a11;
        result = _mm256_fmadd_ps(x2, result, a9);
        result = _mm256_fmadd_ps(x2, result, a7);
        result = _mm256_fmadd_ps(x2, result, a5);
        result = _mm256_fmadd_ps(x2, result, a3);
        result = _mm256_fmadd_ps(x2, result, a1);
        result = _mm256_mul_ps(result, x);

        result
    }
}

#[target_feature(enable = "avx2")]
#[inline]
unsafe fn sin_cos(angle: __m256) -> (__m256, __m256) {
    unsafe {
        let inv_pi_2 = _mm256_set1_ps(0.63661977236);
        let sign_bit = _mm256_set1_epi32(0x80000000u32 as i32);

        // 1. Range Reduction
        let k = _mm256_cvtps_epi32(_mm256_mul_ps(angle, inv_pi_2));
        let k_f = _mm256_cvtepi32_ps(k);

        let p1 = _mm256_set1_ps(-1.5707963267);
        let p2 = _mm256_set1_ps(-4.37114e-8);
        let mut x = _mm256_fmadd_ps(k_f, p1, angle);
        x = _mm256_fmadd_ps(k_f, p2, x);
        let x2 = _mm256_mul_ps(x, x);

        // 2. Polynomials (Same as your logic, just ensured Sn/Cn order)
        let sin_poly = _mm256_mul_ps(
            x,
            _mm256_fmadd_ps(
                x2,
                _mm256_fmadd_ps(
                    x2,
                    _mm256_set1_ps(-0.0001984127),
                    _mm256_set1_ps(0.0083333333),
                ),
                _mm256_fmadd_ps(x2, _mm256_set1_ps(-0.1666666666), _mm256_set1_ps(1.0)),
            ),
        );
        let cos_poly = _mm256_fmadd_ps(
            x2,
            _mm256_fmadd_ps(
                x2,
                _mm256_fmadd_ps(
                    x2,
                    _mm256_set1_ps(-0.0013888888),
                    _mm256_set1_ps(0.0416666666),
                ),
                _mm256_set1_ps(-0.5),
            ),
            _mm256_set1_ps(1.0),
        );

        // 3. Swap and Sign Logic
        // Bit 0 of k: Swap sin/cos
        let swap_mask = _mm256_castsi256_ps(_mm256_slli_epi32(k, 31)); // Move bit 0 to bit 31

        // Bit 1 of k: Sin sign
        let sin_sign = _mm256_and_si256(_mm256_slli_epi32(k, 30), sign_bit);

        // (k+1) bit 1: Cos sign
        let cos_sign = _mm256_and_si256(
            _mm256_slli_epi32(_mm256_add_epi32(k, _mm256_set1_epi32(1)), 30),
            sign_bit,
        );

        let res_sin = _mm256_blendv_ps(sin_poly, cos_poly, swap_mask);
        let res_cos = _mm256_blendv_ps(cos_poly, sin_poly, swap_mask);

        let final_sin = _mm256_xor_ps(res_sin, _mm256_castsi256_ps(sin_sign));
        let final_cos = _mm256_xor_ps(res_cos, _mm256_castsi256_ps(cos_sign));

        (final_sin, final_cos)
    }
}
#[target_feature(enable = "avx2")]
#[inline]
unsafe fn abs(x: __m256) -> __m256 {
    let mask = _mm256_castsi256_ps(_mm256_set1_epi32(0x7FFFFFFF));
    _mm256_and_ps(x, mask)
}
#[target_feature(enable = "avx2")]
#[inline]
unsafe fn modulo(x: __m256, y: __m256) -> __m256 {
    unsafe {
        let q = _mm256_floor_ps(_mm256_div_ps(x, y));
        _mm256_fnmadd_ps(q, y, x)
    }
}

impl KaleidoBackend for __m256 {
    const NUM_FLOATS: usize = 8;
    #[target_feature(enable = "avx2")]
    #[inline]
    #[cfg(test)]
    unsafe fn load_f32s(input: &[f32]) -> Vec<Self> {
        input
            .chunks_exact(Self::NUM_FLOATS)
            .map(|chunk| unsafe { _mm256_loadu_ps(chunk.as_ptr()) })
            .collect()
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    #[cfg(test)]
    unsafe fn store_f32s(&self, output: &mut [f32]) {
        unsafe {
            _mm256_storeu_ps(output.as_mut_ptr(), *self);
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn load_with_single_f32(value: f32) -> Self {
        _mm256_set1_ps(value)
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn load_coords(x: u32, y: u32) -> (Self, Self) {
        let x = x as f32;
        let y = y as f32;
        (
            _mm256_set_ps(
                x + 7.0,
                x + 6.0,
                x + 5.0,
                x + 4.0,
                x + 3.0,
                x + 2.0,
                x + 1.0,
                x,
            ),
            _mm256_set1_ps(y),
        )
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn normalize_coords(&mut self, center: Self) {
        *self = _mm256_sub_ps(*self, center);
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn atan2_k(&self, other: Self) -> Self {
        unsafe {
            let pi = _mm256_set1_ps(core::f32::consts::PI);
            let pi_2 = _mm256_set1_ps(core::f32::consts::FRAC_PI_2);
            let sign_mask = _mm256_castsi256_ps(_mm256_set1_epi32(0x80000000u32 as i32));
            let abs_mask = _mm256_castsi256_ps(_mm256_set1_epi32(0x7FFFFFFF));

            let swap_mask = _mm256_cmp_ps(
                _mm256_and_ps(*self, abs_mask), // |y|
                _mm256_and_ps(other, abs_mask), // |x|
                _CMP_GT_OS,
            );

            let atan_input = _mm256_div_ps(
                _mm256_blendv_ps(*self, other, swap_mask), // pick the lowest between |y| and |x| for each number
                _mm256_blendv_ps(other, *self, swap_mask), // and the highest.
            );

            let mut result = atan(atan_input);

            result = _mm256_blendv_ps(
                result,
                _mm256_sub_ps(
                    _mm256_or_ps(pi_2, _mm256_and_ps(atan_input, sign_mask)),
                    result,
                ),
                swap_mask,
            );

            let x_sign_mask =
                _mm256_castsi256_ps(_mm256_srai_epi32(_mm256_castps_si256(other), 31));

            result = _mm256_add_ps(
                _mm256_and_ps(
                    _mm256_xor_ps(pi, _mm256_and_ps(sign_mask, *self)),
                    x_sign_mask,
                ),
                result,
            );

            result
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn map_to_polar(dx: Self, dy: Self, zoom: f32) -> (Self, Self) {
        unsafe {
            let r = _mm256_sqrt_ps(_mm256_add_ps(_mm256_mul_ps(dx, dx), _mm256_mul_ps(dy, dy)));
            let r_sampled = _mm256_div_ps(r, _mm256_set1_ps(zoom));
            let mut theta = dy.atan2_k(dx);
            let less_than_zero_mask = _mm256_cmp_ps(theta, _mm256_set1_ps(0.0), _CMP_LT_OS);
            theta = _mm256_blendv_ps(
                theta,
                _mm256_add_ps(theta, _mm256_set1_ps(2.0 * core::f32::consts::PI)),
                less_than_zero_mask,
            );
            (r_sampled, theta)
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn compute_angle(theta: Self, slice_angle_vec: Self, triangle_rotation_rad: f32) -> Self {
        unsafe {
            let inv_slice_angle = _mm256_div_ps(_mm256_set1_ps(1.0), slice_angle_vec);

            // 1. floor(theta / slice_angle)
            let floor = _mm256_floor_ps(_mm256_mul_ps(theta, inv_slice_angle));

            // 2. rem = theta - (floor * slice_angle)
            // Using fnmadd: -(floor * slice_angle) + theta
            let rem = _mm256_fnmadd_ps(floor, slice_angle_vec, theta);

            // 3. Determine if odd: bit 0 of the floor integer
            // Use cvttps (truncate) to be safe with floor values
            let floor_int = _mm256_cvttps_epi32(floor);
            let odd_mask = _mm256_castsi256_ps(_mm256_slli_epi32(floor_int, 31));

            // 4. If odd: slice_angle - rem, else: rem
            let mirrored_rem = _mm256_sub_ps(slice_angle_vec, rem);
            let local_theta = _mm256_blendv_ps(rem, mirrored_rem, odd_mask);

            // 5. Add triangle rotation
            _mm256_add_ps(local_theta, _mm256_set1_ps(triangle_rotation_rad))
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn compute_source_pixel_coords(
        computed_angle: Self,
        r_sampled: Self,
        triangle_center_x: Self,
        triangle_center_y: Self,
    ) -> (Self, Self) {
        unsafe {
            let (sin, cos) = sin_cos(computed_angle);
            let sx = _mm256_fmadd_ps(r_sampled, cos, triangle_center_x);
            let sy = _mm256_fmadd_ps(r_sampled, sin, triangle_center_y);
            (sx, sy)
        }
    }
    #[target_feature(enable = "avx2")]
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
        unsafe {
            let zero = _mm256_set1_ps(0.0);
            let sw_v = _mm256_set1_ps(sw as f32);
            let sh_v = _mm256_set1_ps(sh as f32);
            let v_mask = _mm256_and_ps(
                _mm256_and_ps(
                    _mm256_cmp_ps::<_CMP_GE_OS>(sx, zero),
                    _mm256_cmp_ps::<_CMP_LT_OS>(sx, sw_v),
                ),
                _mm256_and_ps(
                    _mm256_cmp_ps::<_CMP_GE_OS>(sy, zero),
                    _mm256_cmp_ps::<_CMP_LT_OS>(sy, sh_v),
                ),
            );

            let sx_i = _mm256_cvtps_epi32(sx);
            let sy_i = _mm256_cvtps_epi32(sy);
            let mut xs = [0u32; Self::NUM_FLOATS];
            let mut ys = [0u32; Self::NUM_FLOATS];
            let mut m = [0u32; Self::NUM_FLOATS];
            _mm256_storeu_si256(xs.as_mut_ptr() as *mut __m256i, sx_i);
            _mm256_storeu_si256(ys.as_mut_ptr() as *mut __m256i, sy_i);
            _mm256_storeu_si256(m.as_mut_ptr() as *mut __m256i, _mm256_castps_si256(v_mask));

            for i in 0..Self::NUM_FLOATS {
                if m[i] != 0 {
                    let offset = i as u32 * 4;
                    let pixel = source.get_pixel(xs[i], ys[i]);
                    output[offset as usize..(offset + 4) as usize].copy_from_slice(&pixel.0)
                }
            }
        }
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    unsafe fn store_pixel_rgba8(
        output: &mut [u8],
        sx: __m256,
        sy: __m256,
        source: &[u8],
        sw: u32,
        sh: u32,
    ) {
        unsafe {
            let zero = _mm256_set1_ps(0.0);
            let sw_v = _mm256_set1_ps(sw as f32);
            let sh_v = _mm256_set1_ps(sh as f32);

            let v_mask = _mm256_and_ps(
                _mm256_and_ps(
                    _mm256_cmp_ps::<_CMP_GE_OS>(sx, zero),
                    _mm256_cmp_ps::<_CMP_LT_OS>(sx, sw_v),
                ),
                _mm256_and_ps(
                    _mm256_cmp_ps::<_CMP_GE_OS>(sy, zero),
                    _mm256_cmp_ps::<_CMP_LT_OS>(sy, sh_v),
                ),
            );

            let sx_i = _mm256_cvtps_epi32(sx);
            let sy_i = _mm256_cvtps_epi32(sy);

            let mut xs = [0i32; 8];
            let mut ys = [0i32; 8];
            let mut m = [0i32; 8];

            _mm256_storeu_si256(xs.as_mut_ptr() as *mut __m256i, sx_i);
            _mm256_storeu_si256(ys.as_mut_ptr() as *mut __m256i, sy_i);
            _mm256_storeu_si256(m.as_mut_ptr() as *mut __m256i, _mm256_castps_si256(v_mask));

            for i in 0..8 {
                if m[i] != 0 {
                    let x = xs[i] as usize;
                    let y = ys[i] as usize;
                    let src_idx = (y * sw as usize + x) * 4;
                    let dst_idx = i * 4;

                    output[dst_idx..dst_idx + 4].copy_from_slice(&source[src_idx..src_idx + 4]);
                }
            }
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn map_square(
            dx: Self,
            dy: Self,
            center: Self,
            slice_angle: Self,
            two_pi: Self,
            tile_count: Self,
            zoom: Self,
            rotation: Self,
            tx: Self,
            ty: Self,
        ) -> (Self, Self) {
        unsafe {
            let two = Self::load_with_single_f32(2.0);
            let half = Self::load_with_single_f32(0.5);
            
            let screen_size = _mm256_mul_ps(center, two);
            let tile_size = _mm256_div_ps(screen_size, tile_count);
            let half = _mm256_mul_ps(tile_size, half);

            let local_x = _mm256_sub_ps(
                modulo(
                    _mm256_add_ps(dx, half),
                    tile_size
                ),
                half
            );
            let local_y = _mm256_sub_ps(
                modulo(
                    _mm256_add_ps(dy, half),
                    tile_size
                ),
                half
            );
            Self::source_space_rotation(local_x, local_y, rotation, tx, ty, half, two_pi, slice_angle, center, zoom)
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn map_diamond(
            dx: Self,
            dy: Self,
            center: Self,
            slice_angle: Self,
            two_pi: Self,
            tile_count: Self,
            zoom: Self,
            rotation: Self,
            tx: Self,
            ty: Self,
        ) -> (Self, Self) {
        unsafe {
            let two = Self::load_with_single_f32(2.0);
            let half = Self::load_with_single_f32(0.5);

            let screen_size = _mm256_mul_ps(center, two);
            let tile = _mm256_div_ps(screen_size, tile_count);
            let half = _mm256_mul_ps(tile, half);

            let inv_sqrt2 = Self::load_with_single_f32(0.70710678118_f32);
            let u = _mm256_mul_ps(_mm256_add_ps(dx, dy), inv_sqrt2);
            let v = _mm256_mul_ps(_mm256_sub_ps(dy, dx), inv_sqrt2);

            let local_u = _mm256_sub_ps(
                modulo(
                    _mm256_add_ps(u, half), 
                    tile
                ), 
                half
            );
            let local_v = _mm256_sub_ps(
                modulo(
                    _mm256_add_ps(v, half),
                    tile
                ),
                half
            );

            Self::source_space_rotation(local_u, local_v, rotation, tx, ty, half, two_pi, slice_angle, center, zoom)
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn map_hexagonal(
            dx: Self,
            dy: Self,
            center: Self,
            slice_angle: Self,
            two_pi: Self,
            tile_count: Self,
            zoom: Self,
            rotation: Self,
            tx: Self,
            ty: Self,
            sqrt3: Self,
        ) -> (Self, Self) {
        unsafe {
            let two = Self::load_with_single_f32(2.0);
            let one_over_three = Self::load_with_single_f32(1.0 / 3.0);
            let half = Self::load_with_single_f32(0.5);
            let one_point_five = Self::load_with_single_f32(1.5);

            let screen_size = _mm256_mul_ps(center, two);
            let hex_radius = _mm256_div_ps(screen_size, _mm256_mul_ps(sqrt3, tile_count));

            let q = _mm256_div_ps(
                _mm256_sub_ps(
                    _mm256_mul_ps(_mm256_mul_ps(sqrt3, one_over_three), dx),
                    _mm256_mul_ps(one_over_three, dy)
                ),
                hex_radius
            );

            let r = _mm256_div_ps(
                _mm256_mul_ps(
                    _mm256_mul_ps(one_over_three, two),
                    dy
                ),
                hex_radius
            );

            let (rq, rr) = Self::hex_round(q, r);

            let hex_cx = _mm256_mul_ps(
                hex_radius,
                _mm256_mul_ps(
                    sqrt3,
                    _mm256_fmadd_ps(rr, half, rq)
                )
            );
            let hex_cy = _mm256_mul_ps(
                hex_radius,
                _mm256_mul_ps(rr, one_point_five)
            );
            
            let local_x = _mm256_sub_ps(dx, hex_cx);
            let local_y = _mm256_sub_ps(dy, hex_cy);

            Self::source_space_rotation(local_x, local_y, rotation, tx, ty, hex_radius, two_pi, slice_angle, center, zoom)
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn map_hexagonal_flat_top(
            dx: Self,
            dy: Self,
            center: Self,
            slice_angle: Self,
            two_pi: Self,
            tile_count: Self,
            zoom: Self,
            rotation: Self,
            tx: Self,
            ty: Self,
            sqrt3: Self,
        ) -> (Self, Self) {
        unsafe {
            let two = Self::load_with_single_f32(2.0);
            let one_over_three = Self::load_with_single_f32(1.0 / 3.0);
            let half = Self::load_with_single_f32(0.5);
            let one_point_five = Self::load_with_single_f32(1.5);

            let screen_size = _mm256_mul_ps(center, two);
            let hex_radius = _mm256_div_ps(screen_size, _mm256_mul_ps(one_point_five, tile_count));

            let q = _mm256_div_ps(
                _mm256_mul_ps(
                    _mm256_mul_ps(one_over_three, two),
                    dx
                ),
                hex_radius
            );
            let r = _mm256_div_ps(
                _mm256_sub_ps(
                    _mm256_mul_ps(_mm256_mul_ps(sqrt3, one_over_three), dy),
                    _mm256_mul_ps(one_over_three, dx)
                ),
                hex_radius
            );

            let (rq, rr) = Self::hex_round(q, r);

            let hex_cx = _mm256_mul_ps(
                hex_radius,
                _mm256_mul_ps(
                    rq,
                    one_point_five
                )
            );
            let hex_cy = _mm256_mul_ps(
                hex_radius,
                _mm256_mul_ps(
                    sqrt3,
                    _mm256_fmadd_ps(rq, half, rr)
                )
            );
            
            let local_x = _mm256_sub_ps(dx, hex_cx);
            let local_y = _mm256_sub_ps(dy, hex_cy);


            Self::source_space_rotation(local_x, local_y, rotation, tx, ty, hex_radius, two_pi, slice_angle, center, zoom)
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn hex_round(q: Self, r: Self) -> (Self, Self) {
        unsafe {
            let s = _mm256_mul_ps(_mm256_add_ps(q, r), _mm256_set1_ps(-1.0));
            let mut rq = _mm256_round_ps(q, _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC);
            let mut rr = _mm256_round_ps(r, _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC);
            let rs = _mm256_round_ps(s, _MM_FROUND_TO_NEAREST_INT | _MM_FROUND_NO_EXC);

            let q_diff = abs(_mm256_sub_ps(rq, q));
            let r_diff = abs(_mm256_sub_ps(rr, r));
            let s_diff = abs(_mm256_sub_ps(rs, s));

            let rq_mask = _mm256_and_ps(
                _mm256_cmp_ps(q_diff, r_diff, _CMP_GT_OS),
                _mm256_cmp_ps(q_diff, s_diff, _CMP_GT_OS),
            );

            let rr_candidate_mask = _mm256_cmp_ps(r_diff, s_diff, _CMP_GT_OS);
            let rr_mask = _mm256_andnot_ps(rq_mask, rr_candidate_mask);

            let neg_one = _mm256_set1_ps(-1.0);
            rq = _mm256_blendv_ps(rq, _mm256_mul_ps(neg_one, _mm256_add_ps(rr, rs)), rq_mask);
            rr = _mm256_blendv_ps(rr, _mm256_mul_ps(neg_one, _mm256_add_ps(rq, rs)), rr_mask);
            (rq, rr)
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn fold_point_into_wedge_fixed(
            x: Self,
            y: Self,
            slice_angle: Self,
            two_pi: Self,
        ) -> (Self, Self) {
        unsafe {
            let mut theta = y.atan2_k(x);
            let less_than_zero_mask = _mm256_cmp_ps(theta, _mm256_set1_ps(0.0), _CMP_LT_OS);
            theta = _mm256_blendv_ps(
                theta,
                _mm256_add_ps(theta, two_pi),
                less_than_zero_mask,
            );

            let sector = _mm256_floor_ps(_mm256_div_ps(theta, slice_angle));
            let sector_angle = _mm256_mul_ps(sector, slice_angle);

            let (sin_s, cos_s) = sin_cos(sector_angle);
            let xr = _mm256_fmadd_ps(y, sin_s, _mm256_mul_ps(x, cos_s));
            let yr = _mm256_fmsub_ps(y, cos_s, _mm256_mul_ps(x, sin_s));

            let sector_i = _mm256_cvtps_epi32(sector);
            let one = _mm256_set1_epi32(1);
            let odd_mask = _mm256_cmpeq_epi32(
                _mm256_and_si256(sector_i, one),
                 one
            );

            let half = Self::load_with_single_f32(0.5);
            let (ly, lx) = sin_cos(_mm256_mul_ps(half, slice_angle));
            let (rx, ry) = Self::reflect_across_line(xr, yr, lx, ly);

            let final_x = _mm256_blendv_ps(xr, rx, _mm256_castsi256_ps(odd_mask));
            let final_y = _mm256_blendv_ps(yr, ry, _mm256_castsi256_ps(odd_mask));
            (final_x, final_y)
        }
    }
    #[target_feature(enable = "avx2")]
    #[inline]
    unsafe fn reflect_across_line(x: Self, y: Self, lx: Self, ly: Self) -> (Self, Self) {
        unsafe {
            let dot = _mm256_fmadd_ps(y, ly, _mm256_mul_ps(x, lx));
            let two_dot = _mm256_mul_ps(_mm256_set1_ps(2.0), dot);
            let rx = _mm256_fmsub_ps(two_dot, lx, x);
            let ry = _mm256_fmsub_ps(two_dot, ly, y);
            (rx, ry)
        }
    }

    #[inline]
    #[target_feature(enable = "avx2")]
    unsafe fn source_space_rotation(
            local_x: Self,
            local_y: Self,
            triangle_rotation_rad: Self,
            triangle_center_x: Self,
            triangle_center_y: Self,
            radius: Self,
            two_pi: Self,
            slice_angle: Self,
            center: Self,
            zoom: Self,
        ) -> (Self, Self) {
        unsafe {
            let x = _mm256_div_ps(local_x, radius);
            let y = _mm256_div_ps(local_y, radius);

            let (fx, fy) = Self::fold_point_into_wedge_fixed(x, y, slice_angle, two_pi);

            let source_scale = _mm256_div_ps(center, zoom);

            let sx_local = _mm256_mul_ps(fx, source_scale);
            let sy_local = _mm256_mul_ps(fy, source_scale);

            let (sin_r, cos_r) = sin_cos(triangle_rotation_rad);

            let rx = _mm256_fmsub_ps(
                sx_local,
                cos_r,
                _mm256_mul_ps(sy_local, sin_r)
            );
            let ry = _mm256_fmadd_ps(
                sx_local,
                sin_r,
                _mm256_mul_ps(sy_local, cos_r)
            );

            (
                _mm256_add_ps(rx, triangle_center_x),
                _mm256_add_ps(ry, triangle_center_y)
            )
        }
    }
}
