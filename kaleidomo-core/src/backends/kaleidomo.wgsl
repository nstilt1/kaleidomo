// kalidomo.wgsl

struct KaleidoSettings {
    count: u32,
    output_size_w: u32,
    output_size_h: u32,
    kaleido_type: u32,

    offset_x: i32,
    offset_y: i32,
    hue_rotation: u32,
    _pad0: u32,

    zoom: f32,
    inv_zoom: f32,
    tile_count: f32,
    slice_angle: f32,

    center_x: f32,
    center_y: f32,
    triangle_center_x: f32,
    triangle_center_y: f32,

    triangle_rotation_rad: f32,
    source_width: u32,
    source_height: u32,
    _pad1: u32,
};

@group(0) @binding(0)
var input_tex: texture_2d<f32>;

@group(0) @binding(1)
var output_tex: texture_storage_2d<rgba8unorm, write>;

@group(0) @binding(2)
var<uniform> settings: KaleidoSettings;

const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 2.0 * PI;

fn euclidean_modulo(a : f32, b : f32) -> f32 {
    let result = a % b;
    if result < 0 {
        // Return the positive remainder if the initial result was negative
        return result + b;
    }
    return result;
}

fn map_to_polar(dx: f32, dy: f32, zoom: f32) -> vec2<f32> {
    let r = sqrt(dx * dx + dy * dy);
    let r_sampled = r / zoom;

    var theta = atan2(dy, dx);
    if (theta < 0.0) {
        theta = theta + TWO_PI;
    }

    return vec2<f32>(r_sampled, theta);
}

fn compute_angle(theta: f32, slice_angle: f32, triangle_rotation_rad: f32) -> f32 {
    let slice_idx = i32(floor(theta / slice_angle));
    let theta_in_slice = theta % slice_angle;

    var local_theta = theta_in_slice;
    if ((slice_idx % 2) != 0) {
        local_theta = slice_angle - theta_in_slice;
    }

    return local_theta + triangle_rotation_rad;
}

fn compute_source_pixel_coords(
    computed_angle: f32,
    r_sampled: f32,
    triangle_center_x: f32,
    triangle_center_y: f32,
) -> vec2<f32> {
    let sx = cos(computed_angle) * r_sampled + triangle_center_x;
    let sy = sin(computed_angle) * r_sampled + triangle_center_y;
    return vec2<f32>(sx, sy);
}

fn map_radial(
    dx: f32, 
    dy: f32, 
    zoom: f32, 
    slice_angle: f32,
    triangle_rotation_rad: f32,
) -> vec2<f32> {
    let polar = map_to_polar(dx, dy, zoom);
    let r_sampled = polar.x;
    let theta = polar.y;
    let computed_angle = compute_angle(theta, slice_angle, triangle_rotation_rad);
    return compute_source_pixel_coords(
        computed_angle,
        r_sampled,
        settings.triangle_center_x,
        settings.triangle_center_y,
    );
}

fn reflect_across_line(x: f32, y: f32, lx: f32, ly: f32) -> vec2<f32> {
    let dot = 2.0 * (x * lx + y * ly);
    let rx = dot * lx - x;
    let ry = dot * ly - y;
    return vec2<f32>(rx, ry);
}

fn fold_point_into_wedge_fixed(x: f32, y: f32, slice_angle: f32) -> vec2<f32> {
    var theta = atan2(y, x);
    if theta < 0.0 {
        theta += PI * 2.0;
    }

    let sector = i32(floor(theta / slice_angle));
    let sector_angle = f32(sector) * slice_angle;

    let sin_s = sin(sector_angle);
    let cos_s = cos(sector_angle);

    let xr = x * cos_s + y * sin_s;
    let yr = -x * sin_s + y * cos_s;

    if sector % 2 != 0 {
        let mid_angle = slice_angle * 0.5;
        let lx = cos(mid_angle);
        let ly = sin(mid_angle);
        return reflect_across_line(xr, yr, lx, ly);
    }
    return vec2<f32>(xr, yr);
}

fn source_space_rotation(
    lx: f32, 
    ly: f32, 
    rotation: f32, 
    tx: f32, 
    ty: f32, 
    radius: f32, 
    slice_angle: f32, 
    width_over_2: f32, 
    zoom: f32
) -> vec2<f32> {
    let x = lx / radius;
    let y = ly / radius;

    let coords = fold_point_into_wedge_fixed(x, y, slice_angle);

    let source_scale = width_over_2 / zoom;

    let sx_local = coords.x * source_scale;
    let sy_local = coords.y * source_scale;

    let sin_r = sin(rotation);
    let cos_r = cos(rotation);

    let rx = sx_local * cos_r - sy_local * sin_r;
    let ry = sx_local * sin_r + sy_local * cos_r;

    return vec2<f32>(tx + rx, ty + ry);
}

fn map_square(
    dx: f32,
    dy: f32,
    width_over_2: f32,
    slice_angle: f32,
    tile_count: f32,
    zoom: f32,
    rotation: f32,
    tx: f32,
    ty: f32,
) -> vec2<f32> {
    let screen_size = width_over_2 * 2.0;
    let tile_size = screen_size / tile_count;
    let half = tile_size * 0.5;

    let local_x = euclidean_modulo(dx + half, tile_size) - half;
    let local_y = euclidean_modulo(dy + half, tile_size) - half;

    return source_space_rotation(local_x, local_y, rotation, tx, ty, half, slice_angle, width_over_2, zoom); 
}

fn map_diamond(
    dx: f32,
    dy: f32,
    width_over_2: f32,
    slice_angle: f32,
    tile_count: f32,
    zoom: f32,
    rotation: f32,
    tx: f32,
    ty: f32,
) -> vec2<f32> {
    let screen_size = width_over_2 * 2.0;
    let tile = screen_size / tile_count;
    let half = tile * 0.5;

    let inv_sqrt2 = 0.70710678118;
    let u = (dx + dy) * inv_sqrt2;
    let v = (dy - dx) * inv_sqrt2;

    let local_u = euclidean_modulo(u + half, tile) - half;
    let local_v = euclidean_modulo(v + half, tile) - half;

    return source_space_rotation(local_u, local_v, rotation, tx, ty, half, slice_angle, width_over_2, zoom);
}

fn hex_round(q: f32, r: f32) -> vec2<f32> {
    let s = -q - r;
    var rq = round(q);
    var rr = round(r);
    let rs = round(s);

    let q_diff = abs(rq - q);
    let r_diff = abs(rr - r);
    let s_diff = abs(rs - s);

    if q_diff > r_diff && q_diff > s_diff {
        rq = -rr - rs;
    } else if r_diff > s_diff {
        rr = -rq - rs;
    }

    return vec2<f32>(rq, rr);
}

fn map_hexagonal(
    dx: f32,
    dy: f32,
    width_over_2: f32,
    slice_angle: f32,
    tile_count: f32,
    zoom: f32,
    rotation: f32,
    tx: f32,
    ty: f32,
) -> vec2<f32> {
    let screen_size = width_over_2 * 2.0; 
    let sqrt3 = 1.7320508075688772935274463415058723669428052538103806280558069794;

    let hex_radius = screen_size / (tile_count * sqrt3);
    let q = (sqrt3 / 3.0 * dx - 1.0 / 3.0 * dy) / hex_radius;
    let r = (2.0 / 3.0 * dy) / hex_radius;

    let rq_rr = hex_round(q, r);
    let rq = rq_rr.x;
    let rr = rq_rr.y;

    let hex_cx = hex_radius * sqrt3 * (rq + rr * 0.5);
    let hex_cy = hex_radius * 1.5 * rr;

    let local_x = dx - hex_cx;
    let local_y = dy - hex_cy;

    return source_space_rotation(local_x, local_y, rotation, tx, ty, hex_radius, slice_angle, width_over_2, zoom);
}

fn map_hexagonal_flat_top(
    dx: f32,
    dy: f32,
    width_over_2: f32,
    slice_angle: f32,
    tile_count: f32,
    zoom: f32,
    rotation: f32,
    tx: f32,
    ty: f32,
) -> vec2<f32> {
    let screen_size = width_over_2 * 2.0;
    let sqrt3 = 1.73205080756887729352744;

    let hex_radius = screen_size / (tile_count * 1.5);

    let q = (2.0 / 3.0 * dx) / hex_radius;
    let r = (-1.0 / 3.0 * dx + sqrt3 / 3.0 * dy) / hex_radius;  

    let rq_rr = hex_round(q, r);
    let rq = rq_rr.x;
    let rr = rq_rr.y;

    let hex_cx = hex_radius * 1.5 * rq;
    let hex_cy = hex_radius * sqrt3 * (rr + rq * 0.5);

    let local_x = dx - hex_cx;
    let local_y = dy - hex_cy;

    return source_space_rotation(local_x, local_y, rotation, tx, ty, hex_radius, slice_angle, width_over_2, zoom);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;

    if (x >= settings.output_size_w || y >= settings.output_size_h) {
        return;
    }

    let center_x = f32(settings.output_size_w) * 0.5 + f32(settings.offset_x);
    let center_y = f32(settings.output_size_h) * 0.5 + f32(settings.offset_y);

    let width_over_2 = f32(settings.output_size_w) * 0.5;

    let dx = f32(x) - center_x;
    let dy = f32(y) - center_y;

    var mapped = vec2<f32>(dx, dy);

    switch settings.kaleido_type {
        case 0u: {
            mapped = map_radial(dx, dy, settings.zoom, settings.slice_angle, settings.triangle_rotation_rad);
        }
        case 1u: {
            mapped = map_square(dx, dy, width_over_2, settings.slice_angle, settings.tile_count, settings.zoom, settings.triangle_rotation_rad, settings.triangle_center_x, settings.triangle_center_y);
        }
        case 2u: {
            mapped = map_diamond(dx, dy, width_over_2, settings.slice_angle, settings.tile_count, settings.zoom, settings.triangle_rotation_rad, settings.triangle_center_x, settings.triangle_center_y);
        }
        case 3u: {
            mapped = map_hexagonal(dx, dy, width_over_2, settings.slice_angle, settings.tile_count, settings.zoom, settings.triangle_rotation_rad, settings.triangle_center_x, settings.triangle_center_y);
        }
        case 4u: {
            mapped = map_hexagonal_flat_top(dx, dy, width_over_2, settings.slice_angle, settings.tile_count, settings.zoom, settings.triangle_rotation_rad, settings.triangle_center_x, settings.triangle_center_y);
        }
        default: {
            mapped = vec2<f32>(dx, dy);
        }
    }

    let src_x = round(mapped.x);
    let src_y = round(mapped.y);

    let src_i = vec2<i32>(i32(src_x), i32(src_y));

    let dims = textureDimensions(input_tex);
    if (src_i.x < 0 || src_i.y < 0 || src_i.x >= i32(dims.x) || src_i.y >= i32(dims.y)) {
        textureStore(output_tex, vec2<i32>(i32(x), i32(y)), vec4<f32>(0.0, 0.0, 0.0, 0.0));
        return;
    }

    let color = textureLoad(input_tex, src_i, 0);
    textureStore(output_tex, vec2<i32>(i32(x), i32(y)), color);
}