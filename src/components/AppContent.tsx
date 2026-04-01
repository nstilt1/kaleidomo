import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from '@tauri-apps/plugin-dialog';
import { WedgePicker } from "@/components/WedgePicker";
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { NumberSliderInput } from "@/components/NumberSliderInput";
import { AspectRatioPicker } from "@/components/AspectRatioPicker";
import { Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { initGpuSetting } from "@/lib/utils";
import { PerformanceMode, PerformanceModeCard } from "@/components/PerformanceModeCard";
import React from "react";
import { Toaster } from "@/components/ui/sonner";
import LicenseActivationCard from "@/components/licensing/LicenseActivationCard";
import { useLicense } from "@/lib/license-context";

export async function setupAppMenu() {
  const aboutSubmenu = await Submenu.new({
    text: "App",
    items: [],
  });

  const fileSubmenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({
        id: "load-image-preset",
        text: "Load Image Preset...",
        action: () => {
          window.dispatchEvent(new CustomEvent("menu-load-image-preset"));
        },
      }),
      await MenuItem.new({
        id: "save-image-preset",
        text: "Save Image Preset",
        action: () => {
          window.dispatchEvent(new CustomEvent("menu-save-image-preset"));
        },
      }),
      await MenuItem.new({
        id: "load-video-preset",
        text: "Load Video Preset...",
        action: () => {
          window.dispatchEvent(new CustomEvent("menu-load-video-preset"));
        },
      }),
      await MenuItem.new({
        id: "save-video-preset",
        text: "Save Video Preset",
        action: () => {
          window.dispatchEvent(new CustomEvent("menu-save-video-preset"));
        },
      }),
      await MenuItem.new({
        id: "load-project-preset",
        text: "Load Project...",
        action: () => {
          window.dispatchEvent(new CustomEvent("menu-load-project"));
        },
      }),
      await MenuItem.new({
        id: "save-project-preset",
        text: "Save Project",
        action: () => {
          window.dispatchEvent(new CustomEvent("menu-save-project"));
        },
      }),
    ],
  });

  const menu = await Menu.new({
    items: [aboutSubmenu, fileSubmenu],
  });

  await menu.setAsAppMenu();
}

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

type Settings = { 
  x: number; 
  y: number; 
  rotation: number, 
  resolution: number, 
  zoom: number, 
  tile_count: number, 
  hue_rotate: number, 
  ratio_num: number, 
  ratio_den: number, offset_x: number, 
  offset_y: number, 
  aspect_ratio_mode: string, 
  frame_count: number, 
  still_frame_ending: number, 
  // video settings
  fps: number, 
  quality: number, 
  triangle_rotation_degrees_per_frame: number, 
  hue_rotation_degrees_per_frame: number, 
  zoom_max: number, 
  zoom_min: number, 
  zoom_fn: string, 
  zoom_start_offset: number, 
  num_zoom_loops: number 
};

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
  "frame_count",
  "still_frame_ending",
  "fps",
  "quality",
  "triangle_rotation_degrees_per_frame",
  "hue_rotation_degrees_per_frame",
  "zoom_max",
  "zoom_min",
  "zoom_fn",
  "zoom_start_offset",
  "num_zoom_loops",
] as const satisfies readonly (keyof Settings)[];

const DEFAULT_SETTINGS: Settings = {
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
  frame_count: 360,
  still_frame_ending: 0,
  // video settings
  fps: 30,
  quality: 0.1,
  triangle_rotation_degrees_per_frame: 1.0,
  hue_rotation_degrees_per_frame: 1.0,
  zoom_max: 1.0,
  zoom_min: 1.0,
  zoom_fn: "sin",
  zoom_start_offset: 0.0,
  num_zoom_loops: 1,
};

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

function AppContent() {
  // State definitions
  const [imagePath, setImagePath] = useState<string>("");
  const [_imageSrc, setImageSrc] = useState<string>(""); // For previewing original
  const [outputSrc, setOutputSrc] = useState<string>(""); // Result from Rust
  const [count, setCount] = useState<number>(6);
  const [settings, setSettings] = useState({ x: 100, y: 100, rotation: 0, resolution: 512, zoom: 2, tile_count: 1.0, hue_rotate: 0, ratio_num: 9, ratio_den: 16, offset_x: 0, offset_y: 0, aspect_ratio_mode: "preset", frame_count: 360, still_frame_ending: 0, fps: 30, quality: 0.1, triangle_rotation_degrees_per_frame: 1.0, hue_rotation_degrees_per_frame: 1.0, zoom_max: 1.0, zoom_min: 1.0, zoom_fn: "sin", zoom_start_offset: 0.0, num_zoom_loops: 1 });
  const [kaleidoType, setKaleidoType] = useState<string>("radial");
  const [imgWidth, setImgWidth] = useState<number>(0);
  const [imgHeight, setImgHeight] = useState<number>(0);
  const [performanceMode, setPerformanceMode] = React.useState<PerformanceMode>("gpu");
  const {isUnlocked, licenseType} = useLicense();
  const [version, setVersion] = React.useState("");

  useEffect(() => {
    void setupAppMenu();
    initGpuSetting();
    invoke<string>("current_version")
        .then(setVersion)
        .catch(() => setVersion(""));
  }, []);

  useEffect(() => {
    const onLoadImagePreset = () => {
      void loadImagePreset();
    };

    const onSaveImagePreset = () => {
      void saveImagePreset();
    }

    const onLoadVideoPreset = () => {
      void loadVideoPreset();
    };

    const onSaveVideoPreset = () => {
      void saveVideoPreset();
    }

    const onLoadProject = () => {
      void loadProject();
    };

    const onSaveProject = () => {
      void saveProject();
    }

    window.addEventListener("menu-load-image-preset", onLoadImagePreset);
    window.addEventListener("menu-save-image-preset", onSaveImagePreset);
    window.addEventListener("menu-load-video-preset", onLoadVideoPreset);
    window.addEventListener("menu-save-video-preset", onSaveVideoPreset);
    window.addEventListener("menu-load-project", onLoadProject);
    window.addEventListener("menu-save-project", onSaveProject);

    return () => {
      window.removeEventListener("menu-load-image-preset", onLoadImagePreset);
      window.removeEventListener("menu-load-video-preset", onLoadVideoPreset);
      window.removeEventListener("menu-save-image-preset", onSaveImagePreset);
      window.removeEventListener("menu-save-video-preset", onSaveVideoPreset);
      window.removeEventListener("menu-load-project", onLoadProject);
      window.removeEventListener("menu-save-project", onSaveProject);
    };
  }, []);

  const handlePickFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
    });

    if (selected && typeof selected === 'string') {
      const assetUrl = convertFileSrc(selected);
      setImagePath(selected);
      setImageSrc(assetUrl);

      // Get dimensions to center the wedge initially
      const img = new Image();
      img.src = assetUrl;
      img.onload = () => {
        setImgWidth(img.naturalWidth);
        setImgHeight(img.naturalHeight);
      };
      /*
      img.onload = () => {
        setSettings({
          x: img.naturalWidth / 2,
          y: img.naturalHeight / 2,
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
          
        });
      };
        */
      invoke("select_image", { path: selected }).catch((err) => {
        console.error("Failed to select image:", err);
      });
      await handleRender();
    }
  };

  const resetImageSettings = () => {
    setSettings({
      ...settings,
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
    });
  };

  const resetVideoSettings = () => {
    setSettings({
      ...settings,
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
    });
  };

  // Generate Kaleidoscope (Rust Call)
  const handleRender = async () => {
    let {width, height} = calculateDimensions(settings);
    try {
      const result: string = await invoke('generate_kaleidoscope', {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        count: count,
        outputSizeH: height,
        outputSizeW: width,
        offsetX: settings.offset_x,
        offsetY: settings.offset_y,
        zoom: settings.zoom,
        kaleidoType: kaleidoType,
        tileCount: settings.tile_count,
        hueRotation: settings.hue_rotate,
      });
      setOutputSrc(result);
    } catch (e) {
      console.error("Render failed", e);
    }
  };

  useEffect(() => {
    if (!imagePath) return;

    const timer = setTimeout(() => {
      handleRender();
    }, 35); // 35ms delay creates a responsive 20fps feel

    return () => clearTimeout(timer);
  }, [settings, count, kaleidoType, imagePath]); // Re-run whenever wedge moves or count changes

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

  const loadImageFromPath = async (
    originalPath: string
  ): Promise<LoadedImage | null> => {
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

    if (!selected || typeof selected !== "string") {
      return;
    }

    try {
      const content = await readTextFile(selected);
      const parsed: unknown = JSON.parse(content);

      if (!isRecord(parsed)) {
        throw new Error("Preset file is not a valid object.");
      }

      const mergedSettings = mergeSettingsWithBase(settings, parsed.settings);
      setSettings(mergedSettings);

      if (typeof parsed.count === "number" && Number.isFinite(parsed.count)) {
        setCount(parsed.count);
      }

      if (typeof parsed.kaleidoType === "string") {
        setKaleidoType(parsed.kaleidoType);
      }

      if (typeof parsed.imagePath === "string" && parsed.imagePath) {
        try {
          const loadedImage = await loadImageFromPath(parsed.imagePath);

          if (loadedImage) {
            setImagePath(loadedImage.imagePath);
            setImageSrc(loadedImage.imageSrc);
            setImgWidth(loadedImage.width);
            setImgHeight(loadedImage.height);
            invoke("select_image", { path: loadedImage.imagePath }).catch((err) => {
              console.error("Failed to select image:", err);
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

    if (!selected || typeof selected !== "string") {
      return;
    }

    try {
      const content = await readTextFile(selected);
      const parsed: unknown = JSON.parse(content);

      if (!isRecord(parsed)) {
        throw new Error("Preset file is not a valid object.");
      }

      const mergedSettings = mergeSettingsWithBase(settings, parsed.settings);
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

    if (!selected || typeof selected !== "string") {
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
        typeof parsed.kaleidoType === "string" ? parsed.kaleidoType : "default";

      const nextSettings = mergeSettingsWithBase(DEFAULT_SETTINGS, parsed.settings);

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
            invoke("select_image", { path: loadedImage.imagePath }).catch((err) => {
              console.error("Failed to select image:", err);
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

  // Save Project JSON
  const saveProject = async () => {
    const filePath = await save({ filters: [{ name: "JSON", extensions: ['kmo.json'] }] });
    if (filePath) {
      const data = JSON.stringify({ imagePath, count, settings, kaleidoType });
      await writeTextFile(filePath, data);
    }
  };

    const calculateDimensions = (settings: {
        resolution: number
        ratio_num: number
        ratio_den: number
    }) => {
        const short = Math.max(1, settings.resolution)
        const num = Math.max(1, settings.ratio_num)
        const den = Math.max(1, settings.ratio_den)

        let width: number
        let height: number

        if (num >= den) {
            // Landscape or square
            height = short
            width = (short * num) / den

            // Round width only
            width = roundToNearestMultiple(width, 8)

            // Recompute height to preserve ratio
            height = Math.floor((width * den) / num)
        } else {
            // Portrait
            width = short
            height = (short * den) / num

            // Round width only (width is the short side here)
            width = roundToNearestMultiple(width, 8)

            // Recompute height to preserve ratio
            height = Math.floor((width * den) / num)
        }

        return {
            width,
            height,
        }
    }

  const handleExport = async () => {
    if (!imagePath) return;
    
    let {width, height} = calculateDimensions(settings);
    try {
      const message = await invoke('export_kaleidoscope', {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        zoom: settings.zoom,
        count: count,
        outputSizeH: height,
        outputSizeW: width,
        offsetX: settings.offset_x,
        offsetY: settings.offset_y,
        kaleidoType: kaleidoType,
        tileCount: settings.tile_count,
        hueRotation: settings.hue_rotate,
      });
      alert(message);
    } catch (e) {
      if (e !== "Export cancelled") {
        console.error("Export failed", e);
      }
    }
  };

  const handleVideo = async () => {
    if (!imagePath) return;
    
    let {width, height} = calculateDimensions(settings);
    try {
      const message = await invoke('generate_video', {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        zoom: settings.zoom,
        count: count,
        outputSizeH: height,
        outputSizeW: width,
        offsetX: settings.offset_x,
        offsetY: settings.offset_y,
        kaleidoType: kaleidoType,
        tileCount: settings.tile_count,
        hueRotation: settings.hue_rotate,
        frameCount: settings.frame_count,
        stillFrameEnding: settings.still_frame_ending,
        fps: settings.fps,
        quality: settings.quality,
        triangleRotationDegreesPerFrame: settings.triangle_rotation_degrees_per_frame,
        hueRotationDegreesPerFrame: settings.hue_rotation_degrees_per_frame,
        zoomMax: settings.zoom_max,
        zoomMin: settings.zoom_min,
        zoomFn: settings.zoom_fn,
        zoomStartOffset: settings.zoom_start_offset,
        numZoomLoops: settings.num_zoom_loops,
      });
      alert(message);
    } catch (e) {
      if (e !== "Export cancelled") {
        console.error("Export failed", e);
      }
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-8">
      <Toaster richColors position="top-right" />
      <div className="max-w-2xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold tracking-tight">
            Kaleidomo v{version}
          </h1>
          <p className="text-xl text-muted-foreground">
            Made with <del>love</del> rust
          </p>
          <div className="flex justify-center gap-2">
            <Badge variant="secondary">Tauri v2</Badge>
            <Badge variant="secondary">React 18</Badge>
            <Badge variant="secondary">TypeScript</Badge>
            <Badge variant="secondary">Rust</Badge>
          </div>
        </div>

        {/* Demo Card */}
        <LicenseActivationCard />

        {/* Performance Mode Card */}
        <div className="max-w-xl p-6">
          <PerformanceModeCard
            defaultMode="gpu"
            onModeChange={setPerformanceMode}
          />
          <div className="mt-4 text-sm text-muted-foreground">
            Current mode: {performanceMode === "gpu" ? "GPU" : "CPU (SIMD)"}
          </div>
        </div>

        {/* Features */}
        
      </div>

      <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
        {/* Narrower Sidebar (w-64 = 16rem / 256px) */}
        <aside className="w-64 border-r p-6 flex flex-col gap-6 bg-card overflow-y-auto">
          <div className="space-y-1">
            <h2 className="text-xl font-bold tracking-tight">Kaleidomo</h2>
            <p className="text-xs text-muted-foreground">Native Rust Engine</p>
          </div>

          <Button onClick={handlePickFile} className="w-full">Select Image</Button>
          <Button onClick={resetImageSettings} className="w-full">Reset Controls</Button>
          {/*<div className="mt-auto grid grid-cols-2 gap-2">*/}
            <Button variant="ghost" size="sm" onClick={loadImagePreset}>Load Image Preset</Button>
            <Button variant="ghost" size="sm" onClick={saveImagePreset}>Save Image Preset</Button>
          {/*</div>*/}
          {/*<div className="mt-auto grid grid-cols-2 gap-2">*/}
            <Button variant="ghost" size="sm" onClick={loadProject}>Load Project</Button>
            <Button variant="ghost" size="sm" onClick={saveProject}>Save Project</Button>
          {/*</div>*/}
          <hr className="opacity-20" />

          {/* Group 1: Geometry */}
          <div className="space-y-4">
            <div className="flex justify-between items-center"><label>Type</label></div>
            <Select onValueChange={(v) => setKaleidoType(v)} defaultValue={kaleidoType}>
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
                  <SelectItem value="hexagonal_flat_top">Hexagon Tiling (Flat Top)</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>

            <NumberSliderInput
              label="Slices"
              value={count}
              min={3}
              max={isUnlocked ? 12 : 64}
              step={1}
              onChange={(v) => setCount(v)}
              roundToInteger={true}
              />

            <NumberSliderInput
              label="Sample Radius"
              value={settings.zoom}
              min={isUnlocked && licenseType != "trial" ? 0.01 : 0.8}
              max={isUnlocked && licenseType != "trial" ? 32.0 : 3.0}
              step={0.01}
              unit="x"
              onChange={(v) => setSettings(s => ({...s, zoom: v}))}
              roundToInteger={false}
              setExternalValue={(v) =>
                setSettings((s) => ({
                  ...s,
                  zoom_min: v,
                }))
              }
              setExternalValue2={(v) =>
                setSettings((s) => ({
                  ...s,
                  zoom_max: v,
                }))
              }
              externalValueName="Min Zoom"
              externalValue2Name="Max Zoom"
              />

            <NumberSliderInput
              label="Rotation"
              value={settings.rotation}
              min={0.0}
              max={2 * Math.PI}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, rotation: v}))}
              unit="radians"
              roundToInteger={false}
              />

            <NumberSliderInput 
              label="Offset X"
              value={settings.offset_x}
              min={-2000}
              max={2000}
              step={1}
              onChange={(v) => setSettings(s => ({...s, offset_x: v}))}
              unit="px"
              roundToInteger={true}
            />
            
            <NumberSliderInput
              label="Offset Y"
              value={settings.offset_y}
              min={-2000}
              max={2000}
              step={1}
              onChange={(v) => setSettings(s => ({...s, offset_y: v}))}
              unit="px"
              roundToInteger={true}
            />
          </div>

          {/* Group 2: Output */}
          <div className="space-y-4">
            <NumberSliderInput
              label="Output Resolution (length of smaller side)"
              value={settings.resolution}
              min={8}
              max={isUnlocked && licenseType === "perpetual" ? 8192 : 720}
              step={8}
              onChange={(v) => setSettings(s => ({...s, resolution: v}))}
              unit="px"
              roundToInteger={false}
              roundToMultipleOf={8}
            />
          </div>

          <div className="space-y-4">
            <AspectRatioPicker
              numerator={settings.ratio_num}
              denominator={settings.ratio_den}
              mode={settings.aspect_ratio_mode}
              onModeChange={(mode) =>
                setSettings((s) => ({
                  ...s,
                  aspect_ratio_mode: mode,
                }))
              }
                onChange={(numerator, denominator) => {
                  setSettings((s) => ({
                    ...s,
                    ratio_num: numerator,
                    ratio_den: denominator,
                  }));
                }}
            />
          </div>

          <div className="space-y-4">
            <NumberSliderInput
              label="Tile Count"
              value={settings.tile_count}
              min={0.1}
              max={isUnlocked ? 64.0 : 3.5}
              step={0.1}
              onChange={(v) => setSettings(s => ({...s, tile_count: v}))}
              unit="tiles"
              roundToInteger={false}
              />
          </div>

          <div className="space-y-4">
            <NumberSliderInput
              label="Color Shift"
              value={settings.hue_rotate}
              min={0}
              max={360}
              step={1}
              onChange={(v) => setSettings(s => ({...s, hue_rotate: v}))}
              unit="degrees"
              roundToInteger={true}
              />
          </div>

          <div className="flex flex-col gap-2 pt-4">
            <Button onClick={handleRender} variant="outline">Refresh Preview</Button>
            <Button onClick={handleExport} className="bg-primary">Export PNG</Button>
          </div>
          <div className="mt-auto grid grid-cols-2 gap-2">
            <Button variant="ghost" size="sm" onClick={loadProject}>Load Project</Button>
            <Button variant="ghost" size="sm" onClick={saveProject}>Save Project</Button>
          </div>

          <hr className="opacity-20" />
          {/*<div className="mt-auto grid grid-cols-2 gap-2">*/}
            <Button variant="ghost" size="sm" onClick={loadVideoPreset}>Load Video Preset</Button>
            <Button variant="ghost" size="sm" onClick={saveVideoPreset}>Save Video Preset</Button>
          {/*</div>*/}
          {/* Video settings */}
          <div className="space-y-4">
            <div className="flex justify-between items-center"><label>Video Settings</label>
            </div>
            <NumberSliderInput
              label="Frame Count"
              value={settings.frame_count}
              min={1}
              max={isUnlocked && licenseType == "perpetual" ? 7200 : 1800}
              step={1}
              onChange={(v) => setSettings(s => ({...s, frame_count: v}))}
              unit="frames"
              roundToInteger={true}
              />
            <NumberSliderInput
              label="# Still Frames at End"
              value={settings.still_frame_ending}
              min={0}
              max={360}
              step={1}
              onChange={(v) => setSettings(s => ({...s, still_frame_ending: v}))}
              unit="frames"
              roundToInteger={true}
              />
            <NumberSliderInput
              label="Frames Per Second (FPS)"
              value={settings.fps}
              min={1}
              max={144}
              step={1}
              onChange={(v) => setSettings(s => ({...s, fps: v}))}
              unit="frames per second"
              roundToInteger={true}
              />
            <NumberSliderInput
              label="Quality (bits per pixel per frame)"
              value={settings.quality}
              min={0.1}
              max={0.3}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, quality: v}))}
              unit="bpp/frame"
              roundToInteger={false}
              />
            <NumberSliderInput
              label="Angle rotation rate"
              value={settings.triangle_rotation_degrees_per_frame}
              min={-30.0}
              max={30.0}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, triangle_rotation_degrees_per_frame: v}))}
              unit="degrees per frame"
              roundToInteger={false}
              />
            <NumberSliderInput
              label="Color changing rate"
              value={settings.hue_rotation_degrees_per_frame}
              min={-30.0}
              max={30.0}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, hue_rotation_degrees_per_frame: v}))}
              unit="degrees per frame"
              roundToInteger={false}
              />
            <NumberSliderInput
              label="Max Zoom"
              value={settings.zoom_max}
              min={isUnlocked && licenseType != "trial" ? 0.01 : 0.8}
              max={isUnlocked && licenseType != "trial" ? 32.0 : 3.0}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, zoom_max: v}))}
              unit="x"
              roundToInteger={false}
              />
            <NumberSliderInput
              label="Min Zoom"
              value={settings.zoom_min}
              min={isUnlocked && licenseType != "trial" ? 0.01 : 0.8}
              max={isUnlocked && licenseType != "trial" ? 32.0 : 3.0}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, zoom_min: v}))}
              unit="x"
              roundToInteger={false}
              />
            <Select onValueChange={(v) => setSettings(s => ({...s, zoom_fn: v}))} defaultValue={settings.zoom_fn}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select zoom function" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Zoom Function</SelectLabel>
                  <SelectItem value="sin">Sine Wave</SelectItem>
                  <SelectItem value="sawtooth">Linear/Triangle Wave</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <NumberSliderInput
              label="Zoom Offset"
              value={settings.zoom_start_offset}
              min={0.0}
              max={1.0}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, zoom_start_offset: v}))}
              unit="cycles"
              roundToInteger={false}
              />
            <NumberSliderInput
              label="# of Zoom Cycles"
              value={settings.num_zoom_loops}
              min={1}
              max={10}
              step={1}
              onChange={(v) => setSettings(s => ({...s, num_zoom_loops: v}))}
              unit="cycles"
              roundToInteger={true}
              />
          </div>
          <div className="flex flex-col gap-2 pt-4">
            <Button onClick={handleVideo} className="bg-primary">Export MP4</Button>
          </div>
          <div className="mt-auto grid grid-cols-2 gap-2">
            <Button variant="ghost" size="sm" onClick={loadProject}>Load Project</Button>
            <Button variant="ghost" size="sm" onClick={saveProject}>Save Project</Button>
          </div>
          <Button onClick={resetVideoSettings} className="w-full">Reset Video Settings</Button>
        </aside>

        {/* Main Content: Vertical Rows */}
        <main className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto bg-muted/20">
          {/* Row 1: Source Picker */}
          <div className="min-h-[500px] flex flex-col items-center justify-center border rounded-xl bg-background p-8 relative shadow-sm">
            <h3 className="absolute top-4 left-4 text-xs font-bold uppercase opacity-30">1. Source Picker</h3>
            {imagePath && (
              <WedgePicker 
                imagePath={imagePath} 
                count={count} 
                settings={settings} 
                onUpdate={setSettings} 
              />
            )}
          </div>

          {/* Row 2: Kaleidoscope Result */}
          <div className="min-h-[500px] flex flex-col items-center justify-center border rounded-xl bg-background p-8 relative shadow-sm">
            <h3 className="absolute top-4 left-4 text-xs font-bold uppercase opacity-30">2. Kaleidoscope Render</h3>
            {outputSrc ? (
              <img src={outputSrc} className="max-w-full max-h-full object-contain shadow-2xl rounded-lg" />
            ) : (
              <p className="text-muted-foreground italic">Click Generate to see result</p>
            )}
          </div>

        {/* Footer */}
        <div className="text-center text-sm text-muted-foreground">
          <p>Brought to you by Altered Brain Chemistry</p>
        </div>
        </main>
      </div>
    </div>
  );
}

export default AppContent;
