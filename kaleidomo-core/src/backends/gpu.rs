use std::num::NonZeroU64;
use std::sync::mpsc;

use anyhow::{anyhow, bail, Context, Result};
use image::DynamicImage;
use log::{debug, error, info, warn};
use wgpu::util::DeviceExt;

use crate::{KaleidoSettings, KaleidoType};

pub struct GpuBackend {
    pub device: wgpu::Device,
    queue: wgpu::Queue,
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,

    source: Option<SourceImageGpu>,
    output: Option<OutputResources>,
    last_settings: Option<GpuKaleidoSettings>,
}

struct SourceImageGpu {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

struct OutputResources {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    readback_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
    cpu_buffer: Vec<u8>,
}

impl GpuBackend {
    pub async fn new() -> Result<Self> {
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

        let settings_min_binding_size = non_zero_u64(std::mem::size_of::<GpuKaleidoSettings>() as u64)
            .context("GpuKaleidoSettings size cannot be zero")?;

        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("kaleidomo.bind_group_layout"),
                entries: &[
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
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: Some(settings_min_binding_size),
                        },
                        count: None,
                    },
                ],
            });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
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

        info!("GpuBackend initialized successfully");

        Ok(Self {
            device,
            queue,
            bind_group_layout,
            pipeline,
            source: None,
            output: None,
            last_settings: None,
        })
    }

    pub fn set_source_image(&mut self, source: &DynamicImage) -> Result<()> {
        let rgba = source.to_rgba8();
        let (width, height) = rgba.dimensions();

        if width == 0 || height == 0 {
            error!("set_source_image called with zero-sized image: {}x{}", width, height);
            bail!("source image dimensions must be non-zero");
        }

        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kaleidomo.input_texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba.as_raw(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        self.source = Some(SourceImageGpu {
            texture,
            view,
            width,
            height,
        });

        self.last_settings = None;

        info!("Source image uploaded to GPU: {}x{}", width, height);
        Ok(())
    }

    pub fn clear_source_image(&mut self) {
        warn!("Clearing current source image from GPU state");
        self.source = None;
        self.last_settings = None;
    }

    pub fn update_settings(&mut self, settings: &KaleidoSettings) -> Result<()> {
        let source = match self.source.as_ref() {
            Some(source) => source,
            None => {
                error!("update_settings called before a source image was set");
                bail!("cannot update GPU settings without a source image");
            }
        };

        self.last_settings = Some(GpuKaleidoSettings::from_parts(
            settings,
            source.width,
            source.height,
        ));

        debug!(
            "Updated cached GPU settings for output {}x{}",
            settings.output_size_w, settings.output_size_h
        );

        Ok(())
    }

    pub fn render_into_buffer(&mut self, settings: &KaleidoSettings, output: &mut [u8]) -> Result<()> {
        let expected_len = expected_rgba_len(settings.output_size_w, settings.output_size_h)?;
        if output.len() != expected_len {
            error!(
                "render_into_buffer output length mismatch: got {}, expected {}",
                output.len(),
                expected_len
            );
            bail!(
                "output buffer length mismatch: got {}, expected {} ({} * {} * 4)",
                output.len(),
                expected_len,
                settings.output_size_w,
                settings.output_size_h
            );
        }

        self.ensure_output_resources(settings.output_size_w, settings.output_size_h)?;

        let source = match self.source.as_ref() {
            Some(source) => source,
            None => {
                error!("render_into_buffer called with no source image selected");
                bail!("no source image is currently loaded into the GPU backend");
            }
        };

        let gpu_settings =
            GpuKaleidoSettings::from_parts(settings, source.width, source.height);
        self.last_settings = Some(gpu_settings);

        let settings_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("kaleidomo.settings_buffer"),
            contents: bytemuck::bytes_of(&gpu_settings),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let output_resources = match self.output.as_ref() {
            Some(resources) => resources,
            None => {
                error!("output resources unexpectedly missing after ensure_output_resources");
                bail!("output resources were not available");
            }
        };

        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("kaleidomo.bind_group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&source.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&output_resources.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: settings_buffer.as_entire_binding(),
                },
            ],
        });

        let mut encoder =
            self.device
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
                texture: &output_resources.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &output_resources.readback_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(output_resources.padded_bytes_per_row),
                    rows_per_image: Some(output_resources.height),
                },
            },
            wgpu::Extent3d {
                width: output_resources.width,
                height: output_resources.height,
                depth_or_array_layers: 1,
            },
        );

        self.queue.submit(Some(encoder.finish()));

        self.readback_into_output(output)
    }

    pub fn render_into_internal_buffer(&mut self, settings: &KaleidoSettings) -> Result<&[u8]> {
        let expected_len = expected_rgba_len(settings.output_size_w, settings.output_size_h)?;
        self.ensure_output_resources(settings.output_size_w, settings.output_size_h)?;

        {
            let output_resources = match self.output.as_mut() {
                Some(resources) => resources,
                None => {
                    error!("output resources missing before internal render");
                    bail!("output resources were not available");
                }
            };

            if output_resources.cpu_buffer.len() != expected_len {
                output_resources.cpu_buffer.resize(expected_len, 0);
            }
        }

        let mut temp = vec![0u8; expected_len];
        self.render_into_buffer(settings, &mut temp)?;

        let output_resources = match self.output.as_mut() {
            Some(resources) => resources,
            None => {
                error!("output resources missing after internal render");
                bail!("output resources were not available");
            }
        };

        output_resources.cpu_buffer.copy_from_slice(&temp);
        Ok(&output_resources.cpu_buffer)
    }

    pub fn latest_output(&self) -> Option<&[u8]> {
        self.output.as_ref().map(|o| o.cpu_buffer.as_slice())
    }

    fn ensure_output_resources(&mut self, width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            error!("ensure_output_resources called with zero-sized output: {}x{}", width, height);
            bail!("output dimensions must be non-zero");
        }

        let needs_rebuild = match self.output.as_ref() {
            Some(existing) => existing.width != width || existing.height != height,
            None => true,
        };

        if !needs_rebuild {
            return Ok(());
        }

        let padded_bytes_per_row = align_to(width * 4, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let readback_size = padded_bytes_per_row as u64 * height as u64;

        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("kaleidomo.output_texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let readback_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("kaleidomo.readback_buffer"),
            size: readback_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let cpu_buffer = vec![0u8; expected_rgba_len(width, height)?];

        self.output = Some(OutputResources {
            texture,
            view,
            readback_buffer,
            width,
            height,
            padded_bytes_per_row,
            cpu_buffer,
        });

        info!("Allocated GPU output resources for {}x{}", width, height);
        Ok(())
    }

    fn readback_into_output(&self, output: &mut [u8]) -> Result<()> {
        let output_resources = match self.output.as_ref() {
            Some(resources) => resources,
            None => {
                error!("readback_into_output called with no output resources allocated");
                bail!("output resources are not allocated");
            }
        };

        let slice = output_resources.readback_buffer.slice(..);
        let (tx, rx) = mpsc::channel();

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
        let row_len = output_resources.width as usize * 4;

        for y in 0..output_resources.height as usize {
            let src_offset = y * output_resources.padded_bytes_per_row as usize;
            let dst_offset = y * row_len;
            output[dst_offset..dst_offset + row_len]
                .copy_from_slice(&mapped[src_offset..src_offset + row_len]);
        }

        drop(mapped);
        output_resources.readback_buffer.unmap();

        Ok(())
    }
}

fn expected_rgba_len(width: u32, height: u32) -> Result<usize> {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| anyhow!("RGBA output dimensions overflowed"))
}

fn non_zero_u64(value: u64) -> Result<NonZeroU64> {
    NonZeroU64::new(value).ok_or_else(|| anyhow!("value must be non-zero"))
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
    pub fn from_parts(settings: &KaleidoSettings, source_width: u32, source_height: u32) -> Self {
        let zoom = settings.zoom;
        let inv_zoom = if zoom.abs() > f32::EPSILON { 1.0 / zoom } else { 0.0 };
        let safe_count = settings.count.max(1);
        let slice_angle = (2.0 * std::f32::consts::PI) / safe_count as f32;
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