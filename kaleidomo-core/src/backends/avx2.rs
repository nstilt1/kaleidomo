#[cfg(target_arch = "x86")]
pub use core::arch::x86::*;
#[cfg(target_arch = "x86_64")]
pub use core::arch::x86_64::*;

use image::GenericImageView;

use crate::{DynamicImage, KaleidoBackend};

fn atan(x: __m256) -> __m256 {
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

impl KaleidoBackend for __m256 {
    const NUM_FLOATS: usize = 8;

    #[cfg(test)]
    fn load_f32s(input: &[f32]) -> Vec<Self> {
        input
            .chunks_exact(Self::NUM_FLOATS)
            .map(|chunk| unsafe { _mm256_loadu_ps(chunk.as_ptr()) })
            .collect()
    }

    #[cfg(test)]
    fn store_f32s(&self, output: &mut [f32]) {
        unsafe {
            _mm256_storeu_ps(output.as_mut_ptr(), *self);
        }
    }

    fn load_with_single_f32(value: f32) -> Self {
        unsafe { _mm256_set1_ps(value) }
    }

    fn load_coords(x: u32, y: u32) -> (Self, Self) {
        let x = x as f32;
        let y = y as f32;
        unsafe {
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
    }

    fn normalize_coords(&mut self, center: Self) {
        *self = unsafe { _mm256_sub_ps(*self, center) };
    }

    fn atan2_k(&self, other: Self) -> Self {
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

    fn map_to_polar(dx: Self, dy: Self, zoom: f32) -> (Self, Self) {
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

    fn compute_angle(theta: Self, slice_angle: f32, triangle_rotation_rad: f32) -> Self {
        unsafe {
            let slice_angle_vec = _mm256_set1_ps(slice_angle);
            let inv_slice_angle = _mm256_set1_ps(1.0 / slice_angle);

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

    fn compute_source_pixel_coords(
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

    fn store_pixel(
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
}
