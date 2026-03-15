use anyhow::{bail, Context, Result};
use image::{DynamicImage};
use wgpu::util::DeviceExt;

use crate::{KaleidoSettings, KaleidoType};

pub struct GpuBackend {
    device: wgpu::Device,
    queue: wgpu::Queue,

    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,

    input_texture: wgpu::Texture,
    input_view: wgpu::TextureView,
    input_width: u32,
    input_height: u32,
}

impl GpuBackend {
    pub async fn new(source: &DynamicImage) -> Result<Self> {
        let instance = wgpu::Instance::default();

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .context("failed to find a suitable GPU adapter")?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("kaleidomo.device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::default(),
            })
            .await
            .context("failed to create GPU device")?;

        let shader = device.create_shader_module(wgpu::include_wgsl!("kaleidomo.wgsl"));

        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("kaleidomo.bind_group_layout"),
                entries: &[
                    // 0: input texture
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // 1: output storage texture
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::StorageTexture {
                            access: wgpu::StorageTextureAccess::WriteOnly,
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            view_dimension: wgpu::TextureViewDimension::D2,
                        },
                        count: None,
                    },
                    // 2: settings uniform buffer
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: Some(
                                std::num::NonZeroU64::new(
                                    std::mem::size_of::<GpuKaleidoSettings>() as u64
                                )
                                .unwrap(),
                            ),
                        },
                        count: None,
                    },
                ],
            });

        let pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("kaleidomo.pipeline_layout"),
                bind_group_layouts: &[&bind_group_layout],
                immediate_size: 0,
            });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("kaleidomo.compute_pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        let rgba = source.to_rgba8();
        let (input_width, input_height) = rgba.dimensions();

        let input_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kaleidomo.input_texture"),
            size: wgpu::Extent3d {
                width: input_width,
                height: input_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &input_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba.as_raw(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(input_width * 4),
                rows_per_image: Some(input_height),
            },
            wgpu::Extent3d {
                width: input_width,
                height: input_height,
                depth_or_array_layers: 1,
            },
        );

        let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());

        Ok(Self {
            device,
            queue,
            pipeline,
            bind_group_layout,
            input_texture,
            input_view,
            input_width,
            input_height,
        })
    }

    pub fn process_img_with_gpu(&self, settings: &KaleidoSettings, output: &mut [u8]) -> Result<()> {
        if settings.output_size_w == 0 || settings.output_size_h == 0 {
            bail!("output size must be non-zero");
        }

        let expected_len = (settings.output_size_w as usize)
            .checked_mul(settings.output_size_h as usize)
            .and_then(|v| v.checked_mul(4))
            .context("output dimensions overflowed")?;

        if output.len() != expected_len {
            bail!(
                "output buffer length mismatch: got {}, expected {} ({} * {} * 4)",
                output.len(),
                expected_len,
                settings.output_size_w,
                settings.output_size_h
            );
        }

        let output_texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kaleidomo.output_texture"),
            size: wgpu::Extent3d {
                width: settings.output_size_w,
                height: settings.output_size_h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gpu_settings = GpuKaleidoSettings::from_parts(
            settings,
            self.input_width,
            self.input_height,
        );

        let settings_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("kaleidomo.settings_buffer"),
            contents: bytemuck::bytes_of(&gpu_settings),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kaleidomo.bind_group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.input_view),
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

        let bytes_per_pixel = 4u32;
        let unpadded_bytes_per_row = settings.output_size_w * bytes_per_pixel;
        let padded_bytes_per_row =
            align_to(unpadded_bytes_per_row, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let output_buffer_size = padded_bytes_per_row as u64 * settings.output_size_h as u64;

        let readback_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kaleidomo.readback_buffer"),
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("kaleidomo.command_encoder"),
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
            wgpu::Extent3d {
                width: settings.output_size_w,
                height: settings.output_size_h,
                depth_or_array_layers: 1,
            },
        );

        self.queue.submit(Some(encoder.finish()));

        let slice = readback_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();

        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });

        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .context("failed while waiting for GPU work to complete")?;

        rx.recv()
            .context("failed waiting for GPU map_async callback")?
            .context("GPU readback buffer mapping failed")?;

        let mapped = slice.get_mapped_range();

        let row_len = settings.output_size_w as usize * 4;
        for y in 0..settings.output_size_h as usize {
            let src_offset = y * padded_bytes_per_row as usize;
            let dst_offset = y * row_len;
            output[dst_offset..dst_offset + row_len]
                .copy_from_slice(&mapped[src_offset..src_offset + row_len]);
        }

        drop(mapped);
        readback_buffer.unmap();

        Ok(())
    }

    pub fn render_to_image(
        &self,
        settings: &KaleidoSettings,
        output: &mut [u8],
    ) -> Result<()> {
        let expected_len = (settings.output_size_w as usize)
            .checked_mul(settings.output_size_h as usize)
            .and_then(|v| v.checked_mul(4))
            .context("output dimensions overflowed")?;

        if output.len() != expected_len {
            bail!(
                "output buffer length mismatch: got {}, expected {} ({} * {} * 4)",
                output.len(),
                expected_len,
                settings.output_size_w,
                settings.output_size_h
            );
        }

        self.process_img_with_gpu(settings, output)
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

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
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
    pub inv_zoom: f32,
    pub tile_count: f32,
    pub slice_angle: f32,

    pub center_x: f32,
    pub center_y: f32,
    pub triangle_center_x: f32,
    pub triangle_center_y: f32,

    pub triangle_rotation_rad: f32,
    pub source_width: u32,
    pub source_height: u32,
    pub _pad1: u32,
}

impl GpuKaleidoSettings {
    fn from_parts(settings: &KaleidoSettings, source_width: u32, source_height: u32) -> Self {
        let zoom = settings.zoom;
        let inv_zoom = if zoom != 0.0 { 1.0 / zoom } else { 0.0 };
        let slice_angle = (2.0 * std::f32::consts::PI) / settings.count as f32;
        let center_x = settings.output_size_w as f32 * 0.5 + settings.offset_x as f32;
        let center_y = settings.output_size_h as f32 * 0.5 + settings.offset_y as f32;

        Self {
            count: settings.count,
            output_size_w: settings.output_size_w,
            output_size_h: settings.output_size_h, 
            kaleido_type: kaleido_type_to_u32(settings.kaleido_type),

            offset_x: settings.offset_x,
            offset_y: settings.offset_y,
            hue_rotation: settings.hue_rotation,
            _pad0: 0,

            zoom,
            inv_zoom,
            tile_count: settings.tile_count,
            slice_angle,

            center_x,
            center_y,
            triangle_center_x: settings.triangle_center_x,
            triangle_center_y: settings.triangle_center_y,

            triangle_rotation_rad: settings.triangle_rotation_rad,
            source_width,
            source_height,
            _pad1: 0,
        }
    }
}

fn kaleido_type_to_u32(value: KaleidoType) -> u32 {
    match value {
        KaleidoType::Radial => 0,
        KaleidoType::Square => 1,
        KaleidoType::Diamond => 2,
        KaleidoType::Hexagonal => 3,
        KaleidoType::HexagonalFlatTop => 4,
    }
}