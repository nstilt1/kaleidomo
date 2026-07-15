// src-tauri/src/audio_loopback.rs
//
// System audio loopback capture — listens to what the OS is playing back
// (or what a specific app is playing) and streams peak values to the frontend.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ Platform summary                                                         │
// │                                                                          │
// │  Windows  — WASAPI loopback via cpal. cpal opens the default *output*   │
// │             device as an input stream, capturing everything mixed by     │
// │             the OS. Per-app capture uses IAudioSessionManager2 (the      │
// │             `windows` crate) to enumerate sessions; we pick one and      │
// │             route only its stream by process ID filtering the peaks.     │
// │                                                                          │
// │  macOS    — ScreenCaptureKit through objc2 bindings. System-audio       │
// │             capture requires macOS 13+ and Screen & System Audio         │
// │             Recording permission. Per-app capture uses an               │
// │             SCContentFilter scoped to one SCRunningApplication.          │
// │                                                                          │
// │  Linux    — PipeWire monitor sources. cpal sees these as regular input   │
// │             devices named "Monitor of …". No permission required.        │
// │             Per-app: PipeWire node graph allows routing but is           │
// │             complex; for now we capture the sink monitor (all audio).    │
// └──────────────────────────────────────────────────────────────────────────┘
//
// ── Why streams are built inside the keepalive thread ────────────────────────
//
// cpal::Stream (and SCStream on macOS) intentionally does NOT implement Send.
// The stream contains raw driver pointers that are only valid on the thread
// that created them. This means we cannot:
//   - move a built stream into thread::spawn  (requires Send)
//   - build the stream then send it through a channel  (requires Send)
//
// The solution: build the stream *inside* the spawned thread so the !Send
// value never crosses a thread boundary. We pass only Send-safe values into
// the closure (Arc handles, device-name strings, config). A oneshot-style
// mpsc channel sends the Result<(), String> back to the calling thread so
// start_capture() can still surface errors to the frontend.
//
//   calling thread                      audio thread
//   ─────────────                       ────────────
//   spawn(move || {                 →   receive Send-safe args
//     build stream (locally)            stream lives here, never moves
//     if Ok: play, loop on stop flag    blocks until stop set
//     if Err: send Err back             stream drops here when done
//   })
//   recv result_rx → propagate Err

use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc, Mutex,
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ── Shared state ─────────────────────────────────────────────────────────────

/// Handle to the running loopback capture session.
/// Dropped when the user stops capture or selects a different source.
pub struct LoopbackSession {
    /// Signal the capture thread to stop.
    pub stop: Arc<AtomicBool>,
    /// The process ID being captured (None = all system audio).
    pub pid: Option<u32>,
}

/// Per-frame peak, stored as f32 bits for lock-free sharing.
pub type PeakHandle = Arc<AtomicU32>;

fn store_peak(h: &PeakHandle, v: f32) {
    h.store(v.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
}

pub fn read_peak(h: &PeakHandle) -> f32 {
    f32::from_bits(h.load(Ordering::Relaxed))
}

// ── Frontend-facing types ─────────────────────────────────────────────────────

/// An audio source the user can choose from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    /// Unique key — passed back to `start_loopback_capture`.
    pub id: String,
    /// Human-readable label shown in the UI.
    pub label: String,
    /// Optional PID (None for "all system audio").
    pub pid: Option<u32>,
    /// Source kind for UI grouping.
    pub kind: AudioSourceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioSourceKind {
    /// Captures everything the OS mixes to the speakers.
    SystemLoopback,
    /// Captures a single running application.
    Application,
    /// A hardware microphone / line-in input.
    InputDevice,
}

// ── Platform implementations ──────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Windows
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    /// List all WASAPI loopback sources (system + per-app sessions).
    pub fn list_sources() -> Vec<AudioSource> {
        let mut sources = Vec::new();

        // Always offer "System Loopback" (everything mixed by the OS).
        sources.push(AudioSource {
            id: "system_loopback".into(),
            label: "System Audio (all apps)".into(),
            pid: None,
            kind: AudioSourceKind::SystemLoopback,
        });

        // Enumerate WASAPI audio sessions to offer per-app capture.
        // Uses the `windows` crate COM bindings.
        // Requires the `wasapi_sessions` feature and the `windows` crate with
        // the `Win32_Media_Audio` feature enabled in Cargo.toml.
        #[cfg(feature = "wasapi_sessions")]
        {
            if let Ok(sessions) = enumerate_wasapi_sessions() {
                for s in sessions {
                    sources.push(s);
                }
            }
        }

        // Also offer regular input devices (microphone, line-in).
        let host = cpal::host_from_id(cpal::HostId::Wasapi)
            .unwrap_or_else(|_| cpal::default_host());
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if let Ok(name) = d.name() {
                    sources.push(AudioSource {
                        id: format!("input:{}", name),
                        label: name.clone(),
                        pid: None,
                        kind: AudioSourceKind::InputDevice,
                    });
                }
            }
        }

        sources
    }

    /// Enumerate per-application WASAPI audio sessions.
    ///
    /// This function is only compiled when the `wasapi_sessions` feature is
    /// enabled. It requires adding the `windows` crate to Cargo.toml with:
    ///   windows = { version = "0.58", features = ["Win32_Media_Audio"] }
    ///
    /// Without that feature the function is still present (returning an empty
    /// vec) so the `cfg(feature = "wasapi_sessions")` block in list_sources
    /// always compiles cleanly.
    #[cfg(feature = "wasapi_sessions")]
    fn enumerate_wasapi_sessions() -> Result<Vec<AudioSource>, String> {
        // TODO: implement IAudioSessionManager2 enumeration via the `windows`
        // crate once the `wasapi_sessions` feature is enabled.
        // For now, return an empty list so the feature compiles without
        // requiring the COM implementation to be written first.
        Ok(Vec::new())
    }

    /// Start capturing the selected source and forwarding peak values.
    /// Returns a `LoopbackSession` whose `stop` flag kills the stream.
    ///
    /// The stream is built *inside* the keepalive thread — see the module-level
    /// comment for why this is required (cpal::Stream is !Send).
    pub fn start_capture(
        source_id: &str,
        peak: PeakHandle,
        _app: AppHandle,
    ) -> Result<LoopbackSession, String> {
        let stop = Arc::new(AtomicBool::new(false));
        // stop_ret is kept on the calling thread for the LoopbackSession return value.
        // stop_clone is what we hand to the data callback (innermost closure).
        // The keepalive loop inside each spawn branch gets its own Arc::clone too,
        // so the original `stop` is never moved — only cloned into each closure.
        let stop_ret   = Arc::clone(&stop);
        let stop_clone = Arc::clone(&stop);

        // Oneshot channel: the audio thread sends Ok(()) on successful stream
        // start, or Err(msg) if construction or play() fails. The calling
        // thread blocks on result_rx.recv() before returning to the frontend.
        let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        if source_id == "system_loopback" {
            // WASAPI loopback: open the default *output* device as an input.
            // cpal exposes this via `build_input_stream` on the output device
            // when the host is WASAPI — it creates a loopback stream automatically.
            let peak_clone = Arc::clone(&peak);
            // stop_loop is a separate clone for the keepalive while-loop so
            // that stop_clone remains available for the data callback closure.
            let stop_loop = Arc::clone(&stop);
            std::thread::spawn(move || {
                // All cpal calls happen here — stream never leaves this thread.
                let host = match cpal::host_from_id(cpal::HostId::Wasapi) {
                    Ok(h) => h,
                    Err(e) => { let _ = result_tx.send(Err(format!("WASAPI host unavailable: {e}"))); return; }
                };
                let device = match host.default_output_device() {
                    Some(d) => d,
                    None => { let _ = result_tx.send(Err("no default output device".into())); return; }
                };
                let config = match device.default_output_config() {
                    Ok(c) => c,
                    Err(e) => { let _ = result_tx.send(Err(format!("output config error: {e}"))); return; }
                };

                let mut smoothed = 0f32;
                let stream = match device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        if stop_clone.load(Ordering::Relaxed) { return; }
                        // RMS of the block, exponentially smoothed.
                        let rms = (data.iter().map(|&s| s * s).sum::<f32>()
                            / data.len().max(1) as f32).sqrt();
                        smoothed = smoothed * 0.9 + rms * 0.1;
                        store_peak(&peak_clone, smoothed * 2.0);
                    },
                    |err| eprintln!("[loopback] stream error: {err}"),
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => { let _ = result_tx.send(Err(format!("build_input_stream error: {e}"))); return; }
                };

                if let Err(e) = stream.play() {
                    let _ = result_tx.send(Err(format!("stream.play() error: {e}")));
                    return;
                }

                // Signal the calling thread that capture started successfully.
                let _ = result_tx.send(Ok(()));

                // Block here — stream stays alive and !Send constraint is satisfied
                // because it never left this thread.
                while !stop_loop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                // stream drops here, on the thread that created it.
            });
        } else {
            // Named input device (microphone, line-in, etc.)
            // Strip the "input:" prefix that list_sources adds as a namespace.
            let device_name = source_id.strip_prefix("input:").unwrap_or(source_id).to_owned();
            let peak_clone = Arc::clone(&peak);
            let stop_loop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let host = cpal::default_host();
                let device = match host.input_devices()
                    .map_err(|e| e.to_string())
                    .and_then(|mut devs| devs.find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
                        .ok_or_else(|| format!("device '{}' not found", device_name)))
                {
                    Ok(d) => d,
                    Err(e) => { let _ = result_tx.send(Err(e)); return; }
                };
                let config = match device.default_input_config() {
                    Ok(c) => c,
                    Err(e) => { let _ = result_tx.send(Err(e.to_string())); return; }
                };

                let mut smoothed = 0f32;
                let stream = match device.build_input_stream(
                    &config.into(),
                    move |data: &[f32], _| {
                        if stop_clone.load(Ordering::Relaxed) { return; }
                        let rms = (data.iter().map(|&s| s * s).sum::<f32>()
                            / data.len().max(1) as f32).sqrt();
                        smoothed = smoothed * 0.9 + rms * 0.1;
                        store_peak(&peak_clone, smoothed * 2.0);
                    },
                    |err| eprintln!("[loopback/input] error: {err}"),
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => { let _ = result_tx.send(Err(e.to_string())); return; }
                };

                if let Err(e) = stream.play() {
                    let _ = result_tx.send(Err(e.to_string()));
                    return;
                }

                let _ = result_tx.send(Ok(()));

                // Block here — stream stays on this thread.
                while !stop_loop.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                // stream drops here, on the thread that created it.
            });
        }

        // Block until the audio thread reports success or failure.
        result_rx.recv()
            .map_err(|_| "audio thread exited before signalling".to_string())??;

        Ok(LoopbackSession { stop: stop_ret, pid: None })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::{DynBlock, RcBlock};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use dispatch2::{DispatchQueue, DispatchQueueAttr};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_core_audio_types::{AudioBuffer, AudioBufferList, AudioStreamBasicDescription};
    use objc2_core_foundation::CFRetained;
    use objc2_core_media::{
        CMBlockBuffer, CMSampleBuffer, CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer,
    };
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCRunningApplication, SCShareableContent, SCStream,
        SCStreamConfiguration, SCStreamOutput, SCStreamOutputType, SCWindow,
    };
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};
    use std::ptr;
    use std::ptr::NonNull;
    use std::slice;
    use std::time::{Duration, Instant};
    use tauri::Emitter;

    const SCREEN_CAPTURE_PERMISSION_HINT: &str =
        "Grant Kaleidomo access in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the app.";

    // Apps launched via Finder/double-click have no terminal attached, so plain
    // `eprintln!` output goes nowhere and never shows up in Console.app — only
    // messages sent through the unified logging system (NSLog, os_log, etc.) do.
    // This helper sends our diagnostic lines through NSLog so they're visible in
    // Console.app (filter by process name) *and* keeps the eprintln! for anyone
    // running the binary directly from Terminal.
    unsafe extern "C" {
        fn NSLog(format: &NSString, ...);
    }

    fn dbg_log(message: &str) {
        eprintln!("{message}");
        let ns_message = NSString::from_str(message);
        // SAFETY: NSLog is called with exactly the fixed `format` argument and no
        // variadic arguments, which is a valid call per the C calling convention.
        unsafe { NSLog(&ns_message) };
    }

    #[derive(Debug)]
    struct AudioOutputIvars {
        app: AppHandle,
        peak: PeakHandle,
        stop: Arc<AtomicBool>,
        smoothed: Mutex<f32>,
        last_emit: Mutex<Instant>,
        logged_first_buffer: AtomicBool,
        logged_first_nonzero_peak: AtomicBool,
    }

    define_class!(
        // SAFETY: NSObject has no additional subclassing requirements and this
        // class owns only Send + Sync Rust ivars.
        #[unsafe(super = NSObject)]
        #[name = "KaleidomoScreenCaptureAudioOutput"]
        #[ivars = AudioOutputIvars]
        struct AudioOutput;

        // SAFETY: NSObjectProtocol adds no extra invariants.
        unsafe impl NSObjectProtocol for AudioOutput {}

        // SAFETY: The selector and parameter types match SCStreamOutput.
        unsafe impl SCStreamOutput for AudioOutput {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            #[allow(non_snake_case)]
            unsafe fn stream_didOutputSampleBuffer_ofType(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                output_type: SCStreamOutputType,
            ) {
                if output_type != SCStreamOutputType::Audio
                    || self.ivars().stop.load(Ordering::Relaxed)
                {
                    return;
                }

                let Some(rms) = sample_buffer_rms(sample_buffer) else {
                    return;
                };

                if !self.ivars().logged_first_buffer.swap(true, Ordering::Relaxed) {
                    dbg_log(&format!("[sck] received first decodable audio buffer; rms={rms:.6}"));
                }
                if rms > 0.000_001
                    && !self
                        .ivars()
                        .logged_first_nonzero_peak
                        .swap(true, Ordering::Relaxed)
                {
                    dbg_log(&format!("[sck] received first nonzero system-audio peak; rms={rms:.6}"));
                }

                if let Ok(mut smoothed) = self.ivars().smoothed.lock() {
                    *smoothed = *smoothed * 0.82 + rms * 0.18;
                    let peak = (*smoothed * 4.0).clamp(0.0, 1.0);
                    store_peak(&self.ivars().peak, peak);

                    // Emit directly from the native capture callback. This avoids
                    // depending on a visible controls webview, JavaScript polling,
                    // or requestAnimationFrame to move the peak into the main window.
                    if let Ok(mut last_emit) = self.ivars().last_emit.lock() {
                        if last_emit.elapsed() >= Duration::from_millis(30) {
                            *last_emit = Instant::now();
                            let _ = self.ivars().app.emit(
                                "kd://loopback-peak",
                                serde_json::json!({ "peak": peak }),
                            );
                        }
                    }
                }
            }
        }
    );

    impl AudioOutput {
        fn new(app: AppHandle, peak: PeakHandle, stop: Arc<AtomicBool>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(AudioOutputIvars {
                app,
                peak,
                stop,
                smoothed: Mutex::new(0.0),
                last_emit: Mutex::new(Instant::now() - Duration::from_secs(1)),
                logged_first_buffer: AtomicBool::new(false),
                logged_first_nonzero_peak: AtomicBool::new(false),
            });
            // SAFETY: NSObject's init signature is correct.
            unsafe { msg_send![super(this), init] }
        }
    }

    // Core Media exposes these C functions, but the generated objc2 bindings use
    // a mix of free functions and methods depending on crate version. Declaring
    // the two stable C symbols locally keeps this parser compatible with
    // objc2-core-media 0.3.x while still using objc2's strongly typed structs.
    unsafe extern "C" {
        fn CMSampleBufferGetFormatDescription(
            sample_buffer: *const CMSampleBuffer,
        ) -> *const c_void;

        fn CMAudioFormatDescriptionGetStreamBasicDescription(
            format_description: *const c_void,
        ) -> *const AudioStreamBasicDescription;
    }

    const AUDIO_FORMAT_LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
    const AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 1 << 0;
    const AUDIO_FORMAT_FLAG_IS_BIG_ENDIAN: u32 = 1 << 1;
    const AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER: u32 = 1 << 2;
    const AUDIO_FORMAT_FLAG_IS_ALIGNED_HIGH: u32 = 1 << 4;

    /// Decode one ScreenCaptureKit audio sample buffer and return its RMS level.
    ///
    /// ScreenCaptureKit normally emits native-endian Float32 PCM, but Core Media
    /// does not guarantee that every device/OS combination uses that exact layout.
    /// Reading the AudioStreamBasicDescription prevents integer or Float64 buffers
    /// from being misinterpreted as Float32, which previously left the peak at zero.
    fn sample_buffer_rms(sample_buffer: &CMSampleBuffer) -> Option<f32> {
        let asbd = unsafe {
            let description = CMSampleBufferGetFormatDescription(sample_buffer);
            if description.is_null() {
                return None;
            }

            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description);
            asbd.as_ref()?
        };

        if asbd.mFormatID != AUDIO_FORMAT_LINEAR_PCM {
            dbg_log(&format!(
                "[sck] unsupported audio format id=0x{:08x}",
                asbd.mFormatID,
            ));
            return None;
        }

        let mut needed = 0usize;

        // `blockBufferOut` (the last parameter) is a *required* out-parameter for
        // this "WithRetainedBlockBuffer" variant of the API — Core Media returns
        // OSStatus -12731 (kCMSampleBufferError_RequiredParameterMissing) if it's
        // NULL, even on this size-only query call. We don't need the block buffer
        // from this call, so release it immediately if the OS hands one back.
        let mut size_query_block_buffer: *mut CMBlockBuffer = ptr::null_mut();
        unsafe {
            let _ = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sample_buffer,
                &mut needed,
                ptr::null_mut(),
                0,
                None,
                None,
                0,
                &mut size_query_block_buffer,
            );
        }
        if !size_query_block_buffer.is_null() {
            // SAFETY: a non-null pointer here is a +1 retained CMBlockBuffer;
            // wrapping it in CFRetained releases it as soon as it drops.
            unsafe {
                drop(CFRetained::from_raw(NonNull::new_unchecked(
                    size_query_block_buffer,
                )));
            }
        }

        if needed < size_of::<AudioBufferList>() {
            needed = size_of::<AudioBufferList>();
        }

        // Use usize storage so the variable-length AudioBufferList is pointer-aligned.
        let words = needed.div_ceil(size_of::<usize>());
        let mut storage = vec![MaybeUninit::<usize>::uninit(); words];
        let list = storage.as_mut_ptr().cast::<AudioBufferList>();

        // Same requirement as above: this out-parameter must point at valid
        // storage or the call fails with -12731 before it ever touches `list`.
        let mut block_buffer: *mut CMBlockBuffer = ptr::null_mut();
        let status = unsafe {
            CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sample_buffer,
                &mut needed,
                list,
                words * size_of::<usize>(),
                None,
                None,
                0,
                &mut block_buffer,
            )
        };
        if status != 0 {
            dbg_log(&format!("[sck] failed to get AudioBufferList: OSStatus {status}"));
            return None;
        }

        // SAFETY: `status == 0` guarantees a +1 retained CMBlockBuffer was written
        // into `block_buffer`. The AudioBuffer.mData pointers inside `list` point
        // into memory owned by that block buffer, so it must stay alive for as
        // long as we're reading `list` below. Keeping it bound here (rather than
        // releasing it right away) is what actually keeps the sample data valid;
        // it's dropped — and the buffer released — at the end of this function.
        let _retained_block_buffer = if block_buffer.is_null() {
            None
        } else {
            Some(unsafe { CFRetained::from_raw(NonNull::new_unchecked(block_buffer)) })
        };

        let count = unsafe { (*list).mNumberBuffers as usize };
        if count == 0 {
            return None;
        }

        let first: *const AudioBuffer = unsafe { (*list).mBuffers.as_ptr() };
        let buffers = unsafe { slice::from_raw_parts(first, count) };

        let flags = asbd.mFormatFlags;
        let bits = asbd.mBitsPerChannel as usize;
        let is_float = flags & AUDIO_FORMAT_FLAG_IS_FLOAT != 0;
        let is_signed_integer = flags & AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER != 0;
        let is_big_endian = flags & AUDIO_FORMAT_FLAG_IS_BIG_ENDIAN != 0;
        let is_aligned_high = flags & AUDIO_FORMAT_FLAG_IS_ALIGNED_HIGH != 0;

        let bytes_per_sample = bits.div_ceil(8);
        if bytes_per_sample == 0 {
            return None;
        }

        let mut sum_squares = 0.0f64;
        let mut sample_count = 0usize;

        for buffer in buffers {
            if buffer.mData.is_null() || buffer.mDataByteSize == 0 {
                continue;
            }

            let bytes = unsafe {
                slice::from_raw_parts(
                    buffer.mData.cast::<u8>(),
                    buffer.mDataByteSize as usize,
                )
            };

            for chunk in bytes.chunks_exact(bytes_per_sample) {
                let sample = if is_float {
                    decode_float_sample(chunk, bits, is_big_endian)
                } else if is_signed_integer {
                    decode_signed_integer_sample(
                        chunk,
                        bits,
                        is_big_endian,
                        is_aligned_high,
                    )
                } else {
                    None
                };

                if let Some(sample) = sample.filter(|value| value.is_finite()) {
                    let sample = sample.clamp(-1.0, 1.0) as f64;
                    sum_squares += sample * sample;
                    sample_count += 1;
                }
            }
        }

        if sample_count == 0 {
            return None;
        }

        Some((sum_squares / sample_count as f64).sqrt() as f32)
    }

    fn decode_float_sample(bytes: &[u8], bits: usize, big_endian: bool) -> Option<f32> {
        match bits {
            32 if bytes.len() >= 4 => {
                let raw = [bytes[0], bytes[1], bytes[2], bytes[3]];
                Some(if big_endian {
                    f32::from_bits(u32::from_be_bytes(raw))
                } else {
                    f32::from_bits(u32::from_le_bytes(raw))
                })
            }
            64 if bytes.len() >= 8 => {
                let raw = [
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ];
                let value = if big_endian {
                    f64::from_bits(u64::from_be_bytes(raw))
                } else {
                    f64::from_bits(u64::from_le_bytes(raw))
                };
                Some(value as f32)
            }
            _ => None,
        }
    }

    fn decode_signed_integer_sample(
        bytes: &[u8],
        bits: usize,
        big_endian: bool,
        aligned_high: bool,
    ) -> Option<f32> {
        if bits == 0 || bits > 32 || bytes.is_empty() || bytes.len() > 4 {
            return None;
        }

        let mut raw = 0u32;
        if big_endian {
            for &byte in bytes {
                raw = (raw << 8) | byte as u32;
            }
        } else {
            for (index, &byte) in bytes.iter().enumerate() {
                raw |= (byte as u32) << (index * 8);
            }
        }

        let storage_bits = bytes.len() * 8;
        if aligned_high && storage_bits > bits {
            raw >>= storage_bits - bits;
        }

        let sign_bit = 1u32 << (bits - 1);
        let mask = if bits == 32 { u32::MAX } else { (1u32 << bits) - 1 };
        raw &= mask;

        let signed = if raw & sign_bit != 0 {
            (raw as i64) - (1i64 << bits)
        } else {
            raw as i64
        };

        let scale = sign_bit as f32;
        Some((signed as f32 / scale).clamp(-1.0, 1.0))
    }

    fn error_string(error: *mut NSError) -> String {
        if error.is_null() {
            return String::new();
        }
        unsafe { (&*error).localizedDescription().to_string() }
    }

    /// Convert ScreenCaptureKit's callback-based content enumeration into a
    /// blocking operation. The callback retains the object before transferring
    /// its raw pointer through the channel, and the receiving thread assumes
    /// that +1 retain count with Retained::from_raw.
    fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<usize, String>>(1);
        let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
            if !error.is_null() {
                let _ = tx.send(Err(error_string(error)));
                return;
            }
            if content.is_null() {
                let _ = tx.send(Err("ScreenCaptureKit returned no shareable content".into()));
                return;
            }

            // SAFETY: `content` is valid for the duration of the callback. Retain
            // it before sending the address to the waiting thread.
            let retained = unsafe { Retained::retain(content) };
            match retained {
                Some(retained) => {
                    let raw = Retained::into_raw(retained) as usize;
                    let _ = tx.send(Ok(raw));
                }
                None => {
                    let _ = tx.send(Err("failed to retain SCShareableContent".into()));
                }
            }
        });

        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                false,
                false,
                &block,
            );
        }

        let raw = rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| format!("ScreenCaptureKit content request timed out. {SCREEN_CAPTURE_PERMISSION_HINT}"))??;

        // SAFETY: The callback transferred a +1 retain count with into_raw.
        unsafe { Retained::from_raw(raw as *mut SCShareableContent) }
            .ok_or_else(|| "invalid SCShareableContent pointer".to_string())
    }

    fn wait_for_capture_completion(
        invoke: impl FnOnce(&DynBlock<dyn Fn(*mut NSError)>),
        operation: &str,
    ) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let completion = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err(error_string(error))
            };
            let _ = tx.send(result);
        });

        invoke(&completion);
        rx.recv_timeout(Duration::from_secs(20))
            .map_err(|_| format!("ScreenCaptureKit {operation} timed out"))?
    }

    pub fn list_sources() -> Vec<AudioSource> {
        let mut sources = vec![AudioSource {
            id: "sck:system".into(),
            label: "System Audio (all apps)".into(),
            pid: None,
            kind: AudioSourceKind::SystemLoopback,
        }];

        match shareable_content() {
            Ok(content) => unsafe {
                let applications = content.applications();
                for app in applications.to_vec() {
                    let name = app.applicationName().to_string();
                    let pid = app.processID() as u32;
                    if name.trim().is_empty() {
                        continue;
                    }
                    sources.push(AudioSource {
                        id: format!("sck:app:{pid}"),
                        label: name,
                        pid: Some(pid),
                        kind: AudioSourceKind::Application,
                    });
                }
            },
            Err(error) => {
                dbg_log(&format!("[sck] unable to enumerate applications: {error}"));
            }
        }

        let host = cpal::default_host();
        if let Ok(devices) = host.input_devices() {
            for device in devices {
                if let Ok(name) = device.name() {
                    sources.push(AudioSource {
                        id: format!("coreaudio:{name}"),
                        label: name,
                        pid: None,
                        kind: AudioSourceKind::InputDevice,
                    });
                }
            }
        }

        sources
    }

    pub fn start_capture(
        source_id: &str,
        peak: PeakHandle,
        app: AppHandle,
    ) -> Result<LoopbackSession, String> {
        let stop = Arc::new(AtomicBool::new(false));
        if source_id.starts_with("sck:") {
            start_sck_capture(source_id, peak, stop, app)
        } else {
            start_coreaudio_input(source_id, peak, stop)
        }
    }

    fn start_sck_capture(
        source_id: &str,
        peak: PeakHandle,
        stop: Arc<AtomicBool>,
        app: AppHandle,
    ) -> Result<LoopbackSession, String> {
        let pid = source_id
            .strip_prefix("sck:app:")
            .and_then(|value| value.parse::<u32>().ok());

        let (result_tx, result_rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let stop_thread = Arc::clone(&stop);
        let peak_thread = Arc::clone(&peak);
        let app_thread = app.clone();

        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                let content = shareable_content().map_err(|error| {
                    format!("Unable to access ScreenCaptureKit: {error}. {SCREEN_CAPTURE_PERMISSION_HINT}")
                })?;
                dbg_log(&format!(
                    "[sck] shareable content resolved; capture mode={}",
                    pid.map(|p| format!("app pid={p}")).unwrap_or_else(|| "system".to_string())
                ));

                let displays = unsafe { content.displays() };
                let display = displays
                    .firstObject()
                    .ok_or_else(|| "ScreenCaptureKit reported no displays".to_string())?;
                let empty_windows = NSArray::<SCWindow>::new();

                let filter = if let Some(target_pid) = pid {
                    let applications = unsafe { content.applications() };
                    let application = applications
                        .to_vec()
                        .into_iter()
                        .find(|app| unsafe { app.processID() as u32 == target_pid })
                        .ok_or_else(|| format!("application with pid {target_pid} is no longer available"))?;
                    let included = NSArray::<SCRunningApplication>::from_retained_slice(&[
                        application,
                    ]);
                    unsafe {
                        SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(
                            SCContentFilter::alloc(),
                            &display,
                            &included,
                            &empty_windows,
                        )
                    }
                } else {
                    unsafe {
                        SCContentFilter::initWithDisplay_excludingWindows(
                            SCContentFilter::alloc(),
                            &display,
                            &empty_windows,
                        )
                    }
                };

                let configuration = unsafe { SCStreamConfiguration::new() };
                unsafe {
                    configuration.setCapturesAudio(true);
                    configuration.setSampleRate(48_000);
                    configuration.setChannelCount(2);
                    configuration.setExcludesCurrentProcessAudio(true);
                    configuration.setWidth(2);
                    configuration.setHeight(2);
                    configuration.setShowsCursor(false);
                    configuration.setQueueDepth(3);
                }

                let output = AudioOutput::new(
                    app_thread,
                    peak_thread,
                    Arc::clone(&stop_thread),
                );
                let stream = unsafe {
                    SCStream::initWithFilter_configuration_delegate(
                        SCStream::alloc(),
                        &filter,
                        &configuration,
                        None,
                    )
                };
                let output_protocol: &ProtocolObject<dyn SCStreamOutput> =
                    ProtocolObject::from_ref(&*output);

                // Every known-working Apple sample (and every third-party example
                // we could find) hands addStreamOutput an explicit serial dispatch
                // queue for the audio sample handler rather than passing `nil`/None.
                // This queue must outlive the stream, so it's kept in this local
                // binding for the duration of the capture loop below (same pattern
                // as `output`, which is dropped only once capture has stopped).
                let sample_handler_queue =
                    DispatchQueue::new("com.kaleidomo.app.sck-audio", DispatchQueueAttr::SERIAL);

                unsafe {
                    stream
                        .addStreamOutput_type_sampleHandlerQueue_error(
                            output_protocol,
                            SCStreamOutputType::Audio,
                            Some(&sample_handler_queue),
                        )
                        .map_err(|error| error.localizedDescription().to_string())?;
                }
                dbg_log("[sck] audio stream output registered; starting capture");

                wait_for_capture_completion(
                    |completion| unsafe {
                        stream.startCaptureWithCompletionHandler(Some(completion));
                    },
                    "start",
                )
                .map_err(|error| format!("ScreenCaptureKit capture failed: {error}. {SCREEN_CAPTURE_PERMISSION_HINT}"))?;
                dbg_log("[sck] startCapture completed successfully; waiting for sample buffers");

                result_tx
                    .send(Ok(()))
                    .map_err(|_| "capture caller disconnected".to_string())?;

                while !stop_thread.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(50));
                }

                let _ = wait_for_capture_completion(
                    |completion| unsafe {
                        stream.stopCaptureWithCompletionHandler(Some(completion));
                    },
                    "stop",
                );

                // Keep the delegate alive until capture is stopped.
                drop(output);
                Ok(())
            })();

            if let Err(error) = result {
                let _ = result_tx.send(Err(error));
            }
        });

        result_rx
            .recv_timeout(Duration::from_secs(25))
            .map_err(|_| "ScreenCaptureKit thread exited before signalling".to_string())??;

        Ok(LoopbackSession { stop, pid })
    }

    fn start_coreaudio_input(
        source_id: &str,
        peak: PeakHandle,
        stop: Arc<AtomicBool>,
    ) -> Result<LoopbackSession, String> {
        let device_name = source_id
            .strip_prefix("coreaudio:")
            .unwrap_or(source_id)
            .to_owned();

        let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let stop_clone = Arc::clone(&stop);
        let stop_loop = Arc::clone(&stop);
        let peak_clone = Arc::clone(&peak);

        std::thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host
                .input_devices()
                .map_err(|error| error.to_string())
                .and_then(|mut devices| {
                    devices
                        .find(|device| {
                            device
                                .name()
                                .map(|name| name == device_name)
                                .unwrap_or(false)
                        })
                        .ok_or_else(|| format!("CoreAudio device '{device_name}' not found"))
                }) {
                Ok(device) => device,
                Err(error) => {
                    let _ = result_tx.send(Err(error));
                    return;
                }
            };
            let config = match device.default_input_config() {
                Ok(config) => config,
                Err(error) => {
                    let _ = result_tx.send(Err(error.to_string()));
                    return;
                }
            };

            let mut smoothed = 0f32;
            let stream = match device.build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    if stop_clone.load(Ordering::Relaxed) || data.is_empty() {
                        return;
                    }
                    let rms = (data.iter().map(|&sample| sample * sample).sum::<f32>()
                        / data.len() as f32)
                        .sqrt();
                    smoothed = smoothed * 0.9 + rms * 0.1;
                    store_peak(&peak_clone, smoothed * 2.0);
                },
                |error| eprintln!("[coreaudio/input] error: {error}"),
                None,
            ) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = result_tx.send(Err(error.to_string()));
                    return;
                }
            };

            if let Err(error) = stream.play() {
                let _ = result_tx.send(Err(error.to_string()));
                return;
            }
            let _ = result_tx.send(Ok(()));

            while !stop_loop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
        });

        result_rx
            .recv()
            .map_err(|_| "CoreAudio thread exited before signalling".to_string())??;

        Ok(LoopbackSession { stop, pid: None })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Linux (PipeWire / ALSA)
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    /// On Linux, PipeWire exposes monitor sources as regular ALSA input devices
    /// named "Monitor of <sink name>". cpal sees them automatically.
    pub fn list_sources() -> Vec<AudioSource> {
        let mut sources = Vec::new();
        let host = cpal::default_host();
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if let Ok(name) = d.name() {
                    let kind = if name.to_lowercase().contains("monitor") {
                        AudioSourceKind::SystemLoopback
                    } else {
                        AudioSourceKind::InputDevice
                    };
                    let label = if matches!(kind, AudioSourceKind::SystemLoopback) {
                        // Strip "Monitor of " prefix for cleaner display
                        name.strip_prefix("Monitor of ")
                            .map(|s| format!("System Audio ({})", s))
                            .unwrap_or_else(|| name.clone())
                    } else {
                        name.clone()
                    };
                    sources.push(AudioSource {
                        id: format!("alsa:{}", name),
                        label,
                        pid: None,
                        kind,
                    });
                }
            }
        }
        // If no monitor source was listed (ALSA without PipeWire),
        // suggest the user install PipeWire.
        if !sources.iter().any(|s| matches!(s.kind, AudioSourceKind::SystemLoopback)) {
            sources.insert(0, AudioSource {
                id: "pipewire_unavailable".into(),
                label: "⚠ Install PipeWire for system audio capture".into(),
                pid: None,
                kind: AudioSourceKind::SystemLoopback,
            });
        }
        sources
    }

    /// Start capturing the selected ALSA/PipeWire source.
    ///
    /// The stream is built *inside* the keepalive thread — see the module-level
    /// comment for why this is required (cpal::Stream is !Send).
    pub fn start_capture(
        source_id: &str,
        peak: PeakHandle,
        _app: AppHandle,
    ) -> Result<LoopbackSession, String> {
        if source_id == "pipewire_unavailable" {
            return Err("PipeWire is not available. Install pipewire and pipewire-alsa.".into());
        }

        let device_name = source_id.strip_prefix("alsa:").unwrap_or(source_id).to_owned();
        let stop = Arc::new(AtomicBool::new(false));
        // stop_ret is kept here for the LoopbackSession return value.
        // stop_clone goes into the data callback closure.
        // stop_loop goes into the keepalive while-loop inside the spawn.
        let stop_ret   = Arc::clone(&stop);
        let stop_clone = Arc::clone(&stop);
        let stop_loop  = Arc::clone(&stop);
        let peak_clone = Arc::clone(&peak);

        let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        // cpal::Stream is !Send — build it inside the thread that will own it.
        std::thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host.input_devices()
                .map_err(|e| e.to_string())
                .and_then(|mut devs| devs.find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
                    .ok_or_else(|| format!("ALSA device '{}' not found", device_name)))
            {
                Ok(d) => d,
                Err(e) => { let _ = result_tx.send(Err(e)); return; }
            };
            let config = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => { let _ = result_tx.send(Err(e.to_string())); return; }
            };

            let mut smoothed = 0f32;
            let stream = match device.build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    if stop_clone.load(Ordering::Relaxed) { return; }
                    let rms = (data.iter().map(|&s| s * s).sum::<f32>()
                        / data.len().max(1) as f32).sqrt();
                    smoothed = smoothed * 0.9 + rms * 0.1;
                    store_peak(&peak_clone, smoothed * 2.0);
                },
                |err| eprintln!("[pipewire/alsa] error: {err}"),
                None,
            ) {
                Ok(s) => s,
                Err(e) => { let _ = result_tx.send(Err(e.to_string())); return; }
            };

            if let Err(e) = stream.play() {
                let _ = result_tx.send(Err(e.to_string()));
                return;
            }

            let _ = result_tx.send(Ok(()));

            // Block here — stream stays on this thread.
            while !stop_loop.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            // stream drops here, on the thread that created it.
        });

        result_rx.recv()
            .map_err(|_| "ALSA thread exited before signalling".to_string())??;

        Ok(LoopbackSession { stop: stop_ret, pid: None })
    }
}

// ── Tauri state wrapper ───────────────────────────────────────────────────────

/// Held in `AppState` — wraps the active session and the shared peak.
pub struct LoopbackState {
    pub session: Mutex<Option<LoopbackSession>>,
    pub peak: PeakHandle,
}

impl LoopbackState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            peak: Arc::new(AtomicU32::new(0)),
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Return available system audio sources for the frontend dropdown.
/// The frontend calls this on mount (and optionally on refresh).
#[tauri::command]
pub fn list_loopback_sources() -> Vec<AudioSource> {
    platform::list_sources()
}

/// Begin capturing the selected source.
/// `source_id` is the `AudioSource.id` returned by `list_loopback_sources`.
/// Replaces any existing session. Returns an error string shown to the user.
#[tauri::command]
pub async fn start_loopback_capture(
    source_id: String,
    state: tauri::State<'_, LoopbackState>,
    app: AppHandle,
) -> Result<(), String> {
    // Stop any running session first.
    {
        let mut guard = state.session.lock().map_err(|_| "lock error")?;
        if let Some(old) = guard.take() {
            old.stop.store(true, Ordering::Relaxed);
        }
    }

    // Reset the peak so the UI doesn't show a stale value.
    state.peak.store(0f32.to_bits(), Ordering::Relaxed);

    let session = platform::start_capture(&source_id, Arc::clone(&state.peak), app)?;
    let mut guard = state.session.lock().map_err(|_| "lock error")?;
    *guard = Some(session);
    Ok(())
}

/// Stop capturing and release all resources.
#[tauri::command]
pub fn stop_loopback_capture(
    state: tauri::State<'_, LoopbackState>,
) -> Result<(), String> {
    let mut guard = state.session.lock().map_err(|_| "lock error")?;
    if let Some(s) = guard.take() {
        s.stop.store(true, Ordering::Relaxed);
    }
    state.peak.store(0f32.to_bits(), Ordering::Relaxed);
    Ok(())
}

/// Read the current smoothed peak (0.0–1.0).
/// The frontend polls this at ~30 fps when loopback is active and no audio
/// file is loaded, using the value as a substitute for the per-frame peaks array.
#[tauri::command]
pub fn get_loopback_peak(
    state: tauri::State<'_, LoopbackState>,
) -> f32 {
    read_peak(&state.peak)
}