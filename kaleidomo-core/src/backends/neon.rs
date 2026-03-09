use core::arch::aarch64::*;

use image::GenericImageView;

use super::KaleidoBackend;

/// Computes atan using a polynomial approximation, returning a value in radians.
fn atan(x: float32x4_t) -> float32x4_t {
    unsafe {
        let a1 = vdupq_n_f32(0.99997726);
        let a3 = vdupq_n_f32(-0.33262347);
        let a5 = vdupq_n_f32(0.19354346);
        let a7 = vdupq_n_f32(-0.11643287);
        let a9 = vdupq_n_f32(0.05265332);
        let a11 = vdupq_n_f32(-0.01172120);

        let x2 = vmulq_f32(x, x);
        let mut result = a11;
        result = vfmaq_f32(a9, x2, result);
        result = vfmaq_f32(a7, x2, result);
        result = vfmaq_f32(a5, x2, result);
        result = vfmaq_f32(a3, x2, result);
        result = vfmaq_f32(a1, x2, result);
        result = vmulq_f32(result, x);
        result
    }
}

/// Computes sine and cosine using a polynomial approximation, returning values in radians.
unsafe fn sin_cos(angle: float32x4_t) -> (float32x4_t, float32x4_t) {
    unsafe {
        let inv_pi_2 = vdupq_n_f32(0.63661977236); // 2/pi

        // 1. Range Reduction
        // k = round(angle / (pi/2))
        let k = vcvtaq_s32_f32(vmulq_f32(angle, inv_pi_2));
        let k_f = vcvtq_f32_s32(k);

        // x = angle - k * pi/2 (using split constants for higher precision)
        let p1 = vdupq_n_f32(-1.5707963267); 
        let p2 = vdupq_n_f32(-4.37114e-8);
        let mut x = vfmaq_f32(angle, k_f, p1);
        x = vfmaq_f32(x, k_f, p2);

        let x2 = vmulq_f32(x, x);

        // 2. Polynomial for Sine (Range [-pi/4, pi/4])
        let s3 = vdupq_n_f32(-0.1666666666);
        let s5 = vdupq_n_f32(0.0083333333);
        let s7 = vdupq_n_f32(-0.0001984127);
        let mut sn = s7;
        sn = vfmaq_f32(s5, sn, x2);
        sn = vfmaq_f32(s3, sn, x2);
        let sin_poly = vmulq_f32(x, vfmaq_f32(vdupq_n_f32(1.0), sn, x2));

        // 3. Polynomial for Cosine (Range [-pi/4, pi/4])
        let c2 = vdupq_n_f32(-0.5);
        let c4 = vdupq_n_f32(0.0416666666);
        let c6 = vdupq_n_f32(-0.0013888888);
        let mut cn = c6;
        cn = vfmaq_f32(c4, cn, x2);
        cn = vfmaq_f32(c2, cn, x2);
        let cos_poly = vfmaq_f32(vdupq_n_f32(1.0), cn, x2);

        // 4. Quadrant Logic
        // Bit 0 of k: Tells us if we swap sin/cos (odd quadrants)
        // Bit 1 of k: Involved in sign of sin
        // Bit 0+1 of k: Involved in sign of cos
        let k_u = vreinterpretq_u32_s32(k);
        let swap_mask = vtstq_u32(k_u, vdupq_n_u32(1));

        // Initial Selection
        let mut res_sin = vbslq_f32(swap_mask, cos_poly, sin_poly);
        let mut res_cos = vbslq_f32(swap_mask, sin_poly, cos_poly);

        // 5. Sign Management
        // Sin sign: bit 1 of k flips the sign
        let sin_sign = vshlq_n_u32(vandq_u32(k_u, vdupq_n_u32(2)), 30);
        // Cos sign: (k+1) bit 1 flips the sign
        let cos_sign = vshlq_n_u32(vandq_u32(vaddq_u32(k_u, vdupq_n_u32(1)), vdupq_n_u32(2)), 30);

        res_sin = vreinterpretq_f32_u32(veorq_u32(vreinterpretq_u32_f32(res_sin), sin_sign));
        res_cos = vreinterpretq_f32_u32(veorq_u32(vreinterpretq_u32_f32(res_cos), cos_sign));

        (res_sin, res_cos)
    }
}

/// Computes x mod y for float32x4_t vectors, handling negative values correctly.
fn modulo(x: float32x4_t, y: float32x4_t) -> float32x4_t {
    unsafe {
        let div = vdivq_f32(x, y);
        let div_floor = vrndmq_f32(div);
        vfmsq_f32(x, div_floor, y)
    }
}

impl KaleidoBackend for float32x4_t {
    const NUM_FLOATS: usize = 4;

    #[cfg(test)]
    fn load_f32s(input: &[f32]) -> Vec<Self> {
        input.chunks_exact(Self::NUM_FLOATS).map(|chunk| {
            unsafe { vld1q_f32(chunk.as_ptr()) }
        }).collect()
    }

    #[cfg(test)]
    fn store_f32s(&self, output: &mut [f32]) {
        unsafe {
            vst1q_f32(output.as_mut_ptr(), *self);
        }
    }

    fn load_with_single_f32(input: f32) -> Self {
        unsafe {
            vdupq_n_f32(input)
        }
    }

    fn load_coords(x: u32, y: u32) -> (Self, Self) {
        let f = x as f32;
        unsafe {
            let x_vec = vld1q_f32([f, f + 1.0, f + 2.0, f + 3.0].as_ptr());
            let y_vec = vdupq_n_f32(y as f32);
            (x_vec, y_vec)
        }
    }

    fn normalize_coords(&mut self, center: Self) {
        unsafe {
            *self = vsubq_f32(*self, center);
        }
    }

    fn atan2_k(&self, other: Self) -> Self {
        unsafe {
            let pi = vdupq_n_f32(core::f32::consts::PI);
            let pi_2 = vdupq_n_f32(core::f32::consts::FRAC_PI_2);
            let sign_mask = vdupq_n_u32(0x80000000);

            // 1. Range Reduction: Test if |y| > |x|
            let swap_mask = vcagtq_f32(*self, other); 
            
            // Numerator = min(|x|, |y|), Denominator = max(|x|, |y|)
            // We use absolute values to keep the polynomial input in [0, 1]
            let abs_y = vabsq_f32(*self);
            let abs_x = vabsq_f32(other);
            let nom = vbslq_f32(swap_mask, abs_x, abs_y);
            let den = vbslq_f32(swap_mask, abs_y, abs_x);
            
            let atan_input = vdivq_f32(nom, den);

            // 2. Compute polynomial atan(z)
            let mut result = atan(atan_input);
            
            // 3. If we swapped, result = pi/2 - result
            let sub_res = vsubq_f32(pi_2, result);
            result = vbslq_f32(swap_mask, sub_res, result);

            // 4. Handle quadrants (Reflection for negative inputs)
            // If y < 0, result = -result
            let y_sign = vandq_u32(vreinterpretq_u32_f32(*self), sign_mask);
            result = vreinterpretq_f32_u32(veorq_u32(vreinterpretq_u32_f32(result), y_sign));

            // 5. If x < 0, result = result +/- pi (depending on sign of y)
            let x_sign_mask = vcltzq_f32(other); 
            let pi_adj = vreinterpretq_f32_u32(veorq_u32(vreinterpretq_u32_f32(pi), y_sign));
            
            // Final adjustment: if x < 0, add pi_adj, else add 0
            let adjustment = vreinterpretq_f32_u32(vandq_u32(x_sign_mask, vreinterpretq_u32_f32(pi_adj)));
            result = vaddq_f32(result, adjustment);

            result
        }
    }

    fn map_to_polar(dx: Self, dy: Self, zoom: f32) -> (Self, Self) {
        unsafe {
            let r = vsqrtq_f32(vaddq_f32(
                vmulq_f32(dx, dx),
                vmulq_f32(dy, dy)
            ));
            let r_sampled = vdivq_f32(r, vdupq_n_f32(zoom));
            let mut theta = dy.atan2_k(dx);
            let less_than_zero_mask = vcltzq_f32(theta);
            let two_pi = vdupq_n_f32(2.0 * core::f32::consts::PI);
            let theta_adjustment = vandq_u32(vreinterpretq_u32_f32(two_pi), less_than_zero_mask);
            theta = vaddq_f32(theta, vreinterpretq_f32_u32(theta_adjustment));
            (r_sampled, theta)
        }
    }

    fn compute_angle(theta: Self, slice_angle: f32, triangle_rotation_rad: f32) -> Self {
        unsafe {
            let slice_angle_v = vdupq_n_f32(slice_angle);
            let inv_slice_angle = vdupq_n_f32(1.0 / slice_angle);
            
            // 1. Replicate .floor(): Use vrndmq_f32 (Round to Minus Infinity)
            let div = vmulq_f32(theta, inv_slice_angle);
            let slice_idx_f = vrndmq_f32(div); 
            let slice_idx_i = vcvtq_s32_f32(slice_idx_f);

            // 2. Replicate theta % slice_angle:
            // rem = theta - (floor(theta / slice_angle) * slice_angle)
            let rem = vfmsq_f32(theta, slice_idx_f, slice_angle_v);

            // 3. Mirroring Logic
            let is_odd_mask = vtstq_s32(slice_idx_i, vdupq_n_s32(1));
            let if_odd = vsubq_f32(slice_angle_v, rem);
            
            let local_theta = vbslq_f32(is_odd_mask, if_odd, rem);

            vaddq_f32(local_theta, vdupq_n_f32(triangle_rotation_rad))
        }
    }

    fn compute_source_pixel_coords(computed_angle: Self, r_sampled: Self, triangle_center_x: Self, triangle_center_y: Self) -> (Self, Self) {
        unsafe {
            let (sin, cos) = sin_cos(computed_angle);
            let sx = vfmaq_f32(triangle_center_x, r_sampled, cos);
            let sy = vfmaq_f32(triangle_center_y, r_sampled, sin);
            (sx, sy)
        }
    }

    fn store_pixel(output: &mut [u8], _x: u32, sx: Self, sy: Self, source: &image::DynamicImage, sw: u32, sh: u32) {
        unsafe {
            // 1. Check bounds on floats first to match 'sx >= 0.0 && sx < sw'
            let zero = vdupq_n_f32(0.0);
            let sw_v = vdupq_n_f32(sw as f32);
            let sh_v = vdupq_n_f32(sh as f32);

            let v_mask = vandq_u32(
                vandq_u32(vcgeq_f32(sx, zero), vcltq_f32(sx, sw_v)),
                vandq_u32(vcgeq_f32(sy, zero), vcltq_f32(sy, sh_v))
            );

            if vmaxvq_u32(v_mask) == 0 { return; }

            // 2. Use truncation (round toward zero) to match 'as u32'
            let sx_i = vcvtq_u32_f32(sx);
            let sy_i = vcvtq_u32_f32(sy);

            let mut xs = [0u32; 4];
            let mut ys = [0u32; 4];
            let mut m  = [0u32; 4];
            vst1q_u32(xs.as_mut_ptr(), sx_i);
            vst1q_u32(ys.as_mut_ptr(), sy_i);
            vst1q_u32(m.as_mut_ptr(), v_mask);

            for i in 0..4 {
                if m[i] != 0 {
                    let pixel = source.get_pixel(xs[i], ys[i]);
                    let base_idx = i * 4; 
                    output[base_idx..base_idx + 4].copy_from_slice(&pixel.0);
                }
            }
        }
    }

    // fn fold_square(input: Self, count: u32, tile_size: Self) -> Self {
    //     unsafe {
    //         let period = vmulq_f32(tile_size, vdupq_n_f32(2.0));
    //         // Only one modulo is needed because vrndmq (floor) handles negatives
    //         let m = modulo(input, period); 
    //         vabsq_f32(vsubq_f32(m, tile_size))
    //     }
    // }

    fn map_square(dx: Self, dy: Self, center: Self, count: u32, tile_count: Self, zoom: Self, triangle_rotation_rad: f32, triangle_center_x: Self, triangle_center_y: Self) -> (Self, Self) {
        todo!()
    }
    fn map_isoceles(dx: Self, dy: Self, center: Self, count: u32, tile_count: Self, zoom: Self, triangle_rotation_rad: f32, triangle_center_x: Self, triangle_center_y: Self) -> (Self, Self) {
        todo!()
    }
    fn map_hexagonal(dx: Self, dy: Self, center: Self, count: u32, tile_count: Self, zoom: Self, triangle_rotation_rad: f32, triangle_center_x: Self, triangle_center_y: Self) -> (Self, Self) {
        todo!()
    }

    fn fold_angle(theta: Self, count: u32) -> Self {
        todo!()
    }
    fn max_radius_diamond(theta: Self, half: Self) -> Self {
        todo!()
    }
    fn max_radius_hex(theta: Self, radius: Self) -> Self {
        todo!()
    }
    fn max_radius_square(theta: Self, half: Self) -> Self {
        todo!()
    }
    fn normalize_radius_to_shape(r: Self, max_r: Self) -> Self {
        todo!()
    }
    fn polar_from_local(x: Self, y: Self) -> (Self, Self) {
        unsafe {
            let r = vsqrtq_f32(vaddq_f32(
                vmulq_f32(x, x),
                vmulq_f32(y, y)
            ));
            let mut theta = y.atan2_k(x);
            let less_than_zero_mask = vcltzq_f32(theta);
            let two_pi = vdupq_n_f32(2.0 * core::f32::consts::PI);
            let theta_adjustment = vandq_u32(vreinterpretq_u32_f32(two_pi), less_than_zero_mask);
            theta = vaddq_f32(theta, vreinterpretq_f32_u32(theta_adjustment));
            (r, theta)
        }
    }

    fn hex_round(q: Self, r: Self) -> (Self, Self) {
        todo!()
    }
}
