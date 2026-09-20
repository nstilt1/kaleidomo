// src-tauri/src/ffmpeg_sink.rs
//! FFmpeg-sidecar-backed implementation of `kaleidomo_core::VideoFrameSink`.
//!
//! This is the only place in the application that knows how to talk to the
//! bundled FFmpeg sidecar for *video encoding*. `kaleidomo-core` just calls
//! `write_rgba_frame`/`finish` on whatever sink it's handed and stays
//! completely unaware of Tauri, FFmpeg, or file paths — see
//! `kaleidomo-core/src/video_sink.rs` for the trait this implements.
//!
//! Frames are streamed to FFmpeg over its stdin as raw RGBA8
//! (`-f rawvideo -pixel_format rgba`); FFmpeg encodes with `libopenh264`
//! (the only H.264 encoder available in this project's FFmpeg build — see
//! `build-ffmpeg-macos.sh`, which is `--disable-gpl`, ruling out `libx264`)
//! and, when audio is supplied, muxes it in as AAC in the same pass.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use kaleidomo_core::{VideoFrameSink, VideoSinkError};
use tauri::AppHandle;
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::{log_info, log_warn};

/// How often (in frames) `write_rgba_frame` logs its own throughput. This is
/// the *feeding* side of the pipeline — how fast kaleidomo-core is producing
/// frames and handing them to ffmpeg's stdin — independent of whatever
/// ffmpeg's own stderr progress line says about its *encoding* throughput.
/// Comparing the two tells you which side of the pipeline is the bottleneck.
const FRAME_LOG_INTERVAL: u64 = 30;

/// Cap on how much ffmpeg stderr text we retain for error reporting, so a
/// very chatty ffmpeg build can't grow this unbounded while we drain it in
/// the background.
const STDERR_TAIL_LIMIT: usize = 16 * 1024;

/// Outcome of the ffmpeg process, delivered by the background event-pump
/// task once ffmpeg exits (or the shell plugin reports a fatal error before
/// that, e.g. failure to launch).
enum FfmpegOutcome {
    Success,
    Failure(String),
}

/// Streams RGBA frames to the bundled FFmpeg sidecar over its stdin and
/// finalizes an MP4 on `finish()`.
pub struct FfmpegSink {
    app: AppHandle,
    child: Option<CommandChild>,
    outcome_rx: Option<std::sync::mpsc::Receiver<FfmpegOutcome>>,
    stderr_tail: Arc<Mutex<String>>,
    width: u32,
    height: u32,
    temp_path: PathBuf,
    final_path: PathBuf,
    /// Set once `finish()` has successfully moved the temp file into place,
    /// so `Drop` knows not to kill an already-finished process or delete an
    /// output file that's no longer a temp file.
    finished_ok: bool,
    frames_written: u64,
    total_frames: u64,
    last_emitted_percent: u8,
    started_at: Instant,
}

impl FfmpegSink {
    /// Spawns the bundled ffmpeg sidecar wired up to receive raw RGBA8
    /// frames on stdin, encode them with `libopenh264`, optionally mux in
    /// `audio_path` as AAC, and write the result to a temporary path next
    /// to `final_path` (renamed into place on success by `finish`).
    ///
    /// `bitrate_bps` should be computed by the caller the same way the
    /// prior `openh264`-based pipeline did
    /// (`output_w * output_h * fps * quality`), so exported video quality
    /// is unchanged by this refactor.
    pub fn create(
        app: &AppHandle,
        final_path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_bps: u32,
        audio_path: Option<&Path>,
        total_frames: u64,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("width and height must be non-zero".into());
        }
        if fps == 0 {
            return Err("fps must be non-zero".into());
        }

        let temp_path = {
            let mut p = final_path.to_path_buf();
            let file_name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("output.mp4")
                .to_string();
            p.set_file_name(format!("{file_name}.encoding.mp4"));
            p
        };
        // Don't inherit a stale partial file from a previous failed run.
        let _ = std::fs::remove_file(&temp_path);

        let video_size = format!("{width}x{height}");
        // One keyframe per second, matching the previous
        // `IntraFramePeriod::from_num_frames(fps)` setting.
        let gop = fps.to_string();
        let bitrate = bitrate_bps.to_string();
        let bufsize = bitrate_bps.saturating_mul(2).to_string();
        let temp_path_str = temp_path.to_string_lossy().to_string();

        let mut args: Vec<String> = vec![
            "-y".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pixel_format".into(),
            "rgba".into(),
            "-video_size".into(),
            video_size,
            "-framerate".into(),
            fps.to_string(),
            "-i".into(),
            "pipe:0".into(),
        ];

        if let Some(audio_path) = audio_path {
            args.push("-i".into());
            args.push(audio_path.to_string_lossy().to_string());
            args.push("-map".into());
            args.push("0:v:0".into());
            args.push("-map".into());
            args.push("1:a:0".into());
        } else {
            args.push("-an".into());
        }

        args.extend([
            "-c:v".into(),
            "libopenh264".into(),
            "-rc_mode".into(),
            "bitrate".into(),
            "-b:v".into(),
            bitrate.clone(),
            "-maxrate".into(),
            bitrate,
            "-bufsize".into(),
            bufsize,
            "-g".into(),
            gop,
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);

        if audio_path.is_some() {
            args.extend([
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
                "-ar".into(),
                "48000".into(),
                "-ac".into(),
                "2".into(),
                // Matches the prior two-pass behavior: output duration is
                // bounded by the shorter of the rendered video and the
                // supplied audio.
                "-shortest".into(),
            ]);
        }

        args.extend([
            "-movflags".into(),
            "+faststart".into(),
            "-f".into(),
            "mp4".into(),
            temp_path_str,
        ]);

        let command = app
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("Failed to load bundled FFmpeg sidecar: {e}"))?
            .args(args.clone());

        log_info!("[ffmpeg_sink] spawning: ffmpeg {}", args.join(" "));

        let (mut rx, child) = command
            .spawn()
            .map_err(|e| format!("Failed to spawn bundled FFmpeg sidecar: {e}"))?;

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_tail_pump = Arc::clone(&stderr_tail);
        let (outcome_tx, outcome_rx) = std::sync::mpsc::channel::<FfmpegOutcome>();

        // Drain ffmpeg's stdout/stderr continuously so its pipes never fill
        // up and block ffmpeg while we're mid-stream writing frames to its
        // stdin — an unconsumed stderr pipe filling up would otherwise
        // deadlock (ffmpeg blocked writing stderr, us blocked writing
        // stdin). This task also is how we learn ffmpeg's final exit
        // status without polling.
        tauri::async_runtime::spawn(async move {
            let mut sent = false;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stderr(bytes) => {
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        // Surface ffmpeg's own progress ("frame=123 fps=45
                        // ...") live, not just on failure — this is a
                        // no-op unless built with `--features logging`.
                        log_info!("[ffmpeg stderr] {}", text.trim_end());
                        if let Ok(mut tail) = stderr_tail_pump.lock() {
                            tail.push_str(&text);
                            tail.push('\n');
                            let len = tail.len();
                            if len > STDERR_TAIL_LIMIT {
                                let start = len - STDERR_TAIL_LIMIT;
                                *tail = tail[start..].to_string();
                            }
                        }
                    }
                    CommandEvent::Error(err) => {
                        log_warn!("[ffmpeg_sink] shell error: {err}");
                        if !sent {
                            sent = true;
                            let _ = outcome_tx.send(FfmpegOutcome::Failure(err));
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        log_info!(
                            "[ffmpeg_sink] ffmpeg terminated: code={:?} signal={:?}",
                            payload.code, payload.signal
                        );
                        if !sent {
                            sent = true;
                            let ok = payload.code == Some(0);
                            let outcome = if ok {
                                FfmpegOutcome::Success
                            } else {
                                FfmpegOutcome::Failure(format!(
                                    "ffmpeg exited with code {:?} (signal {:?})",
                                    payload.code, payload.signal
                                ))
                            };
                            let _ = outcome_tx.send(outcome);
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(Self {
            app: app.clone(),
            child: Some(child),
            outcome_rx: Some(outcome_rx),
            stderr_tail,
            width,
            height,
            temp_path,
            final_path: final_path.to_path_buf(),
            finished_ok: false,
            frames_written: 0,
            total_frames: total_frames.max(1),
            last_emitted_percent: 0,
            started_at: Instant::now(),
        })
    }

    fn stderr_snapshot(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn cleanup_temp(&self) {
        let _ = std::fs::remove_file(&self.temp_path);
    }
}

impl VideoFrameSink for FfmpegSink {
    fn write_rgba_frame(&mut self, rgba: &[u8]) -> Result<(), VideoSinkError> {
        let expected = (self.width as usize) * (self.height as usize) * 4;
        if rgba.len() != expected {
            return Err(format!(
                "invalid RGBA buffer length: got {}, expected {}",
                rgba.len(),
                expected
            )
            .into());
        }

        let child = match self.child.as_mut() {
            Some(c) => c,
            None => return Err("ffmpeg process is no longer available".into()),
        };

        // `CommandChild::write` uses `write_all` internally, so partial
        // stdin writes are already handled — this call blocks until the
        // whole frame is accepted by the pipe, which is also what gives us
        // backpressure against ffmpeg's own encode throughput without a
        // separate bounded channel.
        if let Err(e) = child.write(rgba) {
            let stderr = self.stderr_snapshot();
            self.cleanup_temp();
            return Err(format!(
                "Failed to write frame to ffmpeg stdin: {e}\n\nffmpeg stderr:\n{stderr}"
            )
            .into());
        }

        self.frames_written += 1;
        let percent = ((self.frames_written.saturating_mul(100) / self.total_frames)
            .min(100)) as u8;
        if percent != self.last_emitted_percent {
            self.last_emitted_percent = percent;
            let _ = self.app.emit(
                "kd://video-export-progress",
                serde_json::json!({
                    "currentFrame": self.frames_written,
                    "totalFrames": self.total_frames,
                    "percent": percent,
                }),
            );
        }
        if self.frames_written % FRAME_LOG_INTERVAL == 0 {
            let elapsed = self.started_at.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 {
                self.frames_written as f64 / elapsed
            } else {
                0.0
            };
            log_info!(
                "[ffmpeg_sink] fed {} frames to ffmpeg in {:.1}s ({:.1} fps feed rate)",
                self.frames_written, elapsed, fps
            );
        }

        Ok(())
    }

    fn finish(&mut self) -> Result<(), VideoSinkError> {
        // Closing stdin — by dropping the child, which drops its stdin pipe
        // writer — is how ffmpeg knows the raw video stream is complete and
        // it should finalize encoding/muxing and exit.
        self.child.take();

        let outcome_rx = match self.outcome_rx.take() {
            Some(rx) => rx,
            None => return Err("ffmpeg was already finalized".into()),
        };

        let outcome = outcome_rx.recv().map_err(|_| {
            "ffmpeg's event channel closed before it reported an exit status".to_string()
        })?;

        match outcome {
            FfmpegOutcome::Success => {
                std::fs::rename(&self.temp_path, &self.final_path).map_err(|e| {
                    format!(
                        "ffmpeg finished successfully but the output could not be moved into place: {e}"
                    )
                })?;
                self.finished_ok = true;
                Ok(())
            }
            FfmpegOutcome::Failure(msg) => {
                let stderr = self.stderr_snapshot();
                self.cleanup_temp();
                Err(format!("FFmpeg video encoding failed: {msg}\n\nffmpeg stderr:\n{stderr}").into())
            }
        }
    }
}

impl Drop for FfmpegSink {
    fn drop(&mut self) {
        // If the sink is dropped without `finish()` having completed
        // successfully (e.g. an error propagated out of the render loop via
        // `?` before `finish` was reached), make sure ffmpeg doesn't keep
        // running in the background and don't leave a half-written temp
        // file behind.
        if !self.finished_ok {
            if let Some(child) = self.child.take() {
                let _ = child.kill();
            }
            self.cleanup_temp();
        }
    }
}
