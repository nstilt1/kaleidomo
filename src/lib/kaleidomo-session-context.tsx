import React from "react";

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
  still_frame_ending: number;
  fps: number;
  quality: number;
  zoom_max: number;
  zoom_min: number;
  zoom_fn: string;
  zoom_start_offset: number;
  num_zoom_loops: number;
  animation_duration: number;
  rotation_range: number;
  rotation_cycles: number;
  rotation_start_offset: number;
  rotation_fn: string;
  hue_range: number;
  hue_cycles: number;
  hue_start_offset: number;
  hue_fn: string;
  // Audio-reactive settings (optional for backward compatibility)
  audioReactiveEnabled: boolean;
  audioOrientationAmount: number;
  audioReorientationAmount: number;
  audioPeakSmoothing: number;
  audioPeakFloor: number;
  audioPeakCeiling: number;
};

export const DEFAULT_SETTINGS: Settings = {
  x: 0,
  y: 0,
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
  still_frame_ending: 0,
  fps: 30,
  quality: 0.1,
  zoom_max: 1.0,
  zoom_min: 1.0,
  zoom_fn: "sin",
  zoom_start_offset: 0.0,
  num_zoom_loops: 1,
  animation_duration: 12,
  rotation_range: 360,
  rotation_cycles: 1,
  rotation_start_offset: 0,
  rotation_fn: "sin",
  hue_range: 360,
  hue_cycles: 1,
  hue_start_offset: 0,
  hue_fn: "sawtooth",
  audioReactiveEnabled: false,
  audioOrientationAmount: 0.15,    // moderate kick when enabled
  audioReorientationAmount: 0.05,  // subtle rotation nudge
  audioPeakSmoothing: 0.75,        // smooths out transients well
  audioPeakFloor: 0.02,            // ignore near-silence
  audioPeakCeiling: 0.7,           // peaks above 70% amplitude = full effect
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