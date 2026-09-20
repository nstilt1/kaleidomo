// kaleidomo-session-context.tsx
import React from "react";

export type ExportDurationMode = "audio" | "seconds" | "infinite";
export type ReconstructionFilter = "nearest" | "bilinear" | "bicubic";
export type AnisotropyLevel = 1 | 2 | 4 | 8 | 16;
export type EdgePostProcess = "disabled" | "fxaa" | "smaa";

export type Settings = {
  x: number;
  y: number;
  rotation: number;
  resolution: number;
  zoom: number;
  tile_count: number;
  hue_rotate: number;
  recolor_enabled: boolean;
  recolor_seed: string;
  recolor_mode: "color_bands" | "bordered_cells" | "seeded_voronoi" | "connected_components" | "slic_superpixels";
  recolor_threshold: number;
  recolor_cell_size: number;
  ratio_num: number;
  ratio_den: number;
  offset_x: number;
  offset_y: number;
  aspect_ratio_mode: string;
  // Controls how final output dimensions (export image/video + editor canvas
  // preview) are derived. "resolution" = short-side resolution + aspect ratio
  // (existing behavior). "exact" = output_width/output_height are used as-is.
  // Note: `resolution` still always drives the kaleidoscope zoom/tile math
  // (see getEffectiveZoomAndSourceRadius) regardless of dimension_mode — it is
  // only the *output pixel size* that this mode affects.
  dimension_mode: "resolution" | "exact";
  // Used when dimension_mode === "exact"
  output_width: number;
  output_height: number;
  still_frame_ending: number;
  fps: number;
  quality: number;
  zoom_max: number;
  zoom_min: number;
  zoom_fn: string;
  zoom_start_offset: number;
  // Cycles per second — replaces num_zoom_loops / animation_duration
  zoom_cps: number;
  // Rotation modulation
  rotation_range: number;
  rotation_start_offset: number;
  rotation_fn: string;
  // Cycles per second — replaces rotation_cycles / animation_duration
  rotation_cps: number;
  rotationRateUnit: "cycles/s" | "degrees/s" | "s/cycle";
  // Hue modulation
  hue_range: number;
  hue_start_offset: number;
  hue_fn: string;
  // Cycles per second — replaces hue_cycles / animation_duration
  hue_cps: number;
  colorRateUnit: "cycles/s" | "degrees/s" | "s/cycle";
  // Export duration — controls video length only, not live preview
  exportDurationMode: ExportDurationMode;
  // Used when exportDurationMode === "seconds"
  export_duration_s: number;
  // Audio-reactive settings
  audioReactiveEnabled: boolean;
  audioOrientationAmount: number;
  audioReorientationAmount: number;
  audioPeakSmoothing: number;
  audioPeakFloor: number;
  audioPeakCeiling: number;
  // Low-pass filter cutoff for beat detection (Hz). Filters audio before peak extraction.
  audioLowpassFreq: number;
  // Low-pass filter slope in dB/octave. Higher = steeper, more bass-only isolation.
  // 6 = 1-pole RC, 12 = 2-pole, 24 = 4-pole (Butterworth), 48 = 8-pole (ladder-like)
  audioLowpassSlope: 6 | 12 | 24 | 48;
  // Base reorientation speed in the selected unit, independent of audio
  orientationBaseSpeed: number;
  orientationSpeedUnit: "px/s" | "s/cycle" | "cycles/s";
  rotationPhaseUnit: "degrees";
  // How much the normalized audio peak multiplies onto orientation + rotation
  orientationPeakMultiplier: number;
  // Hero circle / orientation settings
  heroCircleLeftX: number;
  heroCircleRightX: number;
  heroCircleY: number;
  // Starting angle on the hero circle in degrees (0° = leftmost point, clockwise).
  // Also passed to the WASM engine as orientation_start_offset (converted to [0,1) fraction).
  orientationPhase: number;
  // Arc range in degrees. Controls how much of the circle the point traverses each cycle.
  // 360° = full circle (with back-and-forth for non-sawtooth functions).
  // e.g. 90° with sin: oscillates over a 90° arc, starting from orientationPhase.
  orientationArcRange: number;
  // Waveform applied to the arc traversal. Sawtooth = continuous loop; sin/triangle = back-and-forth.
  orientationArcFn: string;

  // ── Enhancements (all default-disabled to match existing rendered output) ──
  // Bilinear texture filtering instead of nearest-neighbor sampling.
  anti_alias: boolean;
  // Internal supersampling factor (1 = disabled/native resolution, 2-4 = render
  // larger internally and downsample). Mirrors `KaleidoSettings::super_sample`.
  super_sample: 1 | 2 | 3 | 4;
  reconstruction_filter: ReconstructionFilter;
  derivative_mipmapping: boolean;
  anisotropy_level: AnisotropyLevel;
  edge_post_process: EdgePostProcess;
  taa_enabled: boolean;
  taa_feedback_alpha: number;
  // Corrects the kaleidoscope pattern so it isn't visually stretched into an
  // ellipse on non-square output canvases.
  aspect_correct: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  x: 100,
  y: 100,
  rotation: 0,
  resolution: 512,
  zoom: 2,
  tile_count: 1.0,
  hue_rotate: 0,
  recolor_enabled: false,
  recolor_seed: "kaleidomo",
  recolor_mode: "color_bands",
  recolor_threshold: 0.08,
  recolor_cell_size: 64,
  ratio_num: 9,
  ratio_den: 16,
  offset_x: 0,
  offset_y: 0,
  aspect_ratio_mode: "preset",
  dimension_mode: "resolution",
  output_width: 1920,
  output_height: 1080,
  still_frame_ending: 0,
  fps: 30,
  quality: 0.1,
  zoom_max: 1.0,
  zoom_min: 1.0,
  zoom_fn: "sin",
  zoom_start_offset: 0.0,
  zoom_cps: 0.0,
  rotation_range: 360,
  rotation_start_offset: 0,
  rotation_fn: "sin",
  rotation_cps: 0.0,
  rotationRateUnit: "cycles/s",
  hue_range: 360,
  hue_start_offset: 0,
  hue_fn: "sawtooth",
  hue_cps: 0.0,
  colorRateUnit: "cycles/s",
  exportDurationMode: "seconds",
  export_duration_s: 12,
  audioReactiveEnabled: false,
  audioOrientationAmount: 0.15,
  audioReorientationAmount: 0.05,
  audioPeakSmoothing: 0.75,
  audioPeakFloor: 0.02,
  audioPeakCeiling: 0.7,
  audioLowpassFreq: 169,
  audioLowpassSlope: 24,
  orientationBaseSpeed: 0.0,
  orientationSpeedUnit: "px/s",
  rotationPhaseUnit: "degrees",
  orientationPeakMultiplier: 0.0,
  // Hero circle defaults match the hardcoded values in wasm.rs / page.tsx
  heroCircleLeftX: 515.1039592844847,
  heroCircleRightX: 1547.0,
  heroCircleY: 755.3734001945962,
  orientationPhase: 0.0,
  orientationArcRange: 360.0,
  orientationArcFn: "sawtooth",
  anti_alias: true,
  super_sample: 1,
  reconstruction_filter: "bilinear",
  derivative_mipmapping: true,
  anisotropy_level: 1,
  edge_post_process: "disabled",
  taa_enabled: false,
  taa_feedback_alpha: 0.9,
  aspect_correct: false,
};

type KaleidomoSessionContextValue = {
  imagePath: string;
  setImagePath: React.Dispatch<React.SetStateAction<string>>;
  imageSrc: string;
  setImageSrc: React.Dispatch<React.SetStateAction<string>>;
  outputSrc: string;
  setOutputSrc: React.Dispatch<React.SetStateAction<string>>;
  count: number;
  setCount: React.Dispatch<React.SetStateAction<number>>;
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  kaleidoType: string;
  setKaleidoType: React.Dispatch<React.SetStateAction<string>>;
  imgWidth: number;
  setImgWidth: React.Dispatch<React.SetStateAction<number>>;
  imgHeight: number;
  setImgHeight: React.Dispatch<React.SetStateAction<number>>;
  isRendering: boolean;
  setIsRendering: React.Dispatch<React.SetStateAction<boolean>>;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
};

type HistorySnapshot = {
  settings: Settings;
  count: number;
  kaleidoType: string;
};

const HISTORY_LIMIT = 100;
const HISTORY_COALESCE_MS = 300;

const KaleidomoSessionContext = React.createContext<KaleidomoSessionContextValue | null>(null);

export function KaleidomoProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [imagePath, setImagePath] = React.useState("");
  const [imageSrc, setImageSrc] = React.useState("");
  const [outputSrc, setOutputSrc] = React.useState("");
  const [count, setCountState] = React.useState(6);
  const [settings, setSettingsState] = React.useState<Settings>(DEFAULT_SETTINGS);
  const [kaleidoType, setKaleidoTypeState] = React.useState("radial");
  const [imgWidth, setImgWidth] = React.useState(0);
  const [imgHeight, setImgHeight] = React.useState(0);
  const [isRendering, setIsRendering] = React.useState(false);
  const stateRef = React.useRef<HistorySnapshot>({
    settings: DEFAULT_SETTINGS,
    count: 6,
    kaleidoType: "radial",
  });
  const undoStackRef = React.useRef<HistorySnapshot[]>([]);
  const redoStackRef = React.useRef<HistorySnapshot[]>([]);
  const lastChangeRef = React.useRef({ group: "", time: 0 });
  const [historyVersion, setHistoryVersion] = React.useState(0);

  const recordChange = React.useCallback((group: keyof HistorySnapshot) => {
    const now = Date.now();
    const last = lastChangeRef.current;
    if (last.group !== group || now - last.time > HISTORY_COALESCE_MS) {
      undoStackRef.current.push(stateRef.current);
      if (undoStackRef.current.length > HISTORY_LIMIT) undoStackRef.current.shift();
    }
    lastChangeRef.current = { group, time: now };
    redoStackRef.current = [];
    setHistoryVersion((version) => version + 1);
  }, []);

  const setSettings = React.useCallback<React.Dispatch<React.SetStateAction<Settings>>>((update) => {
    const current = stateRef.current.settings;
    const next = typeof update === "function" ? update(current) : update;
    if (Object.is(current, next)) return;
    recordChange("settings");
    stateRef.current = { ...stateRef.current, settings: next };
    setSettingsState(next);
  }, [recordChange]);

  const setCount = React.useCallback<React.Dispatch<React.SetStateAction<number>>>((update) => {
    const current = stateRef.current.count;
    const next = typeof update === "function" ? update(current) : update;
    if (Object.is(current, next)) return;
    recordChange("count");
    stateRef.current = { ...stateRef.current, count: next };
    setCountState(next);
  }, [recordChange]);

  const setKaleidoType = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((update) => {
    const current = stateRef.current.kaleidoType;
    const next = typeof update === "function" ? update(current) : update;
    if (Object.is(current, next)) return;
    recordChange("kaleidoType");
    stateRef.current = { ...stateRef.current, kaleidoType: next };
    setKaleidoTypeState(next);
  }, [recordChange]);

  const restoreSnapshot = React.useCallback((snapshot: HistorySnapshot) => {
    stateRef.current = snapshot;
    setSettingsState(snapshot.settings);
    setCountState(snapshot.count);
    setKaleidoTypeState(snapshot.kaleidoType);
    lastChangeRef.current = { group: "", time: 0 };
    setHistoryVersion((version) => version + 1);
  }, []);

  const undo = React.useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(stateRef.current);
    restoreSnapshot(previous);
  }, [restoreSnapshot]);

  const redo = React.useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(stateRef.current);
    restoreSnapshot(next);
  }, [restoreSnapshot]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.matches("input, textarea")) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;

  const value = React.useMemo(
    () => ({
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
      canUndo,
      canRedo,
      undo,
      redo,
    }),
    [
      imagePath,
      imageSrc,
      outputSrc,
      count,
      settings,
      kaleidoType,
      imgWidth,
      imgHeight,
      isRendering,
      historyVersion,
      canUndo,
      canRedo,
      undo,
      redo,
    ]
  );

  return (
    <KaleidomoSessionContext.Provider value={value}>
      {children}
    </KaleidomoSessionContext.Provider>
  );
}

export function useKaleidomoSession() {
  const context = React.useContext(KaleidomoSessionContext);
  if (!context) {
    throw new Error("useKaleidomoSession must be used within KaleidomoProvider");
  }
  return context;
}
