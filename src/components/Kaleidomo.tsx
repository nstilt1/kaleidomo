import { useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { WedgePicker } from "@/components/WedgePicker";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
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
import { initGpuSetting } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import { useLicense } from "@/lib/license-context";
import { Card, CardDescription, CardFooter } from "./ui/card";
import { useKaleidomoSession } from "@/lib/kaleidomo-session-context";

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
  frame_count: number;
  still_frame_ending: number;
  fps: number;
  quality: number;
  triangle_rotation_degrees_per_frame: number;
  hue_rotation_degrees_per_frame: number;
  zoom_max: number;
  zoom_min: number;
  zoom_fn: string;
  zoom_start_offset: number;
  num_zoom_loops: number;
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

function Kaleidomo() {
  const { isUnlocked, licenseType } = useLicense();

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
          zoom: activeSettings.zoom,
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
    [imagePath, imgWidth, imgHeight, settings, count, kaleidoType, calculateDimensions]
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

      const mergedSettings = mergeSettingsWithBase(DEFAULT_SETTINGS, parsed.settings);
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

    const data = JSON.stringify({ imagePath, count, settings, kaleidoType });
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
        zoom: settings.zoom,
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
      const message = await invoke("generate_video", {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        zoom: settings.zoom,
        count,
        outputSizeH: height,
        outputSizeW: width,
        offsetX: settings.offset_x,
        offsetY: settings.offset_y,
        kaleidoType,
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

  return (
    <div className="max-h-full bg-background flex flex-col items-center justify-center p-8">
      <Toaster richColors position="top-right" />

      <div className="max-w-2xl w-full space-y-8">
        <div className="text-center space-y-4" />
      </div>

      <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
        <aside className="w-64 border-r p-6 flex flex-col gap-6 bg-card overflow-y-auto">
          <div className="space-y-1">
            <h2 className="text-xl font-bold tracking-tight">Kaleidomo</h2>
            <p className="text-xs text-muted-foreground">Native Rust Engine</p>
          </div>

          <Button onClick={handlePickFile} className="w-full">
            Select Image
          </Button>
          <Button onClick={resetImageSettings} className="w-full">
            Reset Controls
          </Button>
          <Button variant="ghost" size="sm" onClick={loadImagePreset}>
            Load Image Preset
          </Button>
          <Button variant="ghost" size="sm" onClick={saveImagePreset}>
            Save Image Preset
          </Button>
          <Button variant="ghost" size="sm" onClick={loadProject}>
            Load Project
          </Button>
          <Button variant="ghost" size="sm" onClick={saveProject}>
            Save Project
          </Button>

          <hr className="opacity-20" />

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <label>Type</label>
            </div>
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
                  <SelectItem value="hexagonal_flat_top">
                    Hexagon Tiling (Flat Top)
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>

          <div className="space-y-4">
            <NumberSliderInput
              label="Tile Count"
              value={settings.tile_count}
              shouldLimit={!isUnlocked || licenseType === "trial"}
              limitedCap={3.5}
              min={0.1}
              max={64.0}
              step={0.1}
              onChange={(v) => setSettings((s) => ({ ...s, tile_count: v }))}
              unit="tiles"
              roundToInteger={false}
            />
          </div>

            <NumberSliderInput
              label="Slices"
              value={count}
              shouldLimit={!isUnlocked || licenseType === "trial"}
              limitedCap={12}
              min={3}
              max={64}
              step={1}
              onChange={(v) => setCount(v)}
              roundToInteger={true}
            />

            <NumberSliderInput
              label="Zoom"
              value={settings.zoom}
              shouldLimit={!isUnlocked || licenseType === "trial"}
              limitedMin={0.8}
              limitedCap={3.0}
              min={0.01}
              max={32.0}
              step={0.01}
              unit="x"
              onChange={(v) => setSettings((s) => ({ ...s, zoom: v }))}
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
              onChange={(v) => setSettings((s) => ({ ...s, rotation: v }))}
              unit="radians"
              roundToInteger={false}
            />

            <Card className="p-4">
              <CardDescription>
                <NumberSliderInput
                  label="Offset X"
                  value={settings.offset_x}
                  min={-2000}
                  max={2000}
                  step={1}
                  onChange={(v) => setSettings((s) => ({ ...s, offset_x: v }))}
                  unit="px"
                  roundToInteger={true}
                />

                <NumberSliderInput
                  label="Offset Y"
                  value={settings.offset_y}
                  min={-2000}
                  max={2000}
                  step={1}
                  onChange={(v) => setSettings((s) => ({ ...s, offset_y: v }))}
                  unit="px"
                  roundToInteger={true}
                />
              </CardDescription>
              <CardFooter>
                {(!isUnlocked || licenseType === "trial") && (
                  <p className="text-xs text-muted-foreground">
                    Offsets are only applied to previews within this app. Upgrade to
                    the perpetual license to unlock offsets in exported media.
                  </p>
                )}
              </CardFooter>
            </Card>
          </div>

          <div className="space-y-4">
            <NumberSliderInput
              label="Output Resolution (length of smaller side)"
              value={settings.resolution}
              min={8}
              shouldLimit={!isUnlocked || licenseType === "trial"}
              limitedCap={720}
              max={8192}
              step={8}
              onChange={(v) => setSettings((s) => ({ ...s, resolution: v }))}
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
              label="Color Shift"
              value={settings.hue_rotate}
              min={0}
              max={360}
              step={1}
              onChange={(v) => setSettings((s) => ({ ...s, hue_rotate: v }))}
              unit="degrees"
              roundToInteger={true}
            />
          </div>

          <div className="flex flex-col gap-2 pt-4">
            <Button onClick={() => void renderPreview()} variant="outline" disabled={isRendering}>
              {isRendering ? "Rendering..." : "Refresh Preview"}
            </Button>
            <Button onClick={handleExport} className="bg-primary">
              Export PNG
            </Button>
          </div>

          <div className="mt-auto grid grid-cols-2 gap-2">
            <Button variant="ghost" size="sm" onClick={loadProject}>
              Load Project
            </Button>
            <Button variant="ghost" size="sm" onClick={saveProject}>
              Save Project
            </Button>
          </div>

          <hr className="opacity-20" />

          <Button variant="ghost" size="sm" onClick={loadVideoPreset}>
            Load Video Preset
          </Button>
          <Button variant="ghost" size="sm" onClick={saveVideoPreset}>
            Save Video Preset
          </Button>

          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <label>Video Settings</label>
            </div>

            <NumberSliderInput
              label="Frame Count"
              value={settings.frame_count}
              min={1}
              shouldLimit={!isUnlocked || licenseType === "trial"}
              limitedCap={1800}
              max={7200}
              step={1}
              onChange={(v) => setSettings((s) => ({ ...s, frame_count: v }))}
              unit="frames"
              roundToInteger={true}
            />
            <NumberSliderInput
              label="# Still Frames at End"
              value={settings.still_frame_ending}
              min={0}
              max={360}
              step={1}
              onChange={(v) =>
                setSettings((s) => ({ ...s, still_frame_ending: v }))
              }
              unit="frames"
              roundToInteger={true}
            />
            <NumberSliderInput
              label="Frames Per Second (FPS)"
              value={settings.fps}
              min={1}
              max={144}
              step={1}
              onChange={(v) => setSettings((s) => ({ ...s, fps: v }))}
              unit="frames per second"
              roundToInteger={true}
            />
            <NumberSliderInput
              label="Quality (bits per pixel per frame)"
              value={settings.quality}
              min={0.1}
              max={0.3}
              step={0.01}
              onChange={(v) => setSettings((s) => ({ ...s, quality: v }))}
              unit="bpp/frame"
              roundToInteger={false}
            />
            <NumberSliderInput
              label="Angle rotation rate"
              value={settings.triangle_rotation_degrees_per_frame}
              min={-30.0}
              max={30.0}
              step={0.01}
              onChange={(v) =>
                setSettings((s) => ({
                  ...s,
                  triangle_rotation_degrees_per_frame: v,
                }))
              }
              unit="degrees per frame"
              roundToInteger={false}
            />
            <NumberSliderInput
              label="Color changing rate"
              value={settings.hue_rotation_degrees_per_frame}
              min={-30.0}
              max={30.0}
              step={0.01}
              onChange={(v) =>
                setSettings((s) => ({
                  ...s,
                  hue_rotation_degrees_per_frame: v,
                }))
              }
              unit="degrees per frame"
              roundToInteger={false}
            />
            <NumberSliderInput
              label="Max Zoom"
              value={settings.zoom_max}
              shouldLimit={!isUnlocked || licenseType === "trial"}
              limitedCap={3.0}
              limitedMin={0.8}
              min={0.01}
              max={32.0}
              step={0.01}
              onChange={(v) => setSettings((s) => ({ ...s, zoom_max: v }))}
              unit="x"
              roundToInteger={false}
            />
            <NumberSliderInput
              label="Min Zoom"
              value={settings.zoom_min}
              shouldLimit={!isUnlocked || licenseType === "trial"}
              limitedCap={3.0}
              limitedMin={0.8}
              min={0.01}
              max={32.0}
              step={0.01}
              onChange={(v) => setSettings((s) => ({ ...s, zoom_min: v }))}
              unit="x"
              roundToInteger={false}
            />
            <Select
              onValueChange={(v) => setSettings((s) => ({ ...s, zoom_fn: v }))}
              value={settings.zoom_fn}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select zoom function" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Zoom Function</SelectLabel>
                  <SelectItem value="sin">Sine Wave</SelectItem>
                  <SelectItem value="sawtooth">Triangle Wave</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <NumberSliderInput
              label="Zoom Offset"
              value={settings.zoom_start_offset}
              min={0.0}
              max={1.0}
              step={0.01}
              onChange={(v) =>
                setSettings((s) => ({ ...s, zoom_start_offset: v }))
              }
              unit="cycles"
              roundToInteger={false}
            />
            <NumberSliderInput
              label="# of Zoom Cycles"
              value={settings.num_zoom_loops}
              min={1}
              max={10}
              step={1}
              onChange={(v) => setSettings((s) => ({ ...s, num_zoom_loops: v }))}
              unit="cycles"
              roundToInteger={true}
            />
          </div>

          <div className="flex flex-col gap-2 pt-4">
            <Button onClick={handleVideo} className="bg-primary">
              Export MP4
            </Button>
          </div>

          <div className="mt-auto grid grid-cols-2 gap-2">
            <Button variant="ghost" size="sm" onClick={loadProject}>
              Load Project
            </Button>
            <Button variant="ghost" size="sm" onClick={saveProject}>
              Save Project
            </Button>
          </div>

          <Button onClick={resetVideoSettings} className="w-full">
            Reset Video Settings
          </Button>
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

          <div className="text-center text-sm text-muted-foreground">
            <p>Brought to you by Altered Brain Chemistry</p>
          </div>
        </main>
      </div>
    </div>
  );
}

export default Kaleidomo;