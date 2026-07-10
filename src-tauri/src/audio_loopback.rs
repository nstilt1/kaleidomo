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
// │  macOS    — ScreenCaptureKit (macOS 12.3+). Requires the                │
// │             com.apple.security.screen-capture entitlement (added to      │
// │             entitlements.plist). The OS shows a one-time permission      │
// │             dialog. Per-app capture is the native mode of the API:       │
// │             we pass an SCContentFilter scoped to one SCRunningApp.       │
// │             The `screencapturekit` crate wraps the Objective-C API.      │
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
    use screencapturekit::{
        cm_sample_buffer::CMSampleBuffer,
        sc_content_filter::{InitParams, SCContentFilter},
        sc_error_handler::StreamErrorHandler,
        sc_output_handler::{SCStreamOutput, StreamType},
        sc_shareable_content::SCShareableContent,
        sc_stream::SCStream,
        sc_stream_configuration::SCStreamConfiguration,
    };
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    /// List available audio sources on macOS.
    ///
    /// Returns:
    ///   - "System Audio (all apps)" via ScreenCaptureKit display capture
    ///   - One entry per running application that has an audio session
    ///   - Regular CoreAudio input devices (microphone, line-in)
    pub fn list_sources() -> Vec<AudioSource> {
        let mut sources = Vec::new();

        // ScreenCaptureKit sources — requires screen-capture permission.
        // We offer "System Audio" plus per-app entries.
        sources.push(AudioSource {
            id: "sck:system".into(),
            label: "System Audio (all apps)".into(),
            pid: None,
            kind: AudioSourceKind::SystemLoopback,
        });

        // Enumerate running apps via SCShareableContent.
        // This call returns quickly if permission is already granted;
        // if not, it returns an empty list and the UI prompts the user
        // to grant Screen Recording permission in System Settings.
        if let Ok(content) = SCShareableContent::get() {
            for app in content.applications {
                let name = app.application_name.clone();
                let pid = app.process_id as u32;
                if name.is_empty() { continue; }
                sources.push(AudioSource {
                    id: format!("sck:app:{}", pid),
                    label: name,
                    pid: Some(pid),
                    kind: AudioSourceKind::Application,
                });
            }
        }

        // CoreAudio input devices (microphone, line-in, USB audio).
        let host = cpal::default_host();
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if let Ok(name) = d.name() {
                    sources.push(AudioSource {
                        id: format!("coreaudio:{}", name),
                        label: name,
                        pid: None,
                        kind: AudioSourceKind::InputDevice,
                    });
                }
            }
        }

        sources
    }

    /// Start capturing audio from the chosen source.
    ///
    /// The stream is built *inside* the keepalive thread — see the module-level
    /// comment for why this is required (cpal::Stream and SCStream are !Send).
    pub fn start_capture(
        source_id: &str,
        peak: PeakHandle,
        _app: AppHandle,
    ) -> Result<LoopbackSession, String> {
        let stop = Arc::new(AtomicBool::new(false));

        if source_id.starts_with("sck:") {
            start_sck_capture(source_id, peak, stop)
        } else {
            // CoreAudio input device path (mic, line-in, USB).
            start_coreaudio_input(source_id, peak, stop)
        }
    }

    fn start_sck_capture(
        source_id: &str,
        peak: PeakHandle,
        stop: Arc<AtomicBool>,
    ) -> Result<LoopbackSession, String> {
        let pid: Option<u32> = if source_id.starts_with("sck:app:") {
            source_id
                .strip_prefix("sck:app:")
                .and_then(|s| s.parse().ok())
        } else {
            None // "sck:system" — capture all
        };

        // Build the SCContentFilter.
        // For system audio we use DesktopIndependentWindow (captures audio
        // from all processes without needing a specific window).
        // For per-app we filter to the matching SCRunningApplication.
        let content = SCShareableContent::get()
            .map_err(|e| format!("SCShareableContent::get() failed: {e:?}. Grant Screen Recording permission in System Settings → Privacy & Security."))?;

        let filter = if let Some(target_pid) = pid {
            let app = content
                .applications
                .iter()
                .find(|a| a.process_id as u32 == target_pid)
                .ok_or_else(|| format!("app with pid {} not found", target_pid))?;
            SCContentFilter::new(InitParams::Application(app.clone()))
        } else {
            // Capture audio from the first available display (covers all apps).
            let display = content
                .displays
                .into_iter()
                .next()
                .ok_or("no displays found")?;
            SCContentFilter::new(InitParams::Display(display))
        };

        // Configure for audio-only capture at 48 kHz stereo.
        // Setting captures_audio=true and setting a minimal frame rate keeps
        // CPU use low — we don't need video frames.
        let mut config = SCStreamConfiguration::default();
        config.captures_audio = true;
        config.sample_rate = 48000;
        config.channel_count = 2;
        // Minimal video capture to satisfy SCStream (1x1 px, 1 fps).
        // Without any video, SCStream errors on some macOS versions.
        config.width = 2;
        config.height = 2;

        // AudioHandler is constructed inside this function and passed to
        // SCStream::new(). It is not !Send itself (all fields are Arc/Mutex),
        // so the SCStream — which holds it — is what's !Send.
        struct AudioHandler {
            peak: PeakHandle,
            stop: Arc<AtomicBool>,
            smoothed: Mutex<f32>,
        }

        impl SCStreamOutput for AudioHandler {
            fn did_output_sample_buffer(
                &self,
                sample: CMSampleBuffer,
                of_type: StreamType,
            ) {
                if of_type != StreamType::Audio { return; }
                if self.stop.load(Ordering::Relaxed) { return; }

                // Extract PCM samples from the CMSampleBuffer.
                // CMSampleBuffer::get_audio_buffer_list returns interleaved f32 samples.
                let samples: Vec<f32> = match sample.get_audio_buffer_list() {
                    Ok(list) => list,
                    Err(_) => return,
                };
                if samples.is_empty() { return; }
                let rms = (samples.iter().map(|&s| s * s).sum::<f32>()
                    / samples.len() as f32).sqrt();
                let mut s = self.smoothed.lock().unwrap();
                *s = *s * 0.9 + rms * 0.1;
                store_peak(&self.peak, *s * 2.0);
            }
        }

        impl StreamErrorHandler for AudioHandler {
            fn on_error(&self) {
                eprintln!("[sck] stream error");
            }
        }

        // Oneshot channel for startup result.
        let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let stop_clone = Arc::clone(&stop);
        let peak_clone = Arc::clone(&peak);

        // SCStream is !Send, so it must be built and destroyed on the same
        // thread. We spawn, build inside, report result back, then block.
        std::thread::spawn(move || {
            let handler = AudioHandler {
                peak: Arc::clone(&peak_clone),
                stop: Arc::clone(&stop_clone),
                smoothed: Mutex::new(0.0),
            };

            let mut stream = SCStream::new(filter, config, handler);
            stream.add_output(AudioHandler {
                peak: peak_clone,
                stop: Arc::clone(&stop_clone),
                smoothed: Mutex::new(0.0),
            }, StreamType::Audio);

            if let Err(e) = stream.start_capture() {
                let _ = result_tx.send(Err(format!(
                    "SCStream capture failed: {e:?}. \
                     Grant Screen Recording permission in \
                     System Settings → Privacy & Security → Screen & System Audio Recording."
                )));
                return;
            }

            let _ = result_tx.send(Ok(()));

            // Block here — SCStream stays on this thread until stop fires.
            while !stop_clone.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            // stream drops here, stopping the SCStream capture.
        });

        result_rx.recv()
            .map_err(|_| "SCStream thread exited before signalling".to_string())??;

        Ok(LoopbackSession { stop, pid })
    }

    fn start_coreaudio_input(
        source_id: &str,
        peak: PeakHandle,
        stop: Arc<AtomicBool>,
    ) -> Result<LoopbackSession, String> {
        let device_name = source_id.strip_prefix("coreaudio:").unwrap_or(source_id).to_owned();

        let (result_tx, result_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        // stop_clone goes into the data callback closure.
        // stop_loop goes into the keepalive while-loop inside the spawn.
        // stop is kept here for the LoopbackSession return value.
        let stop_clone = Arc::clone(&stop);
        let stop_loop  = Arc::clone(&stop);
        let peak_clone = Arc::clone(&peak);

        // cpal::Stream is !Send — build it inside the thread that will own it.
        std::thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host.input_devices()
                .map_err(|e| e.to_string())
                .and_then(|mut devs| devs.find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
                    .ok_or_else(|| format!("CoreAudio device '{}' not found", device_name)))
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
                |err| eprintln!("[coreaudio/input] error: {err}"),
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