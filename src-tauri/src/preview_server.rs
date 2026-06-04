//! Local WebSocket server for live-preview frame streaming.
//!
//! ## Why WebSocket + JPEG instead of IPC invoke + raw RGBA?
//!
//! `invoke()` delivers frame data as JSC-heap `ArrayBuffer` objects. Even with a
//! reusable `ImageData` buffer on the JS side, the per-frame `ArrayBuffer` is a
//! GC-tracked object. At 720p 15 fps that's ~1.1 MB/frame of JSC allocations;
//! WKWebView's JSC heap (≈1–2 GB) is exhausted after a few minutes and the
//! process is killed silently.
//!
//! A local WebSocket with `ws.binaryType = "blob"` delivers each frame as a
//! `Blob`. Blobs are stored in **browser-process memory, outside the JSC heap**
//! entirely. `createImageBitmap(blob)` decodes the JPEG in the browser process
//! and returns an `ImageBitmap` that lives in GPU compositor memory — also
//! outside JSC. The JS heap sees zero per-frame allocation from frame data.
//!
//! JPEG encoding shrinks 720p from 1.1 MB raw → ~80–120 KB encoded, reducing
//! IPC bandwidth by ~10×.
//!
//! ## Protocol
//!
//! Standard RFC 6455 WebSocket on 127.0.0.1, random port.
//! The server accepts one client connection at a time.
//!
//! JS → Rust (text frame):  JSON-encoded `FrameRequest`
//! Rust → JS (binary frame): JPEG bytes
//!
//! The JS side sends a request, waits for the binary response, then sends
//! the next request — effectively a request/response pattern over WebSocket.

use std::io::Cursor;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use image::ImageFormat;
use kaleidomo_core::{backends::gpu::GpuBackend, KaleidoSettings, KaleidoType};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ---------------------------------------------------------------------------
// Request type (mirrors FrameParams in native-live-preview.ts)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameRequest {
    pub count: u32,
    pub output_size_w: u32,
    pub output_size_h: u32,
    pub offset_x: i32,
    pub offset_y: i32,
    pub zoom: f32,
    pub tile_count: f32,
    pub x: f32,
    pub y: f32,
    pub rotation: f32,
    pub kaleido_type: String,
    pub hue_rotation: u32,
    pub img_width: u32,
    pub img_height: u32,
    /// JPEG quality 1-100. Frontend sends e.g. 85.
    #[serde(default = "default_quality")]
    pub jpeg_quality: u8,
}

#[derive(Default)]
struct PreviewScratch {
    rgba: Vec<u8>,
    rgb: Vec<u8>,
    jpeg: Vec<u8>,
}

fn default_quality() -> u8 { 85 }

impl FrameRequest {
    fn to_kaleido_settings(&self) -> Result<KaleidoSettings, String> {
        let kaleido_type = match self.kaleido_type.to_lowercase().as_str() {
            "radial"            => KaleidoType::Radial,
            "square"            => KaleidoType::Square,
            "diamond"           => KaleidoType::Diamond,
            "hexagonal"         => KaleidoType::Hexagonal,
            "hexagonal_flat_top" => KaleidoType::HexagonalFlatTop,
            other => return Err(format!("unknown kaleido_type: {other}")),
        };
        Ok(KaleidoSettings {
            count: self.count,
            output_size_w: self.output_size_w,
            output_size_h: self.output_size_h,
            offset_x: self.offset_x,
            offset_y: self.offset_y,
            zoom: self.zoom,
            tile_count: self.tile_count,
            triangle_center_x: self.x.clamp(0.0, self.img_width.saturating_sub(1) as f32),
            triangle_center_y: self.y.clamp(0.0, self.img_height.saturating_sub(1) as f32),
            triangle_rotation_rad: self.rotation,
            kaleido_type,
            hue_rotation: self.hue_rotation,
        })
    }
}

// ---------------------------------------------------------------------------
// Server entry point — call once at app startup
// ---------------------------------------------------------------------------

/// Spawn the WebSocket preview server. Returns the port it bound to.
/// The server runs for the lifetime of the process.
pub async fn start(gpu_arc: Arc<Mutex<Option<GpuBackend>>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind preview WebSocket server");

    let port = listener.local_addr().unwrap().port();
    log::info!("[preview_server] listening on 127.0.0.1:{port}");

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    log::info!("[preview_server] client connected from {addr}");
                    let gpu = Arc::clone(&gpu_arc);
                    tokio::spawn(async move {
                        if let Err(e) = handle_connection(stream, gpu).await {
                            log::warn!("[preview_server] connection closed: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::error!("[preview_server] accept error: {e}");
                }
            }
        }
    });

    port
}

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------

async fn handle_connection(
    mut stream: TcpStream,
    gpu_arc: Arc<Mutex<Option<GpuBackend>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // ── HTTP upgrade handshake ─────────────────────────────────────────────
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await?;
    let req = std::str::from_utf8(&buf[..n])?;

    // Extract Sec-WebSocket-Key
    let key = req
        .lines()
        .find(|l| l.to_lowercase().starts_with("sec-websocket-key:"))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .map(|v| v.trim())
        .ok_or("missing Sec-WebSocket-Key")?;

    // Compute Sec-WebSocket-Accept
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());

    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(response.as_bytes()).await?;

    let mut scratch = Some(PreviewScratch::default());

    // ── Frame loop ────────────────────────────────────────────────────────
    loop {
        // Read one WebSocket frame from client (text frame = JSON request)
        let msg = match read_ws_text_frame(&mut stream).await {
            Ok(Some(m)) => m,
            Ok(None) => break, // connection closed
            Err(e) => {
                log::warn!("[preview_server] read error: {e}");
                break;
            }
        };

        // Parse request
        let req: FrameRequest = match serde_json::from_str(&msg) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[preview_server] bad request JSON: {e}");
                continue;
            }
        };

        // Render — device.poll(wait_indefinitely) inside render_jpeg blocks the
        // thread, so we must run it on a blocking thread pool.
        let gpu_clone = Arc::clone(&gpu_arc);
        let req_clone = req.clone();
        let mut render_scratch = scratch
    .take()
    .unwrap_or_else(PreviewScratch::default);

    let render_result = tokio::task::spawn_blocking(move || {
        let jpeg = render_jpeg(&gpu_clone, &req_clone, &mut render_scratch);
        (jpeg, render_scratch)
    })
    .await;

    let (jpeg_result, returned_scratch) = match render_result {
        Ok(v) => v,
        Err(e) => {
            log::error!("[preview_server] spawn_blocking error: {e}");
            scratch = Some(PreviewScratch::default());
            write_ws_binary_frame(&mut stream, &[]).await?;
            continue;
        }
    };

    scratch = Some(returned_scratch);

    let jpeg = match jpeg_result {
        Ok(j) => j,
        Err(e) => {
            log::error!("[preview_server] render error: {e}");
            write_ws_binary_frame(&mut stream, &[]).await?;
            continue;
        }
    };

        static FRAME_COUNTER: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);

        let frame_no = FRAME_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;

        if frame_no % 300 == 0 {
            log::info!(
                "[preview_server] frame={} jpeg={} bytes output={}x{}",
                frame_no,
                jpeg.len(),
                req.output_size_w,
                req.output_size_h,
            );
        }

        write_ws_binary_frame(&mut stream, &jpeg).await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Synchronous JPEG render — must be called via spawn_blocking
// ---------------------------------------------------------------------------

fn render_jpeg(
    gpu_arc: &Arc<Mutex<Option<GpuBackend>>>,
    req: &FrameRequest,
    scratch: &mut PreviewScratch,
) -> Result<Vec<u8>, String> {
    let settings = req.to_kaleido_settings()?;
    let w = settings.output_size_w;
    let h = settings.output_size_h;

    let rgba_len = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or("RGBA output dimensions overflow")?;

    let rgb_len = (w as usize)
        .checked_mul(h as usize)
        .and_then(|n| n.checked_mul(3))
        .ok_or("RGB output dimensions overflow")?;

    scratch.rgba.resize(rgba_len, 0);
    scratch.rgb.resize(rgb_len, 0);
    scratch.jpeg.clear();

    {
        let mut guard = gpu_arc.lock().map_err(|_| "mutex poisoned")?;
        let gpu = guard.as_mut().ok_or("GPU unavailable")?;

        gpu.render_into_buffer(&settings, &mut scratch.rgba)
            .map_err(|e| e.to_string())?;
    }

    for (src, dst) in scratch
        .rgba
        .chunks_exact(4)
        .zip(scratch.rgb.chunks_exact_mut(3))
    {
        dst[0] = src[0];
        dst[1] = src[1];
        dst[2] = src[2];
    }

    let quality = req.jpeg_quality.clamp(1, 100);

    {
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut scratch.jpeg,
            quality,
        );

        encoder
            .encode(
                &scratch.rgb,
                w,
                h,
                image::ColorType::Rgb8.into(),
            )
            .map_err(|e| e.to_string())?;
    }

    Ok(std::mem::take(&mut scratch.jpeg))
}

// ---------------------------------------------------------------------------
// Minimal WebSocket frame codec (RFC 6455)
// ---------------------------------------------------------------------------

/// Read one text frame from a WebSocket connection.
/// Returns None on clean close.
async fn read_ws_text_frame(
    stream: &mut TcpStream,
) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
    // Read first 2 bytes of frame header
    let mut header = [0u8; 2];
    match stream.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }

    let _fin = (header[0] & 0x80) != 0;
    let opcode = header[0] & 0x0F;
    let masked = (header[1] & 0x80) != 0;
    let payload_len_byte = (header[1] & 0x7F) as u64;

    // Handle close frame
    if opcode == 0x8 {
        return Ok(None);
    }

    // Read extended payload length if needed
    let payload_len: u64 = match payload_len_byte {
        126 => {
            let mut ext = [0u8; 2];
            stream.read_exact(&mut ext).await?;
            u16::from_be_bytes(ext) as u64
        }
        127 => {
            let mut ext = [0u8; 8];
            stream.read_exact(&mut ext).await?;
            u64::from_be_bytes(ext)
        }
        n => n,
    };

    // Read mask (client->server frames are always masked)
    let mask = if masked {
        let mut m = [0u8; 4];
        stream.read_exact(&mut m).await?;
        Some(m)
    } else {
        None
    };

    // Read payload
    let mut payload = vec![0u8; payload_len as usize];
    stream.read_exact(&mut payload).await?;

    // Unmask if needed
    if let Some(mask) = mask {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[i % 4];
        }
    }

    let text = String::from_utf8(payload)?;
    Ok(Some(text))
}

/// Write one binary WebSocket frame (server->client, no masking).
async fn write_ws_binary_frame(
    stream: &mut TcpStream,
    payload: &[u8],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let len = payload.len();

    let mut header = Vec::with_capacity(10);
    header.push(0x82u8); // FIN + binary opcode

    if len <= 125 {
        header.push(len as u8);
    } else if len <= 65535 {
        header.push(126u8);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127u8);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }

    stream.write_all(&header).await?;
    stream.write_all(payload).await?;
    Ok(())
}