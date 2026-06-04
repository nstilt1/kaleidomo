//! `kframe://` — custom URI scheme for live-preview frame streaming.
//!
//! ## Why a URI scheme instead of IPC commands?
//!
//! The `invoke()` IPC path routes frame data through Tauri's JSON/binary
//! serialiser and JavaScriptCore's promise machinery. Even though we return
//! a binary `Response`, JSC creates a heap-tracked `ArrayBuffer` for each
//! frame. At 20 fps × 1.87 MB that is ~37 MB/s of JSC-heap pressure; GC
//! cannot keep pace and the WKWebView process is killed after a few minutes.
//!
//! A URI scheme response is consumed by WKWebView's *URL loading system*,
//! which sits outside the JSC heap. On the JS side we call:
//!
//!   fetch("kframe://frame?<params>")
//!     .then(r => r.blob())           // Blob lives in browser-process memory
//!     .then(b => createImageBitmap(b)) // ImageBitmap lives in GPU memory
//!     .then(bmp => ctx.drawImage(bmp, 0, 0))
//!
//! `Blob` storage and `ImageBitmap` are both outside the JSC heap, so the
//! frame bytes never become a GC-tracked JS object.
//!
//! ## Wire format
//!
//! Request URL: `kframe://frame?w=<u32>&h=<u32>&<other_params>`
//! Response: raw RGBA bytes, Content-Type: application/octet-stream,
//!           with custom headers `X-Frame-Width` and `X-Frame-Height`.
//!
//! The JS side reads width/height from the response headers rather than
//! a binary header prefix, keeping the body a pure flat pixel buffer.

use std::sync::{Arc, Mutex};

use kaleidomo_core::{KaleidoSettings, KaleidoType};
use kaleidomo_core::backends::gpu::GpuBackend;

/// Parameters encoded in the kframe URL query string.
/// All fields are plain integers/floats to keep URL parsing simple.
#[derive(Debug, Clone)]
pub struct FrameRequest {
    pub settings: KaleidoSettings,
    pub img_width: u32,
    pub img_height: u32,
}

impl FrameRequest {
    pub fn from_query(query: &str) -> Result<Self, String> {
        let mut m = std::collections::HashMap::new();
        for part in query.split('&') {
            if let Some((k, v)) = part.split_once('=') {
                m.insert(k, v);
            }
        }

        macro_rules! get_f32 {
            ($k:expr) => {
                m.get($k)
                    .ok_or_else(|| format!("missing param: {}", $k))?
                    .parse::<f32>()
                    .map_err(|_| format!("bad f32 for {}", $k))?
            };
        }
        macro_rules! get_u32 {
            ($k:expr) => {
                m.get($k)
                    .ok_or_else(|| format!("missing param: {}", $k))?
                    .parse::<u32>()
                    .map_err(|_| format!("bad u32 for {}", $k))?
            };
        }
        macro_rules! get_i32 {
            ($k:expr) => {
                m.get($k)
                    .ok_or_else(|| format!("missing param: {}", $k))?
                    .parse::<i32>()
                    .map_err(|_| format!("bad i32 for {}", $k))?
            };
        }

        let kaleido_type = match m.get("kt").copied().unwrap_or("radial") {
            "radial"            => KaleidoType::Radial,
            "square"            => KaleidoType::Square,
            "diamond"           => KaleidoType::Diamond,
            "hexagonal"         => KaleidoType::Hexagonal,
            "hexagonal_flat_top" => KaleidoType::HexagonalFlatTop,
            other => return Err(format!("unknown kaleido_type: {other}")),
        };

        Ok(Self {
            img_width:  get_u32!("iw"),
            img_height: get_u32!("ih"),
            settings: KaleidoSettings {
                count:               get_u32!("count"),
                output_size_w:       get_u32!("ow"),
                output_size_h:       get_u32!("oh"),
                offset_x:            get_i32!("ox"),
                offset_y:            get_i32!("oy"),
                zoom:                get_f32!("zoom"),
                tile_count:          get_f32!("tc"),
                triangle_center_x:   get_f32!("x").clamp(0.0, get_u32!("iw").saturating_sub(1) as f32),
                triangle_center_y:   get_f32!("y").clamp(0.0, get_u32!("ih").saturating_sub(1) as f32),
                triangle_rotation_rad: get_f32!("rot"),
                kaleido_type,
                hue_rotation:        get_u32!("hue"),
            },
        })
    }
}

/// Render one frame synchronously. Called from the URI scheme handler which
/// already runs on a background thread (WKWebView's URL loading thread),
/// so blocking is safe here.
pub fn render_frame_sync(
    gpu_arc: &Arc<Mutex<Option<GpuBackend>>>,
    req: &FrameRequest,
) -> Result<Vec<u8>, String> {
    let w = req.settings.output_size_w;
    let h = req.settings.output_size_h;
    let pixel_count = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or("output dimensions overflow")?;

    let mut pixels = vec![0u8; pixel_count];

    let mut guard = gpu_arc
        .lock()
        .map_err(|_| "GPU mutex poisoned".to_string())?;

    let gpu = guard
        .as_mut()
        .ok_or("GPU backend unavailable")?;

    gpu.render_into_buffer(&req.settings, &mut pixels)
        .map_err(|e| format!("GPU render failed: {e}"))?;

    Ok(pixels)
}