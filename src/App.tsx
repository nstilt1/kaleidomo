import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from '@tauri-apps/plugin-dialog';
import { WedgePicker } from "./components/WedgePicker";
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
import { NumberSliderInput } from "./components/NumberSliderInput";
import { AspectRatioPicker } from "./components/AspectRatioPicker";

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

function mergeSettingsWithDefaults(value: unknown): Settings {
  const raw = isRecord(value) ? value : {};

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
  };
}

function App() {
  // State definitions
  const [imagePath, setImagePath] = useState<string>("");
  const [_imageSrc, setImageSrc] = useState<string>(""); // For previewing original
  const [outputSrc, setOutputSrc] = useState<string>(""); // Result from Rust
  const [count, setCount] = useState<number>(6);
  const [settings, setSettings] = useState({ x: 100, y: 100, rotation: 0, resolution: 512, zoom: 2, tile_count: 1.0, hue_rotate: 0, ratio_num: 9, ratio_den: 16, offset_x: 0, offset_y: 0, aspect_ratio_mode: "preset", frame_count: 360, still_frame_ending: 0, fps: 30, quality: 0.1, triangle_rotation_degrees_per_frame: 1.0, hue_rotation_degrees_per_frame: 1.0, zoom_max: 1.0, zoom_min: 1.0, zoom_fn: "sin", zoom_start_offset: 0.0, num_zoom_loops: 1 });
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [kaleidoType, setKaleidoType] = useState<string>("radial");
  const [imgWidth, setImgWidth] = useState<number>(0);
  const [imgHeight, setImgHeight] = useState<number>(0);

  async function greet() {
    if (!name.trim()) return;
    
    setIsLoading(true);
    try {
      const message = await invoke<string>("greet", { name });
      setGreetMsg(message);
    } catch (error) {
      console.error("Failed to greet:", error);
      setGreetMsg("Failed to connect to Tauri backend");
    } finally {
      setIsLoading(false);
    }
  }

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
      await handleRender();
    }
  };

  const resetSettings = () => {
    setSettings({
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
    try {
      const result: string = await invoke('generate_kaleidoscope', {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        count: count,
        outputSizeH: settings.resolution,
        outputSizeW: calculate_width(settings),
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
    }, 50); // 50ms delay creates a responsive 20fps feel

    return () => clearTimeout(timer);
  }, [settings, count, kaleidoType, imagePath]); // Re-run whenever wedge moves or count changes

  // Save Project JSON
  const saveProject = async () => {
    const filePath = await save({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (filePath) {
      const data = JSON.stringify({ imagePath, count, settings, kaleidoType });
      await writeTextFile(filePath, data);
    }
  };

  // Load Project JSON
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

      const imagePath =
        typeof parsed.imagePath === "string" ? parsed.imagePath : "";

      const count =
        typeof parsed.count === "number" && Number.isFinite(parsed.count)
          ? parsed.count
          : 0;

      const kaleidoType =
        typeof parsed.kaleidoType === "string" ? parsed.kaleidoType : "default";

      const settings = mergeSettingsWithDefaults(parsed.settings);

      setCount(count);
      setSettings(settings);
      setKaleidoType(kaleidoType);

      if (imagePath) {
        setImagePath(imagePath);

        const assetUrl = convertFileSrc(imagePath);
        setImageSrc(assetUrl);

        const img = new Image();
        img.src = assetUrl;

        try {
          await img.decode();
          setImgWidth(img.naturalWidth);
          setImgHeight(img.naturalHeight);
        } catch (err) {
          console.error("Failed to load project image", err);
        }
      }
    } catch (err) {
      console.error("Failed to load project file", err);
    }
  };

  const calculate_width = (settings: { resolution: number; ratio_num: number; ratio_den: number }) => {
    const height = settings.resolution
    const num = Math.max(1, settings.ratio_num)
    const den = Math.max(1, settings.ratio_den)

    const exactWidth = (height * num) / den

    return roundToNearestMultiple(exactWidth, 8)
  }

  const handleExport = async () => {
    if (!imagePath) return;
    
    try {
      const message = await invoke('export_kaleidoscope', {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        zoom: settings.zoom,
        count: count,
        outputSizeH: settings.resolution,
        outputSizeW: calculate_width(settings),
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
    
    try {
      const message = await invoke('generate_video', {
        path: imagePath,
        x: settings.x,
        y: settings.y,
        rotation: settings.rotation,
        zoom: settings.zoom,
        count: count,
        outputSizeH: settings.resolution,
        outputSizeW: calculate_width(settings),
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
      <div className="max-w-2xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold tracking-tight">
            Tauri + shadcn/ui + Tailwind
          </h1>
          <p className="text-xl text-muted-foreground">
            Modern desktop app boilerplate
          </p>
          <div className="flex justify-center gap-2">
            <Badge variant="secondary">Tauri v2</Badge>
            <Badge variant="secondary">React 18</Badge>
            <Badge variant="secondary">TypeScript</Badge>
          </div>
        </div>

        {/* Demo Card */}
        <Card>
          <CardHeader>
            <CardTitle>Demo</CardTitle>
            <CardDescription>
              Test the Tauri backend integration
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="Enter your name..."
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && greet()}
              />
              <Button 
                onClick={greet} 
                disabled={isLoading || !name.trim()}
              >
                {isLoading ? "..." : "Greet"}
              </Button>
            </div>
            {greetMsg && (
              <div className="p-3 bg-muted rounded-md">
                <p className="text-sm">{greetMsg}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Features */}
        <div className="grid md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">⚡ Fast</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Rust-powered backend with native performance
              </CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">🎨 Modern</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Beautiful UI with shadcn/ui and Tailwind CSS
              </CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">🔐 Secure</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Memory safety with Rust and Tauri's security model
              </CardDescription>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
        {/* Narrower Sidebar (w-64 = 16rem / 256px) */}
        <aside className="w-64 border-r p-6 flex flex-col gap-6 bg-card overflow-y-auto">
          <div className="space-y-1">
            <h2 className="text-xl font-bold tracking-tight">Kaleidomo</h2>
            <p className="text-xs text-muted-foreground">Native Rust Engine</p>
          </div>

          <Button onClick={handlePickFile} className="w-full">Select Image</Button>
          <Button onClick={resetSettings} className="w-full">Reset Controls</Button>
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
              max={24}
              step={1}
              onChange={(v) => setCount(v)}
              roundToInteger={true}
              />

            <NumberSliderInput
              label="Sample Radius"
              value={settings.zoom}
              min={0.1}
              max={32.0}
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
              label="Output Height"
              value={settings.resolution}
              min={256}
              max={8192}
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
              max={64.0}
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
            <Button variant="ghost" size="sm" onClick={saveProject}>Save Project</Button>
            <Button variant="ghost" size="sm" onClick={loadProject}>Load Project</Button>
          </div>

          <hr className="opacity-20" />

          {/* Group 1: Geometry */}
          <div className="space-y-4">
            <div className="flex justify-between items-center"><label>Video Settings</label>
            </div>
            <p>The generation might be running on your CPU, so 360 frames should be a good starting point.</p>
            <NumberSliderInput
              label="Frame Count"
              value={settings.frame_count}
              min={1}
              max={3600}
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
              min={0.01}
              max={32.0}
              step={0.01}
              onChange={(v) => setSettings(s => ({...s, zoom_max: v}))}
              unit="x"
              roundToInteger={false}
              />
            <NumberSliderInput
              label="Min Zoom"
              value={settings.zoom_min}
              min={0.01}
              max={32.0}
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
          <p>Built with Tauri, React, TypeScript, shadcn/ui, and Tailwind CSS</p>
        </div>
        </main>
      </div>
    </div>
  );
}

export default App;
