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
import { useSettings } from "@/lib/settings-context";

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
  hue_fn: "sawtooth"
};

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
              shouldLimit={!isUnlocked}
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
              shouldLimit={!isUnlocked}
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
              shouldLimit={!isUnlocked}
              limitedMin={0.8}
              limitedCap={3.0}
              min={0.001}
              max={32.0}
              step={0.0001}
              unit="x"
              onChange={(v) => setSettings((s) => ({ ...s, zoom: v }))}
              roundToInteger={false}
              sliderScale="splitLog"
              sliderMidpointValue={1.0}
              sliderMidpointPercent={zoomSliderMidpointPercent}
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
                {(!isUnlocked) && (
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
              shouldLimit={!isUnlocked}
              limitedCap={720}
              max={8192}
              step={8}
              onChange={(v) => setSettings((s) => ({ ...s, resolution: v }))}
              unit="px"
              roundToInteger={false}
              roundToMultipleOf={8}
              presetValues={[480, 540, 720, 1080, 1440, 2160, 4320, 5550, 8192]}
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
              label="Animation Duration"
              value={settings.animation_duration}
              min={0.1}
              shouldLimit={!isUnlocked}
              limitedCap={12}
              max={600}
              step={0.1}
              onChange={(v) => setSettings((s) => ({ ...s, animation_duration: v }))}
              unit="seconds"
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
              label="Triangle Rotation Range"
              value={settings.rotation_range}
              min={-720.0}
              max={720.0}
              step={0.01}
              onChange={(v) =>
                setSettings((s) => ({
                  ...s,
                  rotation_range: v,
                }))
              }
              unit="degrees"
              roundToInteger={false}
            />
            <NumberSliderInput
              label="# Rotation Cycles"
              value={settings.rotation_cycles}
              min={0.1}
              max={16}
              step={0.1}
              onChange={(v) => 
                setSettings((s) => ({
                  ...s,
                  rotation_cycles: v,
                }))
              }
              unit="cycles"
              roundToInteger={false}
            />
            <NumberSliderInput
              label="Rotation phase offset"
              value={settings.rotation_start_offset}
              min={-360}
              max={360}
              step={0.1}
              onChange={(v) => 
                setSettings((s) => ({
                  ...s,
                  rotation_start_offset: v,
                }))
              }
              unit="cycles"
              roundToInteger={false}
              presetValues={[0, 90, 180]}
            />

            <Select
              onValueChange={(v) => setSettings((s) => ({ ...s, rotation_fn: v }))}
              value={settings.rotation_fn}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select rotation function" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Rotation Function</SelectLabel>
                  <SelectItem value="triangle">Triangle Wave</SelectItem>
                  <SelectItem value="sawtooth">Sawtooth Wave</SelectItem>
                  <SelectItem value="sin">Sine Wave</SelectItem>
                  <SelectItem value="sin2">sin<sup>2</sup></SelectItem>
                  <SelectItem value="cos">cos</SelectItem>
                  <SelectItem value="-cos">-cos</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            
            <NumberSliderInput
              label="Color changing range"
              value={settings.hue_range}
              min={-720.0}
              max={720.0}
              step={0.01}
              onChange={(v) =>
                setSettings((s) => ({
                  ...s,
                  hue_range: v,
                }))
              }
              unit="degrees"
              roundToInteger={false}
              presetValues={[-360, 0, 360]}
            />

            <NumberSliderInput
              label="# Color changing cycles"
              value={settings.hue_cycles}
              min={0}
              max={16.0}
              step={0.01}
              onChange={(v) =>
                setSettings((s) => ({
                  ...s,
                  hue_cycles: v,
                }))
              }
              unit="degrees"
              roundToInteger={false}
              presetValues={[0, 1, 2, 3, 4, 5]}
            />


            <NumberSliderInput
              label="Color changing phase offset"
              value={settings.hue_start_offset}
              min={-360}
              max={360}
              step={0.1}
              onChange={(v) => 
                setSettings((s) => ({
                  ...s,
                  hue_start_offset: v,
                }))
              }
              unit="cycles"
              roundToInteger={false}
              presetValues={[0, 90, 180]}
            />

            <Select
              onValueChange={(v) => setSettings((s) => ({ ...s, hue_fn: v }))}
              value={settings.hue_fn}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select color changing function" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Color changing function Function</SelectLabel>
                  <SelectItem value="triangle">Triangle Wave</SelectItem>
                  <SelectItem value="sawtooth">Sawtooth Wave</SelectItem>
                  <SelectItem value="sin">sin</SelectItem>
                  <SelectItem value="sin2">sin<sup>2</sup></SelectItem>
                  <SelectItem value="cos">cos</SelectItem>
                  <SelectItem value="-cos">-cos</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <NumberSliderInput
              label="Max Zoom"
              value={settings.zoom_max}
              shouldLimit={!isUnlocked}
              limitedCap={3.0}
              limitedMin={0.8}
              min={0.001}
              max={32.0}
              step={0.0001}
              onChange={(v) => setSettings((s) => ({ ...s, zoom_max: v }))}
              unit="x"
              roundToInteger={false}
              sliderScale="splitLog"
              sliderMidpointValue={1.0}
              sliderMidpointPercent={zoomSliderMidpointPercent}
            />
            <NumberSliderInput
              label="Min Zoom"
              value={settings.zoom_min}
              shouldLimit={!isUnlocked}
              limitedCap={3.0}
              limitedMin={0.8}
              min={0.001}
              max={32.0}
              step={0.0001}
              onChange={(v) => setSettings((s) => ({ ...s, zoom_min: v }))}
              unit="x"
              roundToInteger={false}
              sliderScale="splitLog"
              sliderMidpointValue={1.0}
              sliderMidpointPercent={zoomSliderMidpointPercent}
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
                  <SelectItem value="triangle">Triangle Wave</SelectItem>
                  <SelectItem value="sawtooth">Sawtooth Wave</SelectItem>
                  <SelectItem value="sin">Sine Wave</SelectItem>
                  <SelectItem value="sin2">sin<sup>2</sup></SelectItem>
                  <SelectItem value="cos">cos</SelectItem>
                  <SelectItem value="-cos">-cos</SelectItem>
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

          <div className="text-center text-sm text-muted-foreground">
            <p>Brought to you by Altered Brain Chemistry</p>
          </div>
        </main>
      </div>
    </div>
  );
}

export default Kaleidomo;