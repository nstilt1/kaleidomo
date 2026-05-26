#![allow(incomplete_features)]
#![feature(generic_const_exprs)]

pub use anyhow;
pub use log;
#[allow(unused)]
use anyhow::Context;
use image::{DynamicImage, GenericImageView};
pub mod backends;

use image::{ImageBuffer, Rgba};
use rayon::prelude::*;
use serde::Deserialize;
use std::f32::consts::PI;
pub use wgpu;

pub use image;
pub use pollster;

pub use software_licensor_static_rust_lib::{LicenseData, lib_api::LicenseStatus, lib_api::{get_machine_stats_for_display, StatsDisplay}};
pub use software_licensor_static_rust_lib;
use crate::backends::gpu::{GpuBackend, GpuVideoRenderer};
pub use crate::backends::{KaleidoBackend, DaydreamBackend, Register, inner_loop};

#[derive(Debug, Clone, Copy, Deserialize)]
pub enum KaleidoType {
    Radial,
    Square,
    Diamond,
    Hexagonal,
    HexagonalFlatTop,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaleidoSettings {
    pub count: u32,       // Number of reflections (e.g., 8)
    pub output_size_w: u32,
    pub output_size_h: u32,
    pub offset_x: i32,
    pub offset_y: i32,
    pub zoom: f32,        // How much of the triangle to show
    pub tile_count: f32,
    pub triangle_center_x: f32, // Center of the triangle in source image
    pub triangle_center_y: f32,
    pub triangle_rotation_rad: f32, // Rotation of the triangle in radians
    pub kaleido_type: KaleidoType,  // Type of kaleidoscope (radial, square, etc.)
    pub hue_rotation: u32, // Hue rotation in degrees (0-360)
}

pub struct VideoSettings {
    /// The duration of the animation
    pub animation_duration: f32,
    /// The range of the rotation animation
    pub rotation_range: f32,
    /// The number of rotation cycles
    pub rotation_cycles: f32,
    /// The offset of the rotation animation's phase.
    pub rotation_start_offset: f32,
    /// The rotation function. Can be:
    /// * linear/saw
    /// * triangle
    /// * sin
    /// * sin2
    /// * cos
    /// * -cos
    pub rotation_fn: String,
    /// The range of the hue changing animation
    pub hue_range: i32,
    /// The number of hue changing cycles
    pub hue_cycles: f32,
    /// The phase offset at the start of the hue animation
    pub hue_start_offset: f32,
    /// The hue changing function
    pub hue_fn: String,
    /// Number of still frames at the end of the video
    pub still_frame_ending: u32,
    /// Frame rate
    pub fps: u32,
    /// Quality of the video (0.0 to 1.0)
    pub quality: f32,
    /// The maximum zoom
    pub zoom_max: f32,
    /// The minimum zoom
    pub zoom_min: f32,
    /// The zoom function: linear or sin
    pub zoom_fn: String,
    /// The angle of the zoom at frame 0 in the sawtooth/sin space
    pub zoom_start_offset: f32,
    /// The amount of times that zoom will loop in the video.
    pub num_zoom_loops: u32,
}

pub fn render_kaleidoscope(
    source: &DynamicImage,
    settings: KaleidoSettings,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let (sw, sh) = source.dimensions();
    let _width_over_2 = settings.output_size_w as f32 / 2.0;
    let center_x = settings.output_size_w as f32 / 2.0 + settings.offset_x as f32;
    let center_y = settings.output_size_h as f32 / 2.0 + settings.offset_y as f32;
    let slice_angle = (2.0 * PI) / settings.count as f32;

    // Create a flat vector for the pixels
    let mut pixels = vec![0u8; (settings.output_size_w * settings.output_size_h * 4) as usize];

    // Rayon parallelizes the rows automatically
    pixels
        .par_chunks_exact_mut((settings.output_size_w * 4) as usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..settings.output_size_w {
                // 1. Normalize coordinates relative to center
                let dx = x as f32 - center_x;
                let dy = y as f32 - center_y;

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

    ImageBuffer::from_raw(settings.output_size_w, settings.output_size_h, pixels).unwrap()
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
pub fn render_kaleidoscope_with_backend<B: KaleidoBackend + DaydreamBackend>(
    source: &DynamicImage,
    settings: KaleidoSettings,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let (sw, sh) = source.dimensions();
    let width_over_2 = settings.output_size_w as f32 / 2.0;
    let center_x = settings.output_size_w as f32 / 2.0 + settings.offset_x as f32;
    let center_y = settings.output_size_h as f32 / 2.0 + settings.offset_y as f32;
    let slice_angle = (2.0 * PI) / settings.count as f32;

    // Create a flat vector for the pixels
    let mut pixels = vec![0u8; (settings.output_size_w * settings.output_size_h * 4) as usize];

    // Rayon parallelizes the rows automatically
    pixels
        .par_chunks_exact_mut((settings.output_size_w * 4) as usize)
        .enumerate()
        .for_each(|(y, row)| {
            inner_loop::<B>(
            //inner_loop::<f32>(
                y,
                row,
                settings.zoom,
                source,
                &settings,
                width_over_2,
                center_x,
                center_y,
                slice_angle,
                sw,
                sh,
                settings.hue_rotation,
            );
        });

    ImageBuffer::from_raw(settings.output_size_w, settings.output_size_h, pixels).unwrap()
}

#[cfg(test)]
pub fn render_kaleidoscope_with_gpu(
    source: &DynamicImage,
    settings: KaleidoSettings,
) -> anyhow::Result<ImageBuffer<Rgba<u8>, Vec<u8>>> {
    let rgba = source.to_rgba8();

    let mut gpu = pollster::block_on(GpuBackend::new())
        .context("failed to initialize GPU backend")?;
    gpu.set_source_image(source)?;
    gpu.update_settings(&settings)?;
    let mut pixels = vec![
        0u8;
        (settings.output_size_w as usize)
            .checked_mul(settings.output_size_h as usize)
            .and_then(|v| v.checked_mul(4))
            .context("output dimensions overflowed")?
    ];

    gpu.render_into_buffer(&settings, &mut pixels)
        .context("failed to render kaleidoscope on GPU")?;

    ImageBuffer::from_raw(settings.output_size_w, settings.output_size_h, pixels)
        .context("GPU returned an invalid output buffer length")
}

use openh264::encoder::Encoder;
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::encoder::EncoderConfig;

use std::fs::{remove_file, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use minimp4::Mp4Muxer;
use openh264::encoder::{
    BitRate, FrameRate, IntraFramePeriod, RateControlMode, UsageType,
};
use openh264::OpenH264API;

pub struct Mp4H264Sink {
    width: usize,
    height: usize,
    fps: u32,
    output_mp4_path: PathBuf,
    temp_h264_path: PathBuf,
    encoder: Encoder,
    h264_writer: BufWriter<File>,
    keep_temp_h264: bool,
}

impl Mp4H264Sink {
    pub fn create<P: AsRef<Path>>(
        output_mp4_path: P,
        width: usize,
        height: usize,
        fps: u32,
        bitrate_bps: u32,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if width == 0 || height == 0 {
            return Err("width and height must be non-zero".into());
        }

        if width % 2 != 0 || height % 2 != 0 {
            return Err("width and height must both be even".into());
        }

        if fps == 0 {
            return Err("fps must be non-zero".into());
        }

        let mut output_mp4_path = output_mp4_path.as_ref().to_path_buf();
        match output_mp4_path.extension() {
            Some(ext) => {
                if ext != "mp4" {
                    output_mp4_path.set_extension("mp4");
                }
            },
            None => {
                output_mp4_path.set_extension("mp4");
            }
        }

        let temp_h264_path = {
            let mut p = output_mp4_path.clone();
            let ext = match p.extension().and_then(|e| e.to_str()) {
                Some(ext) if !ext.is_empty() => format!("{ext}.tmp.h264"),
                _ => String::from("tmp.h264"),
            };
            p.set_extension(ext);
            p
        };

        let h264_file = File::create(&temp_h264_path)?;
        let h264_writer = BufWriter::new(h264_file);

        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(bitrate_bps))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .usage_type(UsageType::ScreenContentRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .skip_frames(false)
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps));

        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)?;

        Ok(Self {
            width,
            height,
            fps,
            output_mp4_path,
            temp_h264_path,
            encoder,
            h264_writer,
            keep_temp_h264: false,
        })
    }

    pub fn keep_temp_h264(mut self, keep: bool) -> Self {
        self.keep_temp_h264 = keep;
        self
    }

    pub fn write_rgba_frame(&mut self, rgba: &[u8]) -> Result<YUVBuffer, Box<dyn std::error::Error>> {
        let expected_len = self.width * self.height * 4;
        if rgba.len() != expected_len {
            return Err(format!(
                "invalid RGBA buffer length: got {}, expected {}",
                rgba.len(),
                expected_len
            )
            .into());
        }

        let rgba_source = RgbaSliceU8::new(rgba, (self.width, self.height));
        let yuv = YUVBuffer::from_rgb_source(rgba_source);

        let bitstream = self.encoder.encode(&yuv)?;
        bitstream.write(&mut self.h264_writer)?;

        Ok(yuv)
    }

    pub fn write_yuv_frame(&mut self, yuv: &YUVBuffer) -> Result<(), Box<dyn std::error::Error>> {
        let bitstream = self.encoder.encode(yuv)?;
        bitstream.write(&mut self.h264_writer)?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<(), Box<dyn std::error::Error>> {
        self.h264_writer.flush()?;
        drop(self.h264_writer);

        let mut h264_reader = BufReader::new(File::open(&self.temp_h264_path)?);
        let mut h264_bytes = Vec::new();
        h264_reader.read_to_end(&mut h264_bytes)?;

        let mp4_file = File::create(&self.output_mp4_path)?;
        let mut muxer = Mp4Muxer::new(mp4_file);
        muxer.init_video(self.width as i32, self.height as i32, false, "video");
        muxer.write_video_with_fps(&h264_bytes, self.fps);
        muxer.close();

        if !self.keep_temp_h264 {
            let _ = remove_file(&self.temp_h264_path);
        }

        Ok(())
    }

    pub fn temp_h264_path(&self) -> &Path {
        &self.temp_h264_path
    }
}

pub fn render_video_with_auto_backend(
    source: &DynamicImage,
    settings: KaleidoSettings,
    video_settings: VideoSettings,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if is_x86_feature_detected!("avx2") {
            return render_video::<backends::avx2::__m256>(source, settings, video_settings, path);
        } else if is_x86_feature_detected!("sse2") {
            return render_video::<backends::sse2::__m128>(source, settings, video_settings, path);
        } else {
            return render_video::<f32>(source, settings, video_settings, path);
        }
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        render_video::<Register>(source, settings, video_settings, path)
        //render_video::<f32>(source, settings, path)
    }
}

/// Converts degrees to radians.
#[inline]
fn degrees_to_radians(degrees: f32) -> f32 {
    degrees * (PI / 180.0)
}

/// Converts radians to degrees.
#[inline]
pub fn radians_to_degrees(radians: f32) -> f32 {
    radians * (180.0 / std::f32::consts::PI)
}

/// Modulates a parameter using the frame number.
fn modulate(
    video_settings: &VideoSettings, 
    frame: u32, 
    range_max: f32, 
    range_min: f32, 
    num_loops: f32, 
    start_offset: f32,
    function: &str
) -> f32 {
    let range = range_max - range_min;
    let frame_count = video_settings.animation_duration * video_settings.fps as f32;

    match function.to_ascii_lowercase().as_str() {
        "triangle" => {
            let phase = (frame as f32 / frame_count)
                * num_loops
                + start_offset;

            let phase = phase.fract();

            let tri = 1.0 - (2.0 * phase - 1.0).abs();

            range_min + tri * range
        },

        "sawtooth" => {
            let phase = (frame as f32 / frame_count)
                * num_loops
                + start_offset;

            let saw = phase.fract(); // 0 → 1 ramp

            range_min + saw * range
        },

        "sin" => {
            let phase = (frame as f32 / frame_count)
                * num_loops
                + start_offset;

            let angle = phase * 2.0 * PI;

            let sin_norm = (f32::sin(angle) + 1.0) * 0.5;

            range_min + sin_norm * range
        },

        "sin2" => {
            let phase = (frame as f32 / frame_count)
                * num_loops
                + start_offset;

            let angle = phase * 2.0 * PI;

            // sin²(x) = (1 - cos(2x)) / 2
            let sin2_norm = f32::sin(angle).powi(2);

            range_min + sin2_norm * range
        },

        "cos" => {
            let phase = (frame as f32 / frame_count)
                * num_loops
                + start_offset;

            let angle = phase * 2.0 * PI;

            let cos_norm = (f32::cos(angle) + 1.0) * 0.5;

            range_min + cos_norm * range
        },

        "-cos" => {
            let phase = (frame as f32 / frame_count)
                * num_loops
                + start_offset;

            let angle = phase * 2.0 * PI;

            // Inverted cosine wave
            let neg_cos_norm = (1.0 - f32::cos(angle)) * 0.5;

            range_min + neg_cos_norm * range
        },

        _ => range_min
    }
}

/// Modulates the zoom parameter.
fn zoom_modulation(video_settings: &VideoSettings, frame: u32) -> f32 {
    modulate(
        video_settings, frame, 
        video_settings.zoom_max, 
        video_settings.zoom_min, 
        video_settings.num_zoom_loops as f32, 
        video_settings.zoom_start_offset, 
        &video_settings.zoom_fn
    )
}

/// Renders video with a CPU backend.
fn render_video<B: KaleidoBackend + DaydreamBackend>(
    source: &DynamicImage,
    mut settings: KaleidoSettings,
    video_settings: VideoSettings,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let fps = video_settings.fps;
    let total_frames = f32::round(video_settings.animation_duration * fps as f32) as u32;
    let width_over_2 = settings.output_size_w as f32 / 2.0;
    let center_x = settings.output_size_w as f32 / 2.0 + settings.offset_x as f32;
    let center_y = settings.output_size_h as f32 / 2.0 + settings.offset_y as f32;
    let slice_angle = (2.0 * PI) / settings.count as f32;

    let mut rgba = vec![0u8; (settings.output_size_w * settings.output_size_h * 4) as usize];
    let mut sink = Mp4H264Sink::create(
        path,
        settings.output_size_w as usize,
        settings.output_size_h as usize,
        fps,
        (settings.output_size_w as f32 * settings.output_size_h as f32 * fps as f32 * video_settings.quality).round() as u32,
    )?;

    //let triangle_rotation_delta = degrees_to_radians(video_settings.triangle_rotation_degrees_per_frame);
    let mut last_frame = YUVBuffer::new(settings.output_size_w as usize, settings.output_size_h as usize);
    for frame in 0..total_frames {
        let rotation_modulation = modulate(
            &video_settings, 
            frame, 
            degrees_to_radians(video_settings.rotation_range) + settings.triangle_rotation_rad, 
            settings.triangle_rotation_rad, 
            video_settings.rotation_cycles, 
            video_settings.rotation_start_offset, 
            &video_settings.rotation_fn,
        );
        settings.triangle_rotation_rad = (rotation_modulation).rem_euclid(2.0 * PI);
        rgba
            .par_chunks_exact_mut((settings.output_size_w * 4) as usize)
            .enumerate()
            .for_each(|(y, row)| {
                inner_loop::<Register>(
                    y,
                    row,
                    zoom_modulation(&video_settings, frame),
                    source,
                    &settings,
                    width_over_2,
                    center_x,
                    center_y,
                    slice_angle,
                    source.width(),
                    source.height(),
                    f32::round(modulate(
                        &video_settings, 
                        frame, 
                        video_settings.hue_range as f32 + settings.hue_rotation as f32, 
                        settings.hue_rotation as f32, 
                        video_settings.hue_cycles, 
                        video_settings.hue_start_offset, 
                        &video_settings.hue_fn)
                    ) as u32
                    //(settings.hue_rotation as f32 + frame as f32 * video_settings.hue_rotation_degrees_per_frame).round() as u32,
                );
            });
        last_frame = sink.write_rgba_frame(&rgba)?;
    }

    // write still frames at the end
    for _still_frame in 0..video_settings.still_frame_ending {
        sink.write_yuv_frame(&last_frame)?;
    }

    sink.finish()?;
    Ok(())
}

/// Renders a video with the GPU.
pub fn render_video_gpu_traditional(
    mut settings: KaleidoSettings,
    video_settings: VideoSettings,
    path: &str,
    gpu: &mut GpuBackend
) -> Result<(), Box<dyn std::error::Error>> {
    let fps = video_settings.fps;
    let total_frames = f32::round(video_settings.animation_duration * video_settings.fps as f32) as u32;

    let mut sink = Mp4H264Sink::create(
        path,
        settings.output_size_w as usize,
        settings.output_size_h as usize,
        fps,
        (settings.output_size_w as f32
            * settings.output_size_h as f32
            * fps as f32
            * video_settings.quality)
            .round() as u32,
    )?;

    //let triangle_rotation_delta =
    //    degrees_to_radians(video_settings.triangle_rotation_degrees_per_frame);

    let base_rotation = settings.triangle_rotation_rad;
    let base_hue = settings.hue_rotation as f32;

    let mut output = vec![0u8; (settings.output_size_w * settings.output_size_h * 4) as usize];

    let mut last_frame = YUVBuffer::new(settings.output_size_w as usize, settings.output_size_h as usize);
    for frame in 0..total_frames {
        //settings.triangle_rotation_rad =
        //    (base_rotation + triangle_rotation_delta * frame as f32).rem_euclid(2.0 * PI);

        let rotation_modulation = modulate(
            &video_settings,
            frame,
            base_rotation + degrees_to_radians(video_settings.rotation_range),
            base_rotation,
            video_settings.rotation_cycles,
            video_settings.rotation_start_offset,
            &video_settings.rotation_fn,
        );

        settings.triangle_rotation_rad = rotation_modulation.rem_euclid(2.0 * PI);

        settings.hue_rotation = modulate(
            &video_settings,
            frame,
            base_hue + video_settings.hue_range as f32,
            base_hue,
            video_settings.hue_cycles,
            video_settings.hue_start_offset,
            &video_settings.hue_fn,
        )
        .round()
        .rem_euclid(360.0) as u32;

        settings.zoom = zoom_modulation(&video_settings, frame);

        gpu.render_into_buffer(&settings, &mut output)?;
        
        last_frame = sink.write_rgba_frame(&output)?;
    }
    for _ in 0..video_settings.still_frame_ending {
        sink.write_yuv_frame(&last_frame)?;
    }

    sink.finish()?;

    Ok(())
}

pub fn render_video_gpu(
    mut settings: KaleidoSettings,
    video_settings: VideoSettings,
    path: &str,
    gpu: &mut GpuBackend,
) -> Result<(), Box<dyn std::error::Error>> {
    let fps = video_settings.fps;
    let total_frames = f32::round(video_settings.animation_duration * fps as f32) as u32;

    let mut renderer = GpuVideoRenderer::new(
        gpu,
        settings.output_size_w,
        settings.output_size_h,
        3,
    )?;

    let mut sink = Mp4H264Sink::create(
        path,
        settings.output_size_w as usize,
        settings.output_size_h as usize,
        fps,
        (settings.output_size_w as f32
            * settings.output_size_h as f32
            * fps as f32
            * video_settings.quality)
            .round() as u32,
    )?;

    // let triangle_rotation_delta =
    //     degrees_to_radians(video_settings.triangle_rotation_degrees_per_frame);

    let base_rotation = settings.triangle_rotation_rad;
    let base_hue = settings.hue_rotation as f32;

    let mut last_frame: Option<YUVBuffer> = None;

    for frame in 0..total_frames {
        let rotation_modulation = modulate(
            &video_settings,
            frame,
            base_rotation + degrees_to_radians(video_settings.rotation_range),
            base_rotation,
            video_settings.rotation_cycles,
            video_settings.rotation_start_offset,
            &video_settings.rotation_fn,
        );

        settings.triangle_rotation_rad = rotation_modulation.rem_euclid(2.0 * PI);

        settings.hue_rotation = modulate(
            &video_settings,
            frame,
            base_hue + video_settings.hue_range as f32,
            base_hue,
            video_settings.hue_cycles,
            video_settings.hue_start_offset,
            &video_settings.hue_fn,
        )
        .round()
        .rem_euclid(360.0) as u32;

        settings.zoom = zoom_modulation(&video_settings, frame);

        renderer.submit_frame(frame, &settings)?;

        while let Some(done) = renderer.receive_oldest_blocking()? {
            let rgba = renderer.slot_bytes(done.slot_index)?;
            last_frame = Some(sink.write_rgba_frame(rgba)?);
            renderer.release_slot(done.slot_index)?;
        }
    }

    for done in renderer.drain_remaining_blocking()? {
        let rgba = renderer.slot_bytes(done.slot_index)?;
        last_frame = Some(sink.write_rgba_frame(rgba)?);
        renderer.release_slot(done.slot_index)?;
    }

    if let Some(last_frame) = last_frame {
        for _ in 0..video_settings.still_frame_ending {
            sink.write_yuv_frame(&last_frame)?;
        }
    }

    sink.finish()?;
    Ok(())
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
            output_size_w: 64, // Keep it small for fast tests
            output_size_h: 64,
            offset_x: 0,
            offset_y: 0,
            count: 6,        // Hexagonal symmetry
            zoom: 1.0,
            triangle_center_x: 50.0,
            triangle_center_y: 50.0,
            triangle_rotation_rad: 0.0,
            kaleido_type: KaleidoType::Hexagonal,
            tile_count: 4.0,
            hue_rotation: 0,
        };

        // 3. Render using Scalar Backend
        // Note: You may need to expose these functions or make them generic
        // to call specific backends in the same test.
        //let scalar_image = render_kaleidoscope_with_backend::<f32>(&source, settings.clone());
        let scalar_image = render_kaleidoscope_with_backend::<f32>(&source, settings.clone());

        // 4. Render using Aarch64 (Neon) Backend
        let simd_image = render_kaleidoscope_with_gpu(&source, settings.clone()).unwrap();
        //let simd_image = render_kaleidoscope_with_backend::<Register>(&source, settings.clone());

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

        let total_pixels = settings.output_size_h * settings.output_size_w;
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
