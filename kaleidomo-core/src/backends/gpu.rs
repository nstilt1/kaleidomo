use anyhow::{bail, Context, Result};
use wgpu::util::DeviceExt;

use crate::KaleidoSettings;

pub struct GpuBackend {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub pipeline: wgpu::ComputePipeline,
    pub bind_group_layout: wgpu::BindGroupLayout,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuKaleidoSettings {
    pub count: u32,
    pub output_size_w: u32,
    pub output_size_h: u32,
    pub kaleido_type: u32,

    pub offset_x: i32,
    pub offset_y: i32,
    pub hue_rotation: u32,
    pub _pad0: u32,

    pub zoom: f32,
    pub tile_count: f32,
    pub triangle_center_x: f32,
    pub triangle_center_y: f32,

    pub triangle_rotation_rad: f32,
    pub _pad1: [f32; 3],
}

impl From<KaleidoSettings> for GpuKaleidoSettings {
    fn from(v: KaleidoSettings) -> Self {
        Self {
            count: v.count,
            output_size_w: v.output_size_w,
            output_size_h: v.output_size_h,
            kaleido_type: v.kaleido_type as u32,

            offset_x: v.offset_x,
            offset_y: v.offset_y,
            hue_rotation: v.hue_rotation,
            _pad0: 0,

            zoom: v.zoom,
            tile_count: v.tile_count,
            triangle_center_x: v.triangle_center_x,
            triangle_center_y: v.triangle_center_y,

            triangle_rotation_rad: v.triangle_rotation_rad,
            _pad1: [0.0; 3],
        }
    }
}

impl GpuBackend {
    pub async fn process_img_with_gpu(
        &self,
        source_rgba: &[u8],
        source_width: u32,
        source_height: u32,
        settings: &KaleidoSettings,
    ) -> Result<Vec<u8>> {
        let expected_len = (source_width as usize)
            .checked_mul(source_height as usize)
            .and_then(|v| v.checked_mul(4))
            .context("source image dimensions overflowed")?;

        if source_rgba.len() != expected_len {
            bail!(
                "source_rgba length mismatch: got {}, expected {}",
                source_rgba.len(),
                expected_len
            );
        }

        let input_size = wgpu::Extent3d {
            width: source_width,
            height: source_height,
            depth_or_array_layers: 1,
        };

        let output_size = wgpu::Extent3d {
            width: settings.output_size_w,
            height: settings.output_size_h,
            depth_or_array_layers: 1,
        };

        let input_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kaleidomo.input_texture"),
            size: input_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let output_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kaleidomo.output_texture"),
            size: output_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &input_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            source_rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(source_width * 4),
                rows_per_image: Some(source_height),
            },
            input_size,
        );

        let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gpu_kaleido_settings = GpuKaleidoSettings::from(settings.clone());
        let settings_bytes = bytemuck::bytes_of(&gpu_kaleido_settings);
        let settings_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("kaleidomo.settings_buffer"),
            contents: settings_bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let bytes_per_pixel = 4u32;
        let unpadded_bytes_per_row = settings.output_size_w * bytes_per_pixel;
        let padded_bytes_per_row = align_to(unpadded_bytes_per_row, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let output_buffer_size =
            padded_bytes_per_row as u64 * settings.output_size_h as u64;

        let readback_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kaleidomo.readback_buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kaleidomo.bind_group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&input_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&output_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: settings_buffer.as_entire_binding(),
                },
            ],
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("kaleidomo.encoder"),
            });

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("kaleidomo.compute_pass"),
                timestamp_writes: None,
            });

            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(
                settings.output_size_w.div_ceil(8),
                settings.output_size_h.div_ceil(8),
                1,
            );
        }

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &output_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(settings.output_size_h),
                },
            },
            output_size,
        );

        self.queue.submit(Some(encoder.finish()));

        let slice = readback_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });

        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());

        rx.recv()
            .context("failed waiting for GPU map_async callback")?
            .context("GPU readback buffer mapping failed")?;

        let mapped = slice.get_mapped_range();
        let mut pixels = vec![0u8; (settings.output_size_w * settings.output_size_h * 4) as usize];

        for y in 0..settings.output_size_h as usize {
            let src_offset = y * padded_bytes_per_row as usize;
            let dst_offset = y * (settings.output_size_w as usize * 4);
            let row_len = settings.output_size_w as usize * 4;

            pixels[dst_offset..dst_offset + row_len]
                .copy_from_slice(&mapped[src_offset..src_offset + row_len]);
        }

        drop(mapped);
        readback_buffer.unmap();

        Ok(pixels)
    }
}

fn align_to(value: u32, alignment: u32) -> u32 {
    let rem = value % alignment;
    if rem == 0 {
        value
    } else {
        value + (alignment - rem)
    }
}