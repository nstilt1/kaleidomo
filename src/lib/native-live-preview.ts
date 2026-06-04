/**
 * native-live-preview.ts
 *
 * Native macOS live preview via Tauri/wgpu/Metal.
 *
 * The Rust command returns raw RGBA bytes (tauri::ipc::Response), received as
 * ArrayBuffer. We draw to canvas via putImageData — no PNG, no base64.
 *
 * Wire format from Rust (live_preview.rs):
 *   [0..4]  width  LE u32
 *   [4..8]  height LE u32
 *   [8..]   raw RGBA pixels
 *
 * Audio reactivity
 * ----------------
 * Mirrors the WASM render_one_frame logic from wasm.rs exactly:
 *  - Reads per-frame normalised peak from a pre-built peaks array, indexed
 *    by the audio element's currentTime so playback stays in sync.
 *  - Applies exponential smoothing (audioPeakSmoothing).
 *  - Ratchet accumulator: only the *rising edge* of the smoothed peak
 *    advances accumulated_orientation_offset, making beats irreversibly pump
 *    the triangle's position around the hero circle.
 *  - audio_orientation_amount → transient per-frame wobble.
 *  - orientation_peak_multiplier → scales how much each rising edge adds.
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function isTauriMacOS(): boolean {
  const hasTauri =
    typeof window !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    !!(window as any).__TAURI_INTERNALS__;
  if (!hasTauri) return false;
  const platform = typeof navigator !== "undefined" ? navigator.platform ?? "" : "";
  return (
    platform.startsWith("Mac") ||
    (typeof navigator !== "undefined" &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator as any).userAgentData?.platform === "macOS")
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NativeLivePreviewParams {
  // Base kaleidoscope
  count: number;
  outputSizeW: number;
  outputSizeH: number;
  offsetX: number;
  offsetY: number;
  zoom: number;
  tileCount: number;
  x: number;
  y: number;
  rotation: number;
  kaleidoType: string;
  hueRotation: number;
  imgWidth: number;
  imgHeight: number;
  // Animation
  animationDuration: number;
  fps: number;
  rotationRange: number;
  rotationCycles: number;
  rotationStartOffset: number;
  rotationFn: string;
  hueRange: number;
  hueCycles: number;
  hueStartOffset: number;
  hueFn: string;
  zoomMax: number;
  zoomMin: number;
  zoomFn: string;
  zoomStartOffset: number;
  numZoomLoops: number;
  // Orientation
  orientationBaseSpeed: number;
  heroCircleLeftX: number;
  heroCircleRightX: number;
  heroCircleY: number;
  heroDesiredLeftRotation: number;
  // Audio-reactive
  audioReactiveEnabled: boolean;
  audioPeakSmoothing: number;
  audioOrientationAmount: number;
  audioReorientationAmount: number;
  orientationPeakMultiplier: number;
}

interface FrameParams {
  count: number;
  outputSizeW: number;
  outputSizeH: number;
  offsetX: number;
  offsetY: number;
  zoom: number;
  tileCount: number;
  x: number;
  y: number;
  rotation: number;
  kaleidoType: string;
  hueRotation: number;
  imgWidth: number;
  imgHeight: number;
  jpegQuality: number;
}

// ---------------------------------------------------------------------------
// Modulation — mirrors wasm.rs modulation module
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function modulateByTime(
  elapsedSeconds: number,
  range: number,
  minValue: number,
  cyclesPerSecond: number,
  startOffset: number,
  fnName: string,
): number {
  const phase = elapsedSeconds * cyclesPerSecond + startOffset;
  const p = ((phase % 1) + 1) % 1;
  let t: number;
  switch (fnName.toLowerCase()) {
    case "linear": case "saw": case "sawtooth": t = p; break;
    case "triangle": t = p < 0.5 ? p * 2 : 2 - p * 2; break;
    case "sin":  t = Math.sin(phase * TAU) * 0.5 + 0.5; break;
    case "sin2": t = Math.sin(phase * TAU) ** 2; break;
    case "-cos": case "negcos": t = 0.5 - 0.5 * Math.cos(phase * TAU); break;
    case "cos":  t = (Math.cos(phase * TAU) + 1) * 0.5; break;
    default:     t = p;
  }
  return minValue + range * t;
}

function modulateHue(
  elapsedSeconds: number,
  animationDuration: number,
  fps: number,
  hueRange: number,
  hueCycles: number,
  hueStartOffset: number,
  hueFn: string,
  baseHue: number,
): number {
  const frame = Math.floor(elapsedSeconds * Math.max(1, fps));
  const elapsed = frame / Math.max(1, fps);
  const phaseBase = elapsed / Math.max(0.001, animationDuration);
  const phase = phaseBase * hueCycles + hueStartOffset;
  const p = ((phase % 1) + 1) % 1;
  let t: number;
  switch (hueFn.toLowerCase()) {
    case "triangle": t = 1 - Math.abs(2 * p - 1); break;
    case "sawtooth": case "linear": case "saw": t = p; break;
    case "sin":  t = (Math.sin(phase * TAU) + 1) * 0.5; break;
    case "sin2": t = Math.sin(phase * TAU) ** 2; break;
    case "cos":  t = (Math.cos(phase * TAU) + 1) * 0.5; break;
    case "-cos": t = (1 - Math.cos(phase * TAU)) * 0.5; break;
    default:     t = p;
  }
  return Math.round(((baseHue + t * hueRange) % 360 + 360) % 360);
}

function orientationToHeroParams(
  value: number,
  leftX: number, rightX: number, centerY: number,
  desiredLeftRotation: number,
): { x: number; y: number; rotation: number } {
  const centerX = (leftX + rightX) * 0.5;
  const radius  = (rightX - leftX) * 0.5;
  const angle   = Math.PI + value * TAU;
  return {
    x:        centerX + Math.cos(angle) * radius,
    y:        centerY + Math.sin(angle) * radius,
    rotation: desiredLeftRotation + (angle - Math.PI),
  };
}

// ---------------------------------------------------------------------------
// Canvas draw
// ---------------------------------------------------------------------------

/** Draw a JPEG Blob to canvas via createImageBitmap.
 *  The Blob lives in browser-process memory (outside JSC heap).
 *  The ImageBitmap lives in GPU compositor memory (outside JSC heap).
 *  Zero JSC heap allocation per frame. */
async function drawJpegBlobToCanvas(
  canvas: HTMLCanvasElement,
  blob: Blob,
): Promise<void> {
  const bitmap = await createImageBitmap(blob);

  try {
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }

    const ctx = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });

    if (!ctx) {
      return;
    }

    ctx.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class NativeLivePreviewEngine {
  private _running    = false;
  private _inFlight   = false;
  private _rafId: number | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _onError: ((msg: string) => void) | null = null;

  // WebSocket transport
  private _ws: WebSocket | null = null;
  private _wsPort = 0;
  private _wsReady = false;

  // Current base settings
  private _base: NativeLivePreviewParams | null = null;
  // Animation clock (ms, set on first tick)
  private _startedAtMs = 0;
  private _lastFrameMs = 0;

  // Audio
  private _audioEl: HTMLAudioElement | null = null;
  private _peaks: Float32Array | null = null;      // normalised, one per video-frame
  // Per-engine smoothing state (mirrors wasm.rs EngineState)
  private _smoothedPeak = 0;
  private _accumulatedOrientationOffset = 0;
  private _frameCount = 0;

  // ── Public API ────────────────────────────────────────────────────────────

  setCanvas(canvas: HTMLCanvasElement): this {
    this._canvas = canvas;
    return this;
  }

  onError(cb: (msg: string) => void): this {
    this._onError = cb;
    return this;
  }

  /** Provide the HTMLAudioElement so we can read currentTime for peak sync. */
  setAudioElement(el: HTMLAudioElement | null): void {
    this._audioEl = el;
  }

  /** Supply new normalised peaks (one f32 per video frame). */
  setPeaks(peaks: Float32Array): void {
    this._peaks = peaks;
    // Don't reset smoothing state — let it converge naturally
  }

  start(): void {
    this._running    = true;
    this._startedAtMs = 0;
    this._lastFrameMs = 0;
    this._smoothedPeak = 0;
    this._accumulatedOrientationOffset = 0;
    this._frameCount = 0;
    // Connect WebSocket; schedule loop once connected
    this._connectWs();
  }

  private _connectWs(): void {
    if (this._wsPort === 0) {
      invoke<number>("get_preview_ws_port")
        .then((port) => { this._wsPort = port; this._openWs(); })
        .catch((e) => this._onError?.(`Failed to get WS port: ${String(e)}`));
    } else {
      this._openWs();
    }
  }

  private _openWs(): void {
    const ws = new WebSocket(`ws://127.0.0.1:${this._wsPort}`);
    ws.binaryType = "blob"; // frames arrive as Blobs — outside JSC heap
    this._ws = ws;
    this._wsReady = false;

    ws.onopen = () => {
      this._wsReady = true;
      if (this._running) this._schedule();
    };

    ws.onmessage = async (event) => {
      try {
        if (
          this._running &&
          this._canvas &&
          event.data instanceof Blob &&
          event.data.size > 0
        ) {
          await drawJpegBlobToCanvas(this._canvas, event.data);
        }
      } catch (e) {
        console.error("[native-preview] draw error:", e);
      } finally {
        this._inFlight = false;
        if (this._running) {
          this._schedule();
        }
      }
    };

    ws.onerror = () => { this._wsReady = false; };

    ws.onclose = () => {
      this._wsReady = false;
      if (this._running) setTimeout(() => { if (this._running) this._openWs(); }, 500);
    };
  }

  stop(): void {
    this._running = false;
    this._inFlight = false;

    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    if (this._ws) {
      const ws = this._ws;
      this._ws = null;

      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;

      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "preview stopped");
        }
      } catch {
        // ignored
      }
    }

    this._wsReady = false;
  }

  /** Update base settings — animation clock keeps running. */
  pushParams(base: NativeLivePreviewParams): void {
    this._base = base;
    if (!this._inFlight && this._running && this._rafId === null) {
      this._schedule();
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _schedule(): void {
    if (!this._running || this._rafId !== null) return;
    this._rafId = requestAnimationFrame((nowMs) => {
      this._rafId = null;
      this._tick(nowMs);
    });
  }

  private _tick(nowMs: number): void {
    if (!this._running) return;
    const base = this._base;
    if (!base) { this._schedule(); return; }

    if (this._startedAtMs === 0) {
      this._startedAtMs = nowMs;
      this._lastFrameMs = nowMs;
    }
    if (this._inFlight) { this._schedule(); return; }

    const targetFps = Math.min(Math.max(1, base.fps), 30);
    const minFrameMs = 1000 / targetFps;
    const sinceLastMs = nowMs - this._lastFrameMs;
    if (sinceLastMs < minFrameMs) {
      this._schedule();
      return;
    }
    this._lastFrameMs = nowMs;

    const animElapsed = (nowMs - this._startedAtMs) / 1000;
    const params = this._buildFrame(base, animElapsed);

    // Log any NaN/Infinity in params before sending to Rust — these cause silent crashes
    const badKeys = (Object.keys(params) as (keyof FrameParams)[]).filter(k => {
      const v = params[k];
      return typeof v === "number" && !isFinite(v);
    });
    if (badKeys.length > 0) {
      console.error("[native-preview] Non-finite params detected — aborting frame:", badKeys.map(k => `${k}=${String(params[k])}`).join(", "), { animElapsed, acc: this._accumulatedOrientationOffset, params });
      if (this._running) this._schedule();
      return;
    }

    // Heartbeat log every 300 frames
    this._frameCount = (this._frameCount ?? 0) + 1;
    if (this._frameCount % 300 === 1) {
      console.log(`[native-preview] frame=${this._frameCount} t=${animElapsed.toFixed(2)}s acc=${this._accumulatedOrientationOffset.toFixed(4)} x=${params.x.toFixed(1)} y=${params.y.toFixed(1)}`);
    }

    if (!this._wsReady || !this._ws) {
      this._schedule();
      return;
    }

    // Send frame request as JSON. Response arrives in ws.onmessage as a JPEG Blob
    // — outside JSC heap. _inFlight is cleared there.
    this._inFlight = true;
    try {
      this._ws.send(JSON.stringify(params));
    } catch (e) {
      this._inFlight = false;
      console.error("[native-preview] ws.send error:", e);
      if (this._running) this._schedule();
    }
  }

  private _buildFrame(base: NativeLivePreviewParams, animElapsed: number): FrameParams {
    const animDur = Math.max(0.001, base.animationDuration);

    // ── standard animation modulation ─────────────────────────────────────
    const zoomFactor = modulateByTime(
      animElapsed, base.zoomMax - base.zoomMin, base.zoomMin,
      base.numZoomLoops / animDur, base.zoomStartOffset, base.zoomFn,
    );
    const rotOffset = modulateByTime(
      animElapsed, base.rotationRange * (Math.PI / 180), 0,
      base.rotationCycles / animDur, base.rotationStartOffset, base.rotationFn,
    );
    const hueRotation = modulateHue(
      animElapsed, animDur, base.fps,
      base.hueRange, base.hueCycles, base.hueStartOffset, base.hueFn,
      base.hueRotation,
    );

    // ── audio-reactive peak ───────────────────────────────────────────────
    // Every rendered frame, the smoothed peak is permanently added to the
    // orientation accumulator (scaled by orientationPeakMultiplier).
    // This means orientation only ever moves forward — beats pump it ahead,
    // silence lets it sit still.
    //
    // Example: peaks [0,1,2,1,1,0,3], multiplier=1 → acc [0,1,3,4,5,5,8]
    //
    // Note: audioOrientationAmount is NOT used here — that was a transient
    // wobble term that caused visible pulsing even with multiplier=0.
    // All audio-driven orientation now flows through the accumulator only.
    let audioPeak = 0;
    if (base.audioReactiveEnabled && this._peaks && this._peaks.length > 0) {
      const playbackSec = this._audioEl?.currentTime ?? animElapsed;
      const peakFps = Math.max(1, base.fps);
      const frameIdx = Math.floor(playbackSec * peakFps) % this._peaks.length;
      const rawPeak = this._peaks[frameIdx] ?? 0;
      const smoothing = Math.min(0.999, Math.max(0, base.audioPeakSmoothing));
      this._smoothedPeak = this._smoothedPeak * smoothing + rawPeak * (1 - smoothing);
      audioPeak = Math.min(1, Math.max(0, this._smoothedPeak));
    } else {
      this._smoothedPeak = 0;
    }

    // Accumulate peak energy as circle-fractions per second (frame-rate independent).
    // orientationPeakMultiplier=1 means: 1 full circle traversed per second of peak=1 signal.
    // Dividing by fps converts per-frame accumulation to per-second.
    // Wrap mod 1.0 to keep floats small and prevent precision loss over long sessions.
    const renderFps = Math.max(1, base.fps);
    this._accumulatedOrientationOffset =
      (this._accumulatedOrientationOffset + audioPeak * base.orientationPeakMultiplier / renderFps) % 1;

    // ── orientation / hero circle ─────────────────────────────────────────
    // orientationBaseSpeed is in pixels/second of arc along the hero circle.
    // Convert to circle-fractions: circleSpeedCyclesPerSec = px/s / (2π * radius)
    const heroRadius = Math.max(1, (base.heroCircleRightX - base.heroCircleLeftX) * 0.5);
    const baseSpeedCycles = base.orientationBaseSpeed / (2 * Math.PI * heroRadius);
    const rawOrientationValue =
      (animElapsed * baseSpeedCycles) % 1
      + this._accumulatedOrientationOffset;
    const orientationValue = rawOrientationValue % 1;

    const useOrientation =
      base.orientationBaseSpeed !== 0 ||
      (base.audioReactiveEnabled && this._accumulatedOrientationOffset !== 0);

    let x = base.x, y = base.y;
    let finalRotation = base.rotation + rotOffset;

    if (useOrientation) {
      const hero = orientationToHeroParams(
        orientationValue,
        base.heroCircleLeftX, base.heroCircleRightX, base.heroCircleY,
        base.heroDesiredLeftRotation,
      );
      x = hero.x;
      y = hero.y;
      finalRotation = hero.rotation + rotOffset;
    }

    return {
      count: base.count,
      outputSizeW: base.outputSizeW,
      outputSizeH: base.outputSizeH,
      offsetX: base.offsetX,
      offsetY: base.offsetY,
      zoom: base.zoom * zoomFactor,
      tileCount: base.tileCount,
      x, y,
      rotation: finalRotation,
      kaleidoType: base.kaleidoType,
      hueRotation,
      imgWidth: base.imgWidth,
      imgHeight: base.imgHeight,
      jpegQuality: 85,
    };
  }
}