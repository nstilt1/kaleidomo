import React from "react";

export type ExportDurationMode = "audio" | "seconds" | "infinite";

export type Settings = {
  x: number;
  y: number;
  rotation: number;
  resolution: number;
  zoom: number;
  tile_count: number;
  hue_rotate: number;
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
  // Hue modulation
  hue_range: number;
  hue_start_offset: number;
  hue_fn: string;
  // Cycles per second — replaces hue_cycles / animation_duration
  hue_cps: number;
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
  // Base reorientation speed (orientation cycles per second, independent of audio)
  orientationBaseSpeed: number;
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
};

export const DEFAULT_SETTINGS: Settings = {
  x: 100,
  y: 100,
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
  hue_range: 360,
  hue_start_offset: 0,
  hue_fn: "sawtooth",
  hue_cps: 0.0,
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
  orientationPeakMultiplier: 0.0,
  // Hero circle defaults match the hardcoded values in wasm.rs / page.tsx
  heroCircleLeftX: 515.1039592844847,
  heroCircleRightX: 1547.0,
  heroCircleY: 755.3734001945962,
  orientationPhase: 0.0,
  orientationArcRange: 360.0,
  orientationArcFn: "sawtooth",
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
};

const KaleidomoSessionContext = React.createContext<KaleidomoSessionContextValue | null>(null);

export function KaleidomoProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [imagePath, setImagePath] = React.useState("");
  const [imageSrc, setImageSrc] = React.useState("");
  const [outputSrc, setOutputSrc] = React.useState("");
  const [count, setCount] = React.useState(6);
  const [settings, setSettings] = React.useState<Settings>(DEFAULT_SETTINGS);
  const [kaleidoType, setKaleidoType] = React.useState("radial");
  const [imgWidth, setImgWidth] = React.useState(0);
  const [imgHeight, setImgHeight] = React.useState(0);
  const [isRendering, setIsRendering] = React.useState(false);

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