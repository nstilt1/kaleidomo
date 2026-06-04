import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { WedgePicker } from "@/components/WedgePicker";
import { readFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberSliderInput } from "@/components/NumberSliderInput";
import { AspectRatioPicker } from "@/components/AspectRatioPicker";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { initGpuSetting } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import { useLicense } from "@/lib/license-context";
import { Card, CardDescription, CardFooter } from "./ui/card";
import { useKaleidomoSession } from "@/lib/kaleidomo-session-context";
import { type Settings, DEFAULT_SETTINGS } from "@/lib/kaleidomo-session-context";
import { useSettings } from "@/lib/settings-context";
import { checkLivePreviewWebGpuSupport } from "@/lib/webgpu-live-engine-guard";
import { isTauriMacOS, NativeLivePreviewEngine, type NativeLivePreviewParams } from "@/lib/native-live-preview";

const promptForImageRelocation = async (
  originalPath: string
): Promise<string | null> => {
  const relocated = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    defaultPath: originalPath,
  });

  return typeof relocated === "string" ? relocated : null;
};

type LoadedImage = {
  imagePath: string;
  imageSrc: string;
  width: number;
  height: number;
};

const tryLoadImageFromPath = async (path: string): Promise<LoadedImage> => {
  const assetUrl = convertFileSrc(path);
  const img = new Image();
  img.src = assetUrl;
  await img.decode();

  return {
    imagePath: path,
    imageSrc: assetUrl,
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
};

export function roundToNearestMultiple(value: number, multiple: number): number {
  return Math.round(value / multiple) * multiple;
}

// ---------------------------------------------------------------------------
// KaleidoType index (matches kaleido_type_from_idx in wasm.rs)
// ---------------------------------------------------------------------------

function kaleidoTypeToIndex(t: string): number {
  switch (t) {
    case "radial":             return 0;
    case "square":             return 1;
    case "diamond":            return 2;
    case "hexagonal":          return 3;
    case "hexagonal_flat_top": return 4;
    default:                   return 0;
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/**
 * Apply a cascaded first-order IIR low-pass filter to a mono sample array.
 * Each pole gives -6 dB/oct additional rolloff:
 *   poles=1 → -6 dB/oct,  poles=2 → -12,  poles=4 → -24,  poles=8 → -48
 * alpha = dt/(RC+dt) where RC=1/(2π·fc), dt=1/sampleRate.
 * Returns a new Float32Array of the same length.
 */
function applyLowpassFilter(
  data: Float32Array,
  sampleRate: number,
  cutoffHz: number,
  poles: number,
): Float32Array {
  if (cutoffHz <= 0 || cutoffHz >= sampleRate / 2) return data;
  const rc    = 1 / (2 * Math.PI * cutoffHz);
  const dt    = 1 / sampleRate;
  const alpha = dt / (rc + dt);

  // Run `poles` sequential passes over the data (each pass = one RC stage)
  let buf = new Float32Array(data);
  for (let p = 0; p < poles; p++) {
    let prev = 0;
    for (let i = 0; i < buf.length; i++) {
      prev = prev + alpha * ((buf[i]!) - prev);
      buf[i] = prev;
    }
  }
  return buf;
}

function slopeToPoles(slope: number): number {
  // slope is dB/octave; each first-order stage = 6 dB/oct
  return Math.max(1, Math.round(slope / 6));
}

function buildFramePeaks(audioBuffer: AudioBuffer, fps: number, lowpassHz = 0, lowpassSlope = 24): Float32Array {
  const sampleRate = audioBuffer.sampleRate;
  const samplesPerFrame = Math.max(1, Math.floor(sampleRate / fps));
  const frameCount = Math.ceil(audioBuffer.length / samplesPerFrame);
  const peaks = new Float32Array(frameCount);
  const poles = slopeToPoles(lowpassSlope);

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    let data: Float32Array = audioBuffer.getChannelData(channel);
    if (lowpassHz > 0 && lowpassHz < sampleRate / 2) {
      data = applyLowpassFilter(data, sampleRate, lowpassHz, poles);
    }
    for (let frame = 0; frame < frameCount; frame++) {
      const start = frame * samplesPerFrame;
      const end = Math.min(audioBuffer.length, start + samplesPerFrame);
      for (let i = start; i < end; i++) {
        const value = Math.abs(data[i] ?? 0);
        if (value > peaks[frame]!) peaks[frame] = value;
      }
    }
  }

  return peaks;
}

function normalizePeaks(
  rawPeaks: Float32Array,
  floor: number,
  ceiling: number
): Float32Array {
  const safeCeiling = Math.max(ceiling, floor + 0.0001);
  const out = new Float32Array(rawPeaks.length);
  for (let i = 0; i < rawPeaks.length; i++) {
    const raw = rawPeaks[i] ?? 0;
    const normalized = (raw - floor) / (safeCeiling - floor);
    out[i] = Math.min(1, Math.max(0, normalized));
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const IMAGE_SETTING_KEYS = [
  "x",
  "y",
  "rotation",
  "resolution",
  "zoom",
  "tile_count",
  "hue_rotate",
  "ratio_num",
  "ratio_den",
  "offset_x",
  "offset_y",
  "aspect_ratio_mode",
] as const satisfies readonly (keyof Settings)[];

const VIDEO_SETTING_KEYS = [
  "still_frame_ending",
  "fps",
  "quality",
  "zoom_max",
  "zoom_min",
  "zoom_fn",
  "zoom_start_offset",
  "num_zoom_loops",
  "animation_duration",
  "rotation_range",
  "rotation_cycles",
  "rotation_start_offset",
  "rotation_fn",
  "hue_range",
  "hue_cycles",
  "hue_start_offset",
  "hue_fn",
] as const satisfies readonly (keyof Settings)[];

function clampMin(value: number, min: number) {
  return Math.max(min, value);
}

const SCALED_WEDGE_DIAGONAL_MULTIPLIER = 1.5;
const HEXAGONAL_SQRT_3 = 1.7320508075688772;
const SCALED_MODE_REFERENCE_ZOOM = 0.01;

function getEffectiveZoomAndSourceRadius(
  userZoom: number,
  resolution: number,
  imgWidth: number,
  imgHeight: number,
  tileCount: number,
  mode: "legacy" | "scaled"
) {
  const safeUserZoom = clampMin(userZoom, 0.0001);

  if (mode === "legacy") {
    const sourceRadiusPx = resolution / (2 * safeUserZoom);

    return {
      effectiveZoom: safeUserZoom,
      sourceRadiusPx,
    };
  }

  const imageDiagonal = Math.hypot(imgWidth, imgHeight);
  const scaledRadiusAtReferenceZoom =
    imageDiagonal * SCALED_WEDGE_DIAGONAL_MULTIPLIER;
  const sourceRadiusPx =
    scaledRadiusAtReferenceZoom / (safeUserZoom / SCALED_MODE_REFERENCE_ZOOM);

  const safeTileCount = clampMin(tileCount, 0.0001);
  const hexRadiusPx = resolution / (safeTileCount * HEXAGONAL_SQRT_3);
  const effectiveZoom = clampMin(hexRadiusPx / sourceRadiusPx, 0.000001);

  return {
    effectiveZoom,
    sourceRadiusPx,
  };
}

function pickSettings<K extends keyof Settings>(
  source: Settings,
  keys: readonly K[]
): Partial<Settings> {
  const out: Partial<Settings> = {};

  for (const key of keys) {
    out[key] = source[key];
  }

  return out;
}

function mergeSettingsWithBase(base: Settings, incoming: unknown): Settings {
  if (!isRecord(incoming)) {
    return base;
  }

  return {
    ...base,
    ...incoming,
  } as Settings;
}

function migrateVideoSettings(incoming: unknown): Partial<Settings> {
  if (!isRecord(incoming)) {
    return {};
  }

  const migrated = { ...incoming } as Partial<Settings> & Record<string, unknown>;

  const oldFrameCount =
    typeof incoming.frame_count === "number" && Number.isFinite(incoming.frame_count)
      ? incoming.frame_count
      : undefined;

  const fps =
    typeof incoming.fps === "number" && Number.isFinite(incoming.fps)
      ? incoming.fps
      : DEFAULT_SETTINGS.fps;

  if (oldFrameCount !== undefined && typeof migrated.animation_duration !== "number") {
    migrated.animation_duration = oldFrameCount / Math.max(1, fps);
  }

  if (
    typeof incoming.triangle_rotation_degrees_per_frame === "number" &&
    Number.isFinite(incoming.triangle_rotation_degrees_per_frame) &&
    typeof migrated.rotation_range !== "number"
  ) {
    migrated.rotation_range =
      incoming.triangle_rotation_degrees_per_frame *
      (oldFrameCount ?? Math.round(DEFAULT_SETTINGS.animation_duration * fps));
    migrated.rotation_cycles = 1;
    migrated.rotation_start_offset = 0;
    migrated.rotation_fn = "sawtooth";
  }

  if (
    typeof incoming.hue_rotation_degrees_per_frame === "number" &&
    Number.isFinite(incoming.hue_rotation_degrees_per_frame) &&
    typeof migrated.hue_range !== "number"
  ) {
    migrated.hue_range =
      incoming.hue_rotation_degrees_per_frame *
      (oldFrameCount ?? Math.round(DEFAULT_SETTINGS.animation_duration * fps));
    migrated.hue_cycles = 1;
    migrated.hue_start_offset = 0;
    migrated.hue_fn = "sawtooth";
  }

  delete migrated.frame_count;
  delete migrated.triangle_rotation_degrees_per_frame;
  delete migrated.hue_rotation_degrees_per_frame;

  return migrated;
}

function Kaleidomo() {
  const { isUnlocked, licenseType } = useLicense();
  const {
    mode: wedgePickerMode,
    setMode: setWedgePickerMode,
    zoomSliderMidpointPercent,
    setZoomSliderMidpointPercent,
  } = useSettings();
  console.log(licenseType);
  const {
    imagePath,
    setImagePath,
    imageSrc,
    setImageSrc,
    outputSrc,
    setOutputSrc,
    count,
    setCount,
    settings,
    setSettings,
    kaleidoType,
    setKaleidoType,
    imgWidth,
    setImgWidth,
    imgHeight,
    setImgHeight,
    isRendering,
    setIsRendering,
  } = useKaleidomoSession();

  // ---------------------------------------------------------------------------
  // WASM live preview engine refs and audio state
  // ---------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engineRef = useRef<any>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  // Native macOS live preview engine (used instead of WASM on macOS Tauri)
  const nativeEngineRef = useRef<NativeLivePreviewEngine | null>(null);
  const rawAudioPeaksRef = useRef<Float32Array | null>(null);
  const normalizedAudioPeaksRef = useRef<Float32Array | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null); // kept for lowpass rebuilds
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const [audioFileName, setAudioFileName] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [livePreviewError, setLivePreviewError] = useState<string | null>(null);
  // macOS native preview resolution cap. Higher = sharper but more IPC memory pressure.
  // 720 is the safe default (70 MB/s at 20fps with reusable ImageData).
  const [nativePreviewRes, setNativePreviewRes] = useState<512 | 720 | 1080>(720);
  const [audioPlaying, setAudioPlaying] = useState(false);

  // Rebuild normalized peaks and send them to WASM engine
  const rebuildAndSendPeaks = useCallback((floor: number, ceiling: number, lowpassHz?: number, lowpassSlope?: number) => {
    // If filter params changed and we have the AudioBuffer, rebuild raw peaks first
    if ((lowpassHz !== undefined || lowpassSlope !== undefined) && audioBufferRef.current) {
      const hz = lowpassHz ?? settings.audioLowpassFreq;
      const slope = lowpassSlope ?? settings.audioLowpassSlope;
      const raw = buildFramePeaks(audioBufferRef.current, Math.max(1, settings.fps), hz, slope);
      rawAudioPeaksRef.current = raw;
    }
    const raw = rawAudioPeaksRef.current;
    if (!raw) return;
    const normalized = normalizePeaks(raw, floor, ceiling);
    normalizedAudioPeaksRef.current = normalized;
    try {
      engineRef.current?.set_audio_peaks(normalized);
    } catch (e) {
      console.error("set_audio_peaks failed", e);
    }
    nativeEngineRef.current?.setPeaks(normalized);
  }, [settings.fps]);

  // Build WasmVideoSettings from current settings and pass to WASM engine
  const syncVideoSettingsToEngine = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      // engine.update_animation_settings expects the same args as start_animation
      // but without resetting the clock. We call update_animation_settings.
      // WasmVideoSettings is set via update_animation_settings.
      // We need to construct a WasmVideoSettings — accessed via the wasm module.
      // Since we can't import the WASM class synchronously here (it's loaded async),
      // we'll store a reference to it on the engine instance's module.
      if (!engine.__vsModule) return;
      const vs = new engine.__vsModule.WasmVideoSettings();
      vs.animation_duration = settings.animation_duration;
      vs.rotation_range = settings.rotation_range;
      vs.rotation_cycles = settings.rotation_cycles;
      vs.rotation_start_offset = settings.rotation_start_offset;
      vs.set_rotation_fn(settings.rotation_fn);
      vs.hue_range = settings.hue_range;
      vs.hue_cycles = settings.hue_cycles;
      vs.hue_start_offset = settings.hue_start_offset;
      vs.set_hue_fn(settings.hue_fn);
      vs.fps = settings.fps;
      vs.zoom_max = settings.zoom_max;
      vs.zoom_min = settings.zoom_min;
      vs.set_zoom_fn(settings.zoom_fn);
      vs.zoom_start_offset = settings.zoom_start_offset;
      vs.num_zoom_loops = settings.num_zoom_loops;
      vs.orientation_start_offset = settings.orientationPhase;
      vs.audio_reactive_enabled = settings.audioReactiveEnabled;
      vs.audio_orientation_amount = settings.audioOrientationAmount;
      vs.audio_reorientation_amount = settings.audioReorientationAmount;
      vs.audio_peak_smoothing = settings.audioPeakSmoothing;
      vs.hero_circle_left_x = settings.heroCircleLeftX;
      vs.hero_circle_right_x = settings.heroCircleRightX;
      vs.hero_circle_y = settings.heroCircleY;
      vs.hero_desired_left_rotation = settings.rotation;
      vs.orientation_base_speed = settings.orientationBaseSpeed;
      vs.orientation_peak_multiplier = settings.orientationPeakMultiplier;

      const { effectiveZoom } = getEffectiveZoomAndSourceRadius(
        settings.zoom,
        settings.resolution,
        imgWidth,
        imgHeight,
        settings.tile_count,
        wedgePickerMode
      );

      const kaleidoTypeIdx = kaleidoTypeToIndex(kaleidoType);

      engine.update_animation_settings(
        count,
        settings.offset_x,
        settings.offset_y,
        effectiveZoom,
        settings.tile_count,
        settings.x,
        settings.y,
        settings.rotation,
        kaleidoTypeIdx,
        settings.hue_rotate,
        vs,
      );
    } catch (e) {
      console.error("syncVideoSettingsToEngine failed", e);
    }
  }, [settings, count, kaleidoType, imgWidth, imgHeight, wedgePickerMode]);

  // ---------------------------------------------------------------------------
  // Native macOS live preview (wgpu / Metal via Tauri command)
  // ---------------------------------------------------------------------------

  /** Build the params object the native engine needs from current state. */
  const buildNativeParams = useCallback((): NativeLivePreviewParams => {
    const { effectiveZoom } = getEffectiveZoomAndSourceRadius(
      settings.zoom,
      settings.resolution,
      imgWidth,
      imgHeight,
      settings.tile_count,
      wedgePickerMode
    );
    // Hard cap on live preview render size. Cap the OUTPUT dimensions directly
    // after aspect-ratio math so rounding never pushes either dimension over the limit.
    const NATIVE_PREVIEW_MAX_PX = nativePreviewRes;
    const dims = (() => {
      const short = Math.min(Math.max(1, settings.resolution), NATIVE_PREVIEW_MAX_PX);
      const num = Math.max(1, settings.ratio_num);
      const den = Math.max(1, settings.ratio_den);
      let w: number, h: number;
      if (num >= den) {
        h = short; w = Math.round(short * num / den / 8) * 8;
        h = Math.floor(w * den / num);
      } else {
        w = short; h = Math.floor(short * den / num);
        w = Math.round(w / 8) * 8;
        h = Math.floor(w * den / num);
      }
      // Clamp both dimensions so aspect-ratio rounding never exceeds the cap
      if (w > NATIVE_PREVIEW_MAX_PX) { w = Math.floor(NATIVE_PREVIEW_MAX_PX / 8) * 8; h = Math.floor(w * den / num); }
      if (h > NATIVE_PREVIEW_MAX_PX) { h = NATIVE_PREVIEW_MAX_PX; w = Math.round(h * num / den / 8) * 8; }
      return { w: Math.max(8, w), h: Math.max(8, h) };
    })();

    return {
      count,
      outputSizeW: dims.w,
      outputSizeH: dims.h,
      offsetX: settings.offset_x,
      offsetY: settings.offset_y,
      // Base (unanimated) zoom — engine multiplies by animated zoom factor
      zoom: effectiveZoom,
      tileCount: settings.tile_count,
      x: settings.x,
      y: settings.y,
      rotation: settings.rotation,
      kaleidoType,
      hueRotation: settings.hue_rotate,
      imgWidth,
      imgHeight,
      // Animation / video settings
      animationDuration: settings.animation_duration,
      fps: settings.fps,
      rotationRange: settings.rotation_range,
      rotationCycles: settings.rotation_cycles,
      rotationStartOffset: settings.rotation_start_offset,
      rotationFn: settings.rotation_fn,
      hueRange: settings.hue_range,
      hueCycles: settings.hue_cycles,
      hueStartOffset: settings.hue_start_offset,
      hueFn: settings.hue_fn,
      zoomMax: settings.zoom_max,
      zoomMin: settings.zoom_min,
      zoomFn: settings.zoom_fn,
      zoomStartOffset: settings.zoom_start_offset,
      numZoomLoops: settings.num_zoom_loops,
      // Orientation / hero-circle
      orientationBaseSpeed: settings.orientationBaseSpeed,
      heroCircleLeftX: settings.heroCircleLeftX,
      heroCircleRightX: settings.heroCircleRightX,
      heroCircleY: settings.heroCircleY,
      // hero_desired_left_rotation is the base rotation at value=0 on the circle
      heroDesiredLeftRotation: settings.rotation,
      // Audio-reactive
      audioReactiveEnabled: settings.audioReactiveEnabled,
      audioPeakSmoothing: settings.audioPeakSmoothing,
      audioOrientationAmount: settings.audioOrientationAmount,
      audioReorientationAmount: settings.audioReorientationAmount,
      orientationPeakMultiplier: settings.orientationPeakMultiplier,
    };
  }, [settings, count, kaleidoType, imgWidth, imgHeight, wedgePickerMode, nativePreviewRes]);

  /** Start (or restart) the native Metal-backed live preview loop. */
  const startNativeLiveEngine = useCallback(() => {
    // Stop any existing native engine.
    if (nativeEngineRef.current) {
      nativeEngineRef.current.stop();
      nativeEngineRef.current = null;
    }
    setLivePreviewError(null);

    const engine = new NativeLivePreviewEngine()
      .onError((msg) => {
        console.error("native live preview error:", msg);
        setLivePreviewError(msg);
      });

    if (liveCanvasRef.current) {
      engine.setCanvas(liveCanvasRef.current);
    }
    engine.setAudioElement(audioElementRef.current);
    if (normalizedAudioPeaksRef.current) {
      engine.setPeaks(normalizedAudioPeaksRef.current);
    }

    engine.start();
    nativeEngineRef.current = engine;

    // Push the first frame immediately.
    engine.pushParams(buildNativeParams());
  }, [buildNativeParams]);

  // Whenever settings change, push new params to the native engine (if running).
  useEffect(() => {
    const engine = nativeEngineRef.current;
    if (!engine) return;
    engine.pushParams(buildNativeParams());
  }, [buildNativeParams]);

  // Start the WASM live preview engine
  const startLiveEngine = useCallback(async () => {
    const canvas = liveCanvasRef.current;
    if (!imageSrc) return;

    // ── macOS Tauri: use native wgpu/Metal path ──────────────────────────────
    if (isTauriMacOS()) {
      // Ensure source image is loaded in the Rust GPU backend first.
      if (imagePath) {
        try {
          await invoke("select_image", { path: imagePath });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setLivePreviewError(`Failed to load image into GPU backend: ${msg}`);
          return;
        }
      }
      startNativeLiveEngine();
      return;
    }

    // ── All other platforms: WASM WebGPU path ────────────────────────────────
    if (!canvas) return;

    setLivePreviewError(null);

    try {
      const support = await checkLivePreviewWebGpuSupport();

      if (!support.supported) {
        setLivePreviewError(support.reason);
        console.warn("Live preview WebGPU unavailable:", support.reason, support.details);
        return;
      }

      const { loadWasm } = await import("@/wasm/kaleidomo-wasm");
      const wasmModule = await loadWasm();

      // Stop and release any existing engine before constructing a new one.
      if (engineRef.current) {
        try { engineRef.current.stop_animation(); } catch (_) { /* ignored */ }
        try { engineRef.current.free?.(); } catch (_) { /* ignored */ }
        engineRef.current = null;
      }

      const engine = await new wasmModule.LiveKaleidoscopeEngine(canvas);
      engine.__vsModule = wasmModule;
      engineRef.current = engine;

      // Fetch the image as bytes in JS (asset.localhost is allowed in connect-src)
      // then push raw RGBA into WASM — avoids a second fetch inside WASM.
      const imgResp = await fetch(imageSrc);
      const imgBlob = await imgResp.blob();
      const imgBitmap = await createImageBitmap(imgBlob);
      const offscreen = new OffscreenCanvas(imgBitmap.width, imgBitmap.height);
      const offCtx = offscreen.getContext("2d")!;
      offCtx.drawImage(imgBitmap, 0, 0);
      const imageData = offCtx.getImageData(0, 0, imgBitmap.width, imgBitmap.height);
      engine.load_source_image(imageData.data, imgBitmap.width, imgBitmap.height);

      const vs = new wasmModule.WasmVideoSettings();
      vs.animation_duration = settings.animation_duration;
      vs.rotation_range = settings.rotation_range;
      vs.rotation_cycles = settings.rotation_cycles;
      vs.rotation_start_offset = settings.rotation_start_offset;
      vs.set_rotation_fn(settings.rotation_fn);
      vs.hue_range = settings.hue_range;
      vs.hue_cycles = settings.hue_cycles;
      vs.hue_start_offset = settings.hue_start_offset;
      vs.set_hue_fn(settings.hue_fn);
      vs.fps = settings.fps;
      vs.zoom_max = settings.zoom_max;
      vs.zoom_min = settings.zoom_min;
      vs.set_zoom_fn(settings.zoom_fn);
      vs.zoom_start_offset = settings.zoom_start_offset;
      vs.num_zoom_loops = settings.num_zoom_loops;
      vs.orientation_start_offset = settings.orientationPhase;
      vs.audio_reactive_enabled = settings.audioReactiveEnabled;
      vs.audio_orientation_amount = settings.audioOrientationAmount;
      vs.audio_reorientation_amount = settings.audioReorientationAmount;
      vs.audio_peak_smoothing = settings.audioPeakSmoothing;
      vs.hero_circle_left_x = settings.heroCircleLeftX;
      vs.hero_circle_right_x = settings.heroCircleRightX;
      vs.hero_circle_y = settings.heroCircleY;
      vs.hero_desired_left_rotation = settings.rotation;
      vs.orientation_base_speed = settings.orientationBaseSpeed;
      vs.orientation_peak_multiplier = settings.orientationPeakMultiplier;

      const { effectiveZoom } = getEffectiveZoomAndSourceRadius(
        settings.zoom,
        settings.resolution,
        imgWidth,
        imgHeight,
        settings.tile_count,
        wedgePickerMode
      );

      const kaleidoTypeIdx = kaleidoTypeToIndex(kaleidoType);

      engine.start_animation(
        count,
        settings.offset_x,
        settings.offset_y,
        effectiveZoom,
        settings.tile_count,
        settings.x,
        settings.y,
        settings.rotation,
        kaleidoTypeIdx,
        settings.hue_rotate,
        vs,
      );

      // Re-send audio peaks if loaded
      if (normalizedAudioPeaksRef.current) {
        engine.set_audio_peaks(normalizedAudioPeaksRef.current);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setLivePreviewError(message);
      console.error("startLiveEngine failed", e);
    }
  }, [imageSrc, imagePath, startNativeLiveEngine, settings, count, kaleidoType, imgWidth, imgHeight, wedgePickerMode]);

  // Sync settings changes to engine (no restart)
  useEffect(() => {
    syncVideoSettingsToEngine();
  }, [syncVideoSettingsToEngine]);

  // Resend peaks when floor/ceiling/lowpass changes
  useEffect(() => {
    rebuildAndSendPeaks(settings.audioPeakFloor, settings.audioPeakCeiling, settings.audioLowpassFreq, settings.audioLowpassSlope);
  }, [settings.audioPeakFloor, settings.audioPeakCeiling, settings.audioLowpassFreq, settings.audioLowpassSlope, rebuildAndSendPeaks]);

  // Keep the audio File object so we can get its path for export
  const audioFileRef = useRef<File | null>(null);
  const audioObjectUrlRef = useRef<string | null>(null);
  const audioFilePathRef = useRef<string | null>(null);

  function guessAudioMimeTypeFromPath(path: string): string {
    const lower = path.toLowerCase();

    if (lower.endsWith(".wav") || lower.endsWith(".wave")) return "audio/wav";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".mp4")) return "audio/mp4";
    if (lower.endsWith(".aac")) return "audio/aac";
    if (lower.endsWith(".flac")) return "audio/flac";
    if (lower.endsWith(".ogg")) return "audio/ogg";

    return "application/octet-stream";
  }

  function getAudioPlayErrorMessage(err: unknown): string {
    if (err instanceof DOMException) {
      if (err.name === "NotAllowedError") {
        return "Audio playback was blocked. Click Play Audio again after interacting with the app.";
      }

      if (err.name === "NotSupportedError") {
        return "This audio file decoded for peaks, but the macOS WebView could not play it as media. Try a 16-bit PCM WAV, MP3, M4A, or AAC file.";
      }
    }

    return "Audio playback failed.";
  }

  const revokeAudioObjectUrl = useCallback(() => {
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }
  }, []);

  const handleAudioFileChange = async () => {
    setAudioError(null);

    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "wave", "mp3", "m4a", "aac", "flac", "ogg"],
        },
      ],
    });

    if (typeof selected !== "string") {
      return;
    }

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.removeAttribute("src");
      audioElementRef.current.load();
    }

    try {
      const bytes = await readFile(selected);
      const fileName = selected.split(/[\\/]/).pop() ?? "audio";
      const mimeType = guessAudioMimeTypeFromPath(selected);

      const decodeBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );

      const audioContext = new AudioContext();
      const audioBuffer = await audioContext.decodeAudioData(decodeBuffer.slice(0));
      await audioContext.close();

      audioBufferRef.current = audioBuffer;

      const rawPeaks = buildFramePeaks(
        audioBuffer,
        Math.max(1, settings.fps),
        settings.audioLowpassFreq,
        settings.audioLowpassSlope,
      );

      rawAudioPeaksRef.current = rawPeaks;

      const normalized = normalizePeaks(
        rawPeaks,
        settings.audioPeakFloor,
        settings.audioPeakCeiling,
      );

      normalizedAudioPeaksRef.current = normalized;
      audioFilePathRef.current = selected;

      setAudioFileName(fileName);
      setAudioPlaying(false);

      const audio = new Audio();
      audio.preload = "auto";
      audio.loop = true;
      audio.crossOrigin = "anonymous";
      audio.src = convertFileSrc(selected);

      audio.onended = () => setAudioPlaying(false);

      audio.onerror = () => {
        console.error("[audio] element error:", {
          error: audio.error,
          src: audio.src,
          canPlayType: audio.canPlayType(mimeType),
          mimeType,
        });

        setAudioPlaying(false);
        setAudioError(
          `The audio decoded for peaks, but the WebView could not play it as ${mimeType}.`,
        );
      };

      audioElementRef.current = audio;
      nativeEngineRef.current?.setAudioElement(audio);

      audio.load();

      if (engineRef.current) {
        try {
          engineRef.current.set_audio_peaks(normalized);
        } catch (err) {
          console.error(err);
        }
      }

      nativeEngineRef.current?.setPeaks(normalized);
    } catch (err) {
      console.error("Audio import failed", err);
      setAudioError("Failed to import audio file.");
      audioFilePathRef.current = null;
    }
  };

  const handleRestartLivePreview = useCallback(() => {
    const audio = audioElementRef.current;

    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }

    setAudioPlaying(false);
    setAudioError(null);

    void startLiveEngine().then(() => {
      if (!audio || !audioFileName) {
        return;
      }

      nativeEngineRef.current?.setAudioElement(audio);

      audio
        .play()
        .then(() => {
          setAudioPlaying(true);
        })
        .catch((err) => {
          console.error("[audio] restart playback failed:", err);
          setAudioPlaying(false);
          setAudioError(getAudioPlayErrorMessage(err));
        });
    });
  }, [startLiveEngine, audioFileName]);

  const handleToggleAudioPlayback = () => {
    const audio = audioElementRef.current;
    if (!audio) return;

    setAudioError(null);

    if (audio.paused) {
      nativeEngineRef.current?.setAudioElement(audio);

      audio
        .play()
        .then(() => {
          setAudioPlaying(true);
        })
        .catch((err) => {
          console.error("[audio] play failed:", {
            err,
            src: audio.src,
            networkState: audio.networkState,
            readyState: audio.readyState,
            mediaError: audio.error,
          });

          setAudioPlaying(false);
          setAudioError("Audio playback failed in the WebView.");
        });
    } else {
      audio.pause();
      setAudioPlaying(false);
    }
  };

  const handleClearAudio = () => {
    rawAudioPeaksRef.current = null;
    normalizedAudioPeaksRef.current = null;
    audioBufferRef.current = null;
    audioFileRef.current = null;
    revokeAudioObjectUrl();
    audioFilePathRef.current = null;
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = "";
      audioElementRef.current = null;
    }
    setAudioFileName(null);
    setAudioPlaying(false);
    if (engineRef.current) {
      try { engineRef.current.clear_audio_peaks(); } catch (_) { /* ignored */ }
    }
    nativeEngineRef.current?.setPeaks(new Float32Array(0));
    nativeEngineRef.current?.setAudioElement(null);
  };


  useEffect(() => {
    console.log("location.href", window.location.href);
    console.log("has __TAURI_INTERNALS__", "__TAURI_INTERNALS__" in window);
    console.log(imageSrc);
  }, []);

  useEffect(() => {
    initGpuSetting();
  }, []);

  useEffect(() => {
    const onLoadImagePreset = () => {
      void loadImagePreset();
    };

    const onSaveImagePreset = () => {
      void saveImagePreset();
    };

    const onLoadVideoPreset = () => {
      void loadVideoPreset();
    };

    const onSaveVideoPreset = () => {
      void saveVideoPreset();
    };

    const onLoadProject = () => {
      void loadProject();
    };

    const onSaveProject = () => {
      void saveProject();
    };

    window.addEventListener("menu-load-image-preset", onLoadImagePreset);
    window.addEventListener("menu-save-image-preset", onSaveImagePreset);
    window.addEventListener("menu-load-video-preset", onLoadVideoPreset);
    window.addEventListener("menu-save-video-preset", onSaveVideoPreset);
    window.addEventListener("menu-load-project", onLoadProject);
    window.addEventListener("menu-save-project", onSaveProject);

    return () => {
      window.removeEventListener("menu-load-image-preset", onLoadImagePreset);
      window.removeEventListener("menu-save-image-preset", onSaveImagePreset);
      window.removeEventListener("menu-load-video-preset", onLoadVideoPreset);
      window.removeEventListener("menu-save-video-preset", onSaveVideoPreset);
      window.removeEventListener("menu-load-project", onLoadProject);
      window.removeEventListener("menu-save-project", onSaveProject);
    };
  }, []);

  const calculateDimensions = useCallback(
    (currentSettings: Pick<Settings, "resolution" | "ratio_num" | "ratio_den">) => {
      const short = Math.max(1, currentSettings.resolution);
      const num = Math.max(1, currentSettings.ratio_num);
      const den = Math.max(1, currentSettings.ratio_den);

      let width: number;
      let height: number;

      if (num >= den) {
        height = short;
        width = (short * num) / den;
        width = roundToNearestMultiple(width, 8);
        height = Math.floor((width * den) / num);
      } else {
        width = short;
        height = (short * den) / num;
        width = roundToNearestMultiple(width, 8);
        height = Math.floor((width * den) / num);
      }

      return {
        width,
        height,
      };
    },
    []
  );

  const effectiveZoomState = getEffectiveZoomAndSourceRadius(
    settings.zoom,
    settings.resolution,
    imgWidth,
    imgHeight,
    settings.tile_count,
    wedgePickerMode
  );

  const effectiveMinZoomState = getEffectiveZoomAndSourceRadius(
    settings.zoom_min,
    settings.resolution,
    imgWidth,
    imgHeight,
    settings.tile_count,
    wedgePickerMode
  );

  const effectiveMaxZoomState = getEffectiveZoomAndSourceRadius(
    settings.zoom_max,
    settings.resolution,
    imgWidth,
    imgHeight,
    settings.tile_count,
    wedgePickerMode
  );

  const renderPreview = useCallback(
    async (options?: {
      path?: string;
      width?: number;
      height?: number;
      nextSettings?: Settings;
      nextCount?: number;
      nextKaleidoType?: string;
    }) => {
      const path = options?.path ?? imagePath;
      const sourceWidth = options?.width ?? imgWidth;
      const sourceHeight = options?.height ?? imgHeight;
      const activeSettings = options?.nextSettings ?? settings;
      const activeCount = options?.nextCount ?? count;
      const activeKaleidoType = options?.nextKaleidoType ?? kaleidoType;

      console.log("about to invoke generate_kaleidoscope", {
        path,
        sourceWidth,
        sourceHeight,
        activeSettings,
        activeCount,
        activeKaleidoType,
      });

      if (typeof path !== "string" || path.trim() === "") {
        console.warn("renderPreview skipped because path is empty", path);
        return;
      }

      if (sourceWidth <= 0 || sourceHeight <= 0) {
        console.warn(
          "renderPreview skipped because image dimensions are invalid",
          sourceWidth,
          sourceHeight
        );
        return;
      }

      const { width, height } = calculateDimensions(activeSettings);

      try {
        setIsRendering(true);

        const result = await invoke<string>("generate_kaleidoscope", {
          path,
          x: activeSettings.x,
          y: activeSettings.y,
          rotation: activeSettings.rotation,
          count: activeCount,
          outputSizeH: height,
          outputSizeW: width,
          offsetX: activeSettings.offset_x,
          offsetY: activeSettings.offset_y,
          zoom: getEffectiveZoomAndSourceRadius(
            activeSettings.zoom,
            activeSettings.resolution,
            sourceWidth,
            sourceHeight,
            activeSettings.tile_count,
            wedgePickerMode
          ).effectiveZoom,
          kaleidoType: activeKaleidoType,
          tileCount: activeSettings.tile_count,
          hueRotation: activeSettings.hue_rotate,
          imgWidth: sourceWidth,
          imgHeight: sourceHeight,
        });

        setOutputSrc(result);
      } catch (e) {
        console.error("Render failed", e, String(e));
      } finally {
        setIsRendering(false);
      }
    },
    [
      imagePath,
      imgWidth,
      imgHeight,
      settings,
      count,
      kaleidoType,
      calculateDimensions,
      wedgePickerMode,
    ]
  );

  const loadImageIntoState = useCallback(
    async (path: string, recenter: boolean) => {
      const loadedImage = await tryLoadImageFromPath(path);

      setImagePath(loadedImage.imagePath);
      setImageSrc(loadedImage.imageSrc);
      setImgWidth(loadedImage.width);
      setImgHeight(loadedImage.height);

      if (recenter) {
        setSettings((prev) => ({
          ...prev,
          x: loadedImage.width / 2,
          y: loadedImage.height / 2,
        }));
      }

      await invoke("select_image", { path: loadedImage.imagePath });

      return loadedImage;
    },
    []
  );

  const handlePickFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "tif", "tiff", "avif", "heic", "heif"],
        },
      ]
    });

    if (typeof selected !== "string" || selected.trim() === "") {
      console.log("typeOf path != string", selected, typeof selected);
      return;
    }

    try {
      const loadedImage = await loadImageIntoState(selected, true);

      const centeredSettings: Settings = {
        ...settings,
        x: loadedImage.width / 2,
        y: loadedImage.height / 2,
      };

      setSettings(centeredSettings);

      await renderPreview({
        path: loadedImage.imagePath,
        width: loadedImage.width,
        height: loadedImage.height,
        nextSettings: centeredSettings,
      });
    } catch (err) {
      console.error("Failed to pick and load image", err);
    }
  };

  const resetImageSettings = () => {
    setSettings((prev) => ({
      ...prev,
      x: imgWidth / 2,
      y: imgHeight / 2,
      rotation: 0,
      resolution: 512,
      zoom: 2,
      tile_count: 1.0,
      hue_rotate: 0,
      ratio_num: 9,
      ratio_den: 16,
      offset_x: 0,
      offset_y: 0,
      aspect_ratio_mode: "preset",
    }));
  };

  const resetVideoSettings = () => {
    setSettings((prev) => ({
      ...prev,
      frame_count: 360,
      still_frame_ending: 0,
      fps: 30,
      quality: 0.1,
      triangle_rotation_degrees_per_frame: 1.0,
      hue_rotation_degrees_per_frame: 1.0,
      zoom_max: 1.0,
      zoom_min: 1.0,
      zoom_fn: "sin",
      zoom_start_offset: 0.0,
      num_zoom_loops: 1,
    }));
  };

  useEffect(() => {
    if (!imagePath || imgWidth <= 0 || imgHeight <= 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      void renderPreview();
    }, 35);

    return () => {
      window.clearTimeout(timer);
    };
  }, [settings, count, kaleidoType, imagePath, imgWidth, imgHeight, renderPreview]);

  const saveImagePreset = async () => {
    const filePath = await save({
      filters: [{ name: "JSON", extensions: ["kmo-image.json"] }],
    });

    if (!filePath) {
      return;
    }

    const data = JSON.stringify({
      imagePath,
      count,
      settings: pickSettings(settings, IMAGE_SETTING_KEYS),
      kaleidoType,
    });

    await writeTextFile(filePath, data);
  };

  const saveVideoPreset = async () => {
    const filePath = await save({
      filters: [{ name: "JSON", extensions: ["kmo-video.json"] }],
    });

    if (!filePath) {
      return;
    }

    const data = JSON.stringify({
      count,
      settings: pickSettings(settings, VIDEO_SETTING_KEYS),
      kaleidoType,
    });

    await writeTextFile(filePath, data);
  };

  const loadImageFromPath = async (originalPath: string): Promise<LoadedImage | null> => {
    if (!originalPath) {
      return null;
    }

    try {
      return await tryLoadImageFromPath(originalPath);
    } catch (err) {
      console.warn("Failed to load saved image path, asking user to relocate.", err);

      const relocated = await promptForImageRelocation(originalPath);
      if (!relocated) {
        return null;
      }

      return await tryLoadImageFromPath(relocated);
    }
  };

  const loadImagePreset = async () => {
    const selected = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (typeof selected !== "string" || selected.trim() === "") {
      return;
    }

    try {
      const content = await readTextFile(selected);
      const parsed: unknown = JSON.parse(content);

      if (!isRecord(parsed)) {
        throw new Error("Preset file is not a valid object.");
      }

      const mergedSettings = mergeSettingsWithBase(
        DEFAULT_SETTINGS, 
        migrateVideoSettings(parsed.settings)
      );
      setSettings(mergedSettings);

      const nextCount =
        typeof parsed.count === "number" && Number.isFinite(parsed.count) ? parsed.count : count;
      setCount(nextCount);

      const nextKaleidoType =
        typeof parsed.kaleidoType === "string" ? parsed.kaleidoType : kaleidoType;
      setKaleidoType(nextKaleidoType);

      if (typeof parsed.imagePath === "string" && parsed.imagePath) {
        try {
          const loadedImage = await loadImageFromPath(parsed.imagePath);

          if (loadedImage) {
            setImagePath(loadedImage.imagePath);
            setImageSrc(loadedImage.imageSrc);
            setImgWidth(loadedImage.width);
            setImgHeight(loadedImage.height);

            await invoke("select_image", { path: loadedImage.imagePath });

            await renderPreview({
              path: loadedImage.imagePath,
              width: loadedImage.width,
              height: loadedImage.height,
              nextSettings: mergedSettings,
              nextCount,
              nextKaleidoType,
            });
          }
        } catch (err) {
          console.error("Failed to load preset image", err);
        }
      }
    } catch (err) {
      console.error("Failed to load image preset", err);
    }
  };

  const loadVideoPreset = async () => {
    const selected = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (typeof selected !== "string" || selected.trim() === "") {
      return;
    }

    try {
      const content = await readTextFile(selected);
      const parsed: unknown = JSON.parse(content);

      if (!isRecord(parsed)) {
        throw new Error("Preset file is not a valid object.");
      }

      const mergedSettings = mergeSettingsWithBase(DEFAULT_SETTINGS, parsed.settings);
      setSettings(mergedSettings);

      if (typeof parsed.count === "number" && Number.isFinite(parsed.count)) {
        setCount(parsed.count);
      }

      if (typeof parsed.kaleidoType === "string") {
        setKaleidoType(parsed.kaleidoType);
      }
    } catch (err) {
      console.error("Failed to load video preset", err);
    }
  };

  const loadProject = async () => {
    const selected = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
    });

    if (typeof selected !== "string" || selected.trim() === "") {
      return;
    }

    try {
      const content = await readTextFile(selected);
      const parsed: unknown = JSON.parse(content);

      if (!isRecord(parsed)) {
        throw new Error("Project file is not a valid object.");
      }

      const nextImagePath =
        typeof parsed.imagePath === "string" ? parsed.imagePath : "";

      const nextCount =
        typeof parsed.count === "number" && Number.isFinite(parsed.count)
          ? parsed.count
          : 0;

      const nextKaleidoType =
        typeof parsed.kaleidoType === "string" ? parsed.kaleidoType : "radial";

      const nextSettings = mergeSettingsWithBase(DEFAULT_SETTINGS, parsed.settings);

      if (isRecord(parsed.uiSettings)) {
        if (
          parsed.uiSettings.wedgePickerMode === "legacy" ||
          parsed.uiSettings.wedgePickerMode === "scaled"
        ) {
          setWedgePickerMode(parsed.uiSettings.wedgePickerMode);
        }

        if (
          typeof parsed.uiSettings.zoomSliderMidpointPercent === "number" &&
          Number.isFinite(parsed.uiSettings.zoomSliderMidpointPercent)
        ) {
          setZoomSliderMidpointPercent(
            Math.min(
              0.95,
              Math.max(0.05, parsed.uiSettings.zoomSliderMidpointPercent)
            )
          );
        }
      }

      setCount(nextCount);
      setSettings(nextSettings);
      setKaleidoType(nextKaleidoType);

      if (nextImagePath) {
        try {
          const loadedImage = await loadImageFromPath(nextImagePath);

          if (loadedImage) {
            setImagePath(loadedImage.imagePath);
            setImageSrc(loadedImage.imageSrc);
            setImgWidth(loadedImage.width);
            setImgHeight(loadedImage.height);

            await invoke("select_image", { path: loadedImage.imagePath });

            await renderPreview({
              path: loadedImage.imagePath,
              width: loadedImage.width,
              height: loadedImage.height,
              nextSettings,
              nextCount,
              nextKaleidoType,
            });
          }
        } catch (err) {
          console.error("Failed to load project image", err);
        }
      }
    } catch (err) {
      console.error("Failed to load project file", err);
    }
  };

  const saveProject = async () => {
    const filePath = await save({
      filters: [{ name: "JSON", extensions: ["kmo.json"] }],
    });

    if (!filePath) {
      return;
    }

    const data = JSON.stringify({
      imagePath,
      count,
      settings,
      kaleidoType,
      uiSettings: {
        wedgePickerMode,
        zoomSliderMidpointPercent,
      },
    });
    await writeTextFile(filePath, data);
  };

  const handleExport = async () => {
    if (!imagePath || imgWidth <= 0 || imgHeight <= 0) {
      return;
    }

    const { width, height } = calculateDimensions(settings);

    try {
      const message = await invoke("export_kaleidoscope", {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        zoom: effectiveZoomState.effectiveZoom,
        count,
        outputSizeH: height,
        outputSizeW: width,
        offsetX: settings.offset_x,
        offsetY: settings.offset_y,
        kaleidoType,
        tileCount: settings.tile_count,
        hueRotation: settings.hue_rotate,
        imgWidth,
        imgHeight,
      });

      alert(String(message));
    } catch (e) {
      if (e !== "Export cancelled") {
        console.error("Export failed", e);
      }
    }
  };

  const handleVideo = async () => {
    if (!imagePath || imgWidth <= 0 || imgHeight <= 0) {
      return;
    }

    const { width, height } = calculateDimensions(settings);

    try {
      console.log("settings.still_frame_ending frames = " + settings.still_frame_ending);

      const audioFilePath = audioFilePathRef.current;

      const message = await invoke("generate_video", {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        zoom: effectiveZoomState.effectiveZoom,
        count,
        outputSizeH: height,
        outputSizeW: width,
        offsetX: settings.offset_x,
        offsetY: settings.offset_y,
        kaleidoType,
        tileCount: settings.tile_count,
        hueRotation: settings.hue_rotate,
        stillFrameEnding: settings.still_frame_ending,
        fps: settings.fps,
        quality: settings.quality,
        zoomMax: effectiveMaxZoomState.effectiveZoom,
        zoomMin: effectiveMinZoomState.effectiveZoom,
        zoomFn: settings.zoom_fn,
        zoomStartOffset: settings.zoom_start_offset,
        numZoomLoops: settings.num_zoom_loops,
        imgWidth,
        imgHeight,
        animationDuration: settings.animation_duration,
        rotationRange: settings.rotation_range,
        rotationCycles: settings.rotation_cycles,
        rotationStartOffset: settings.rotation_start_offset,
        rotationFn: settings.rotation_fn,
        hueRange: settings.hue_range,
        hueCycles: settings.hue_cycles,
        hueStartOffset: settings.hue_start_offset,
        hueFn: settings.hue_fn,
        audioFilePath,

        audioReactiveEnabled: settings.audioReactiveEnabled,
        audioPeakSmoothing: settings.audioPeakSmoothing,
        orientationBaseSpeed: settings.orientationBaseSpeed,
        orientationPeakMultiplier: settings.orientationPeakMultiplier,
        audioPeaks: Array.from(normalizedAudioPeaksRef.current ?? new Float32Array(0)),
        heroCircleLeftX: settings.heroCircleLeftX,
        heroCircleRightX: settings.heroCircleRightX,
        heroCircleY: settings.heroCircleY,
      });

      alert(String(message));
    } catch (e) {
      if (e !== "Export cancelled") {
        console.error("Export failed", e);
      }
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <Toaster richColors position="top-right" />

      <aside className="w-72 border-r flex flex-col bg-card h-full overflow-hidden">
        {/* Top actions — always visible */}
        <div className="shrink-0 p-4 border-b space-y-2">
          <div className="space-y-1">
            <h2 className="text-lg font-bold tracking-tight">Kaleidomo</h2>
            <p className="text-xs text-muted-foreground">Native Rust Engine</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={handlePickFile} className="w-full" size="sm">Select Image</Button>
            <Button variant="outline" size="sm" onClick={() => void renderPreview()} disabled={isRendering}>
              {isRendering ? "Rendering…" : "Preview"}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Button variant="ghost" size="sm" onClick={loadProject}>Load Project</Button>
            <Button variant="ghost" size="sm" onClick={saveProject}>Save Project</Button>
          </div>
        </div>

        {/* Tabbed settings — fills remaining height, tabs bar sticks, content scrolls */}
        <Tabs defaultValue="image" className="flex-1 min-h-0">
            <TabsList className="shrink-0">
              <TabsTrigger value="image">Image</TabsTrigger>
              <TabsTrigger value="video">Video</TabsTrigger>
              <TabsTrigger value="audio">Audio</TabsTrigger>
            </TabsList>

            {/* ── IMAGE TAB ── */}
            <TabsContent value="image" className="p-4 space-y-4">
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 block">Type</label>
                  <Select onValueChange={(v) => setKaleidoType(v)} value={kaleidoType}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Geometry</SelectLabel>
                        <SelectItem value="radial">Radial</SelectItem>
                        <SelectItem value="square">Square Tiling</SelectItem>
                        <SelectItem value="diamond">Diamond Tiling</SelectItem>
                        <SelectItem value="hexagonal">Hexagon Tiling</SelectItem>
                        <SelectItem value="hexagonal_flat_top">Hexagon (Flat Top)</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>

                <NumberSliderInput label="Tile Count" value={settings.tile_count} shouldLimit={!isUnlocked} limitedCap={3.5} min={0.1} max={64.0} step={0.1} onChange={(v) => setSettings((s) => ({ ...s, tile_count: v }))} unit="tiles" roundToInteger={false} />
                <NumberSliderInput label="Slices" value={count} shouldLimit={!isUnlocked} limitedCap={12} min={3} max={64} step={1} onChange={(v) => setCount(v)} roundToInteger={true} />
                <NumberSliderInput label="Zoom" value={settings.zoom} shouldLimit={!isUnlocked} limitedMin={0.8} limitedCap={3.0} min={0.001} max={32.0} step={0.0001} unit="x" onChange={(v) => setSettings((s) => ({ ...s, zoom: v }))} roundToInteger={false} sliderScale="splitLog" sliderMidpointValue={1.0} sliderMidpointPercent={zoomSliderMidpointPercent} setExternalValue={(v) => setSettings((s) => ({ ...s, zoom_min: v }))} setExternalValue2={(v) => setSettings((s) => ({ ...s, zoom_max: v }))} externalValueName="Min Zoom" externalValue2Name="Max Zoom" />
                <NumberSliderInput label="Rotation" value={settings.rotation} min={0.0} max={2 * Math.PI} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, rotation: v }))} unit="radians" roundToInteger={false} />

                <Card className="p-4">
                  <CardDescription>
                    <NumberSliderInput label="Offset X" value={settings.offset_x} min={-2000} max={2000} step={1} onChange={(v) => setSettings((s) => ({ ...s, offset_x: v }))} unit="px" roundToInteger={true} />
                    <NumberSliderInput label="Offset Y" value={settings.offset_y} min={-2000} max={2000} step={1} onChange={(v) => setSettings((s) => ({ ...s, offset_y: v }))} unit="px" roundToInteger={true} />
                  </CardDescription>
                  {!isUnlocked && (
                    <CardFooter>
                      <p className="text-xs text-muted-foreground">Offsets locked — upgrade for export.</p>
                    </CardFooter>
                  )}
                </Card>

                <NumberSliderInput label="Output Resolution" value={settings.resolution} min={8} shouldLimit={!isUnlocked} limitedCap={720} max={8192} step={8} onChange={(v) => setSettings((s) => ({ ...s, resolution: v }))} unit="px" roundToInteger={false} roundToMultipleOf={8} presetValues={[480, 540, 720, 1080, 1440, 2160, 4320]} />
                <AspectRatioPicker numerator={settings.ratio_num} denominator={settings.ratio_den} mode={settings.aspect_ratio_mode} onModeChange={(mode) => setSettings((s) => ({ ...s, aspect_ratio_mode: mode }))} onChange={(num, den) => setSettings((s) => ({ ...s, ratio_num: num, ratio_den: den }))} />
                <NumberSliderInput label="Color Shift" value={settings.hue_rotate} min={0} max={360} step={1} onChange={(v) => setSettings((s) => ({ ...s, hue_rotate: v }))} unit="°" roundToInteger={true} />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button onClick={handleExport} className="bg-primary">Export PNG</Button>
                <Button variant="outline" size="sm" onClick={resetImageSettings}>Reset</Button>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button variant="ghost" size="sm" onClick={loadImagePreset}>Load Preset</Button>
                <Button variant="ghost" size="sm" onClick={saveImagePreset}>Save Preset</Button>
              </div>
            </TabsContent>

            {/* ── VIDEO TAB ── */}
            <TabsContent value="video" className="p-4 space-y-4">
              <NumberSliderInput label="Animation Duration" value={settings.animation_duration} min={0.1} shouldLimit={!isUnlocked} limitedCap={12} max={600} step={0.1} onChange={(v) => setSettings((s) => ({ ...s, animation_duration: v }))} unit="s" roundToInteger={true} />
              <NumberSliderInput label="Still Frames at End" value={settings.still_frame_ending} min={0} max={360} step={1} onChange={(v) => setSettings((s) => ({ ...s, still_frame_ending: v }))} unit="frames" roundToInteger={true} />
              <NumberSliderInput label="FPS" value={settings.fps} min={1} max={144} step={1} onChange={(v) => setSettings((s) => ({ ...s, fps: v }))} unit="fps" roundToInteger={true} />
              <NumberSliderInput label="Quality" value={settings.quality} min={0.1} max={0.3} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, quality: v }))} unit="bpp/f" roundToInteger={false} />

              <hr className="opacity-20" />
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Rotation</p>
              <NumberSliderInput label="Rotation Range" value={settings.rotation_range} min={-720.0} max={720.0} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, rotation_range: v }))} unit="°" roundToInteger={false} />
              <NumberSliderInput label="Rotation Cycles" value={settings.rotation_cycles} min={0.1} max={16} step={0.1} onChange={(v) => setSettings((s) => ({ ...s, rotation_cycles: v }))} unit="cycles" roundToInteger={false} />
              <NumberSliderInput label="Rotation Phase Offset" value={settings.rotation_start_offset} min={-360} max={360} step={0.1} onChange={(v) => setSettings((s) => ({ ...s, rotation_start_offset: v }))} unit="cycles" roundToInteger={false} presetValues={[0, 90, 180]} />
              <Select onValueChange={(v) => setSettings((s) => ({ ...s, rotation_fn: v }))} value={settings.rotation_fn}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Rotation function" /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Rotation Function</SelectLabel>
                    <SelectItem value="triangle">Triangle</SelectItem>
                    <SelectItem value="sawtooth">Sawtooth</SelectItem>
                    <SelectItem value="sin">Sin</SelectItem>
                    <SelectItem value="sin2">Sin²</SelectItem>
                    <SelectItem value="cos">Cos</SelectItem>
                    <SelectItem value="-cos">-Cos</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>

              <hr className="opacity-20" />
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Color</p>
              <NumberSliderInput label="Color Range" value={settings.hue_range} min={-720.0} max={720.0} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, hue_range: v }))} unit="°" roundToInteger={false} presetValues={[-360, 0, 360]} />
              <NumberSliderInput label="Color Cycles" value={settings.hue_cycles} min={0} max={16.0} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, hue_cycles: v }))} roundToInteger={false} presetValues={[0, 1, 2, 3, 4, 5]} />
              <NumberSliderInput label="Color Phase Offset" value={settings.hue_start_offset} min={-360} max={360} step={0.1} onChange={(v) => setSettings((s) => ({ ...s, hue_start_offset: v }))} roundToInteger={false} presetValues={[0, 90, 180]} />
              <Select onValueChange={(v) => setSettings((s) => ({ ...s, hue_fn: v }))} value={settings.hue_fn}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Color function" /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Color Function</SelectLabel>
                    <SelectItem value="triangle">Triangle</SelectItem>
                    <SelectItem value="sawtooth">Sawtooth</SelectItem>
                    <SelectItem value="sin">Sin</SelectItem>
                    <SelectItem value="sin2">Sin²</SelectItem>
                    <SelectItem value="cos">Cos</SelectItem>
                    <SelectItem value="-cos">-Cos</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>

              <hr className="opacity-20" />
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Zoom</p>
              <NumberSliderInput label="Max Zoom" value={settings.zoom_max} shouldLimit={!isUnlocked} limitedCap={3.0} limitedMin={0.8} min={0.001} max={32.0} step={0.0001} onChange={(v) => setSettings((s) => ({ ...s, zoom_max: v }))} unit="x" roundToInteger={false} sliderScale="splitLog" sliderMidpointValue={1.0} sliderMidpointPercent={zoomSliderMidpointPercent} />
              <NumberSliderInput label="Min Zoom" value={settings.zoom_min} shouldLimit={!isUnlocked} limitedCap={3.0} limitedMin={0.8} min={0.001} max={32.0} step={0.0001} onChange={(v) => setSettings((s) => ({ ...s, zoom_min: v }))} unit="x" roundToInteger={false} sliderScale="splitLog" sliderMidpointValue={1.0} sliderMidpointPercent={zoomSliderMidpointPercent} />
              <Select onValueChange={(v) => setSettings((s) => ({ ...s, zoom_fn: v }))} value={settings.zoom_fn}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Zoom function" /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Zoom Function</SelectLabel>
                    <SelectItem value="triangle">Triangle</SelectItem>
                    <SelectItem value="sawtooth">Sawtooth</SelectItem>
                    <SelectItem value="sin">Sin</SelectItem>
                    <SelectItem value="sin2">Sin²</SelectItem>
                    <SelectItem value="cos">Cos</SelectItem>
                    <SelectItem value="-cos">-Cos</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <NumberSliderInput label="Zoom Offset" value={settings.zoom_start_offset} min={0.0} max={1.0} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, zoom_start_offset: v }))} unit="cycles" roundToInteger={false} />
              <NumberSliderInput label="Zoom Cycles" value={settings.num_zoom_loops} min={1} max={10} step={1} onChange={(v) => setSettings((s) => ({ ...s, num_zoom_loops: v }))} unit="cycles" roundToInteger={true} />

              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button onClick={handleVideo} className="bg-primary">Export MP4</Button>
                <Button variant="outline" size="sm" onClick={resetVideoSettings}>Reset</Button>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button variant="ghost" size="sm" onClick={loadVideoPreset}>Load Preset</Button>
                <Button variant="ghost" size="sm" onClick={saveVideoPreset}>Save Preset</Button>
              </div>
            </TabsContent>

            {/* ── AUDIO TAB ── */}
            <TabsContent value="audio" className="p-4 space-y-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Live Preview</p>

              {isTauriMacOS() && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Preview Resolution</p>
                  <div className="flex gap-1">
                    {([512, 720, 1080] as const).map((res) => (
                      <button
                        key={res}
                        type="button"
                        className={`flex-1 text-xs px-2 py-1 rounded border transition-colors ${nativePreviewRes === res ? "bg-primary text-primary-foreground border-primary" : "border-border bg-background hover:bg-accent"}`}
                        onClick={() => setNativePreviewRes(res)}
                      >
                        {res === 512 ? "Low" : res === 720 ? "Med" : "High"}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground opacity-60">
                    {nativePreviewRes === 512 ? "512px · 20fps" : nativePreviewRes === 720 ? "720px · 15fps" : "1080px · 10fps"}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{audioFileName ? `Loaded: ${audioFileName}` : "No audio loaded"}</p>
                {audioError && <p className="text-xs text-red-500">{audioError}</p>}
                <div className="flex gap-2 flex-wrap">
                  <button
                    type="button"
                    className="text-xs px-2 py-1 rounded border border-border bg-background hover:bg-accent cursor-pointer"
                    onClick={() => void handleAudioFileChange()}
                  >
                    Import Audio
                  </button>
                  {audioFileName && (
                    <>
                      <button type="button" className="text-xs px-2 py-1 rounded border border-border bg-background hover:bg-accent" onClick={handleToggleAudioPlayback}>
                        {audioPlaying ? "⏸ Pause" : "▶ Play"}
                      </button>
                      <button type="button" className="text-xs px-2 py-1 rounded border border-border bg-background hover:bg-accent" onClick={handleClearAudio}>
                        Clear
                      </button>
                    </>
                  )}
                </div>
                <Button variant="outline" size="sm" className="w-full" onClick={handleRestartLivePreview}>
                  ↺ Restart (sync audio + video)
                </Button>
              </div>

              <hr className="opacity-20" />
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reactive Settings</p>

              <div className="flex items-center gap-2">
                <input type="checkbox" id="audioReactiveEnabled" checked={settings.audioReactiveEnabled} onChange={(e) => setSettings((s) => ({ ...s, audioReactiveEnabled: e.target.checked }))} />
                <label htmlFor="audioReactiveEnabled" className="text-sm">Enable audio reactive</label>
              </div>

              <hr className="opacity-20" />
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Orientation</p>

              <NumberSliderInput label="Base Speed" value={settings.orientationBaseSpeed} min={0} max={500} step={1} onChange={(v) => setSettings((s) => ({ ...s, orientationBaseSpeed: v }))} unit="px/s" roundToInteger={false} />
              <NumberSliderInput label="Beat Drive" value={settings.orientationPeakMultiplier} min={0} max={5} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, orientationPeakMultiplier: v }))} unit="circles/s" roundToInteger={false} />

              <hr className="opacity-20" />
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Peak Detection</p>

              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Filter Slope</p>
                <div className="flex gap-1">
                  {([6, 12, 24, 48] as const).map((slope) => (
                    <button
                      key={slope}
                      type="button"
                      className={`flex-1 text-xs px-1 py-1 rounded border transition-colors ${settings.audioLowpassSlope === slope ? "bg-primary text-primary-foreground border-primary" : "border-border bg-background hover:bg-accent"}`}
                      onClick={() => setSettings((s) => ({ ...s, audioLowpassSlope: slope }))}
                    >
                      {slope}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground opacity-60">dB/octave</p>
              </div>
              <NumberSliderInput label="Filter Cutoff" value={settings.audioLowpassFreq} min={40} max={800} step={1} onChange={(v) => setSettings((s) => ({ ...s, audioLowpassFreq: v }))} unit="Hz" roundToInteger={true} />
              <NumberSliderInput label="Smoothing" value={settings.audioPeakSmoothing} min={0} max={0.98} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, audioPeakSmoothing: v }))} roundToInteger={false} />
              <NumberSliderInput label="Noise Gate" value={settings.audioPeakFloor} min={0} max={0.5} step={0.001} onChange={(v) => setSettings((s) => ({ ...s, audioPeakFloor: v }))} roundToInteger={false} />
              <NumberSliderInput label="Peak Clip" value={settings.audioPeakCeiling} min={0.05} max={1.0} step={0.001} onChange={(v) => setSettings((s) => ({ ...s, audioPeakCeiling: v }))} roundToInteger={false} />
            </TabsContent>
          </Tabs>
        </aside>

        <main className="flex-1 min-h-0 flex flex-col p-4 gap-4 overflow-y-auto bg-muted/20">
          <div className="h-[70vh] min-h-0 shrink-0 flex flex-col items-center justify-center border rounded-xl bg-background p-8 relative shadow-sm overflow-hidden">
            <h3 className="absolute top-4 left-4 text-xs font-bold uppercase opacity-30">
              1. Source Picker
            </h3>
            {imagePath ? (
              <WedgePicker
                imagePath={imagePath}
                count={count}
                settings={settings}
                onUpdate={setSettings}
                sourceRadiusPx={effectiveZoomState.sourceRadiusPx}
              />
            ) : (
              <p className="text-muted-foreground italic">
                Select an image to begin.
              </p>
            )}
          </div>

          <div className="h-[70vh] min-h-0 shrink-0 flex flex-col items-center justify-center border rounded-xl bg-background p-8 relative shadow-sm overflow-hidden">
            <h3 className="absolute top-4 left-4 text-xs font-bold uppercase opacity-30">
              2. Kaleidoscope Render
            </h3>
            {outputSrc ? (
              <img
                src={outputSrc}
                className="block max-w-full max-h-full object-contain shadow-2xl rounded-lg"
              />
            ) : (
              <p className="text-muted-foreground italic">
                Select an image or load a preset to begin.
              </p>
            )}
          </div>

          <div className="h-[70vh] min-h-0 shrink-0 flex flex-col items-center justify-center border rounded-xl bg-background p-8 relative shadow-sm overflow-hidden">
            <h3 className="absolute top-4 left-4 text-xs font-bold uppercase opacity-30">
              3. Live Preview {isTauriMacOS() ? "(Metal / Native)" : "(WebGPU)"}
            </h3>
            <div className="flex flex-col items-center gap-4 w-full h-full justify-center">
              {isTauriMacOS() ? (
                /* Native Metal path: engine draws RGBA directly into this canvas.
                   Canvas pixel dimensions are set by drawRgbaToCanvas on first frame.
                   CSS object-contain scales it to fill the panel. */
                <canvas
                  ref={liveCanvasRef}
                  width={512}
                  height={288}
                  className="block max-w-full max-h-full object-contain shadow-2xl rounded-lg"
                  style={{ background: "#000", width: "100%", height: "100%" }}
                />
              ) : (
                /* WASM WebGPU path: render directly into a <canvas> */
                <canvas
                  ref={liveCanvasRef}
                  width={1920}
                  height={1080}
                  className="block max-w-full max-h-full object-contain shadow-2xl rounded-lg"
                  style={{ background: "#000" }}
                />
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-accent"
                  onClick={() => void startLiveEngine()}
                >
                  Start Live Preview
                </button>
                <button
                  type="button"
                  className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-accent"
                  onClick={handleRestartLivePreview}
                >
                  ↺ Restart
                </button>
                <button
                  type="button"
                  className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-accent"
                  onClick={() => {
                    if (engineRef.current) {
                      try { engineRef.current.stop_animation(); } catch (_) { /* ignored */ }
                      try { engineRef.current.free?.(); } catch (_) { /* ignored */ }
                      engineRef.current = null;
                    }
                    if (nativeEngineRef.current) {
                      nativeEngineRef.current.stop();
                      nativeEngineRef.current = null;
                    }
                    setLivePreviewError(null);
                  }}
                >
                  Stop
                </button>
              </div>
              {livePreviewError ? (
                <p className="max-w-xl rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
                  {livePreviewError}
                </p>
              ) : null}
            </div>
          </div>

          <div className="text-center text-sm text-muted-foreground">
            <p>Brought to you by Altered Brain Chemistry</p>
          </div>
        </main>
    </div>
  );
}

export default Kaleidomo;