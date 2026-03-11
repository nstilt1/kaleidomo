import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from '@tauri-apps/plugin-dialog';
import { Slider } from "@/components/ui/slider";
import { saveConfig } from "./lib/utils";
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

function App() {
  // State definitions
  const [imagePath, setImagePath] = useState<string>("");
  const [_imageSrc, setImageSrc] = useState<string>(""); // For previewing original
  const [outputSrc, setOutputSrc] = useState<string>(""); // Result from Rust
  const [count, setCount] = useState<number>(6);
  const [settings, setSettings] = useState({ x: 100, y: 100, rotation: 0, resolution: 512, zoom: 2, tile_count: 1.0, hue_rotate: 0 });
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [preview, _setPreview] = useState<string | null>(null);
  const [kaleidoType, setKaleidoType] = useState<string>("radial");

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
        setSettings({
          x: img.naturalWidth / 2,
          y: img.naturalHeight / 2,
          rotation: 0,
          resolution: 512,
          zoom: 2,
          tile_count: 1.0,
          hue_rotate: 0,
        });
      };
    }
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
        outputSize: settings.resolution,
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
  }, [settings, count, kaleidoType]); // Re-run whenever wedge moves or count changes

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
    const selected = await open({ filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected && typeof selected === 'string') {
      const content = await readTextFile(selected);
      const project = JSON.parse(content);
      setImagePath(project.imagePath);
      setCount(project.count);
      setSettings(project.settings);
      setKaleidoType(project.kaleidoType);
    }
  };

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
        resolution: settings.resolution,
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
        outputSize: settings.resolution,
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

        {/* File picker and preview */}
        <div className="p-8 flex flex-col items-center gap-4">
          <Button onClick={handlePickFile}>Select & Process Image</Button>
          {preview && <img src={preview} className="rounded-lg shadow-xl" alt="Preview" />}
        </div>
        <div className="flex h-screen bg-background text-foreground">
          <aside className="w-80 p-6 border-r flex flex-col gap-6">
            <h2 className="text-xl font-bold">Settings</h2>
            
            <div className="space-y-2">
              <label>Slices: {count}</label>
              <Slider 
                value={[count]} 
                min={3} max={24} step={1} 
                onValueChange={([v]) => setCount(v)} 
              />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between">
                <label>Rotation</label>
                <span className="text-xs text-muted-foreground">
                  {Math.round((settings.rotation * 180) / Math.PI)}°
                </span>
              </div>
              <Slider 
                value={[settings.rotation]} 
                min={0} 
                max={Math.PI * 2} 
                step={0.01} 
                onValueChange={([v]) => setSettings(prev => ({ ...prev, rotation: v }))} 
              />
            </div>

            <Button onClick={() => saveConfig(settings, imagePath)} variant="outline">
              💾 Save Project File
            </Button>
            
            <Button onClick={handleRender} className="mt-auto">
              Generate Kaleidoscope
            </Button>
          </aside>

          <main className="flex-1 p-6 overflow-auto flex justify-center items-center bg-muted/30">
            {imagePath ? (
              <WedgePicker imagePath={imagePath} count={count} settings={settings} onUpdate={setSettings} />
            ) : (
              <div className="text-center italic">Upload an image to start</div>
            )}
          </main>
        </div>

        {/* Footer */}
        <div className="text-center text-sm text-muted-foreground">
          <p>Built with Tauri, React, TypeScript, shadcn/ui, and Tailwind CSS</p>
        </div>
      </div>

      <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
        {/* Narrower Sidebar (w-64 = 16rem / 256px) */}
        <aside className="w-64 border-r p-6 flex flex-col gap-6 bg-card overflow-y-auto">
          <div className="space-y-1">
            <h2 className="text-xl font-bold tracking-tight">Kaleidomo</h2>
            <p className="text-xs text-muted-foreground">Native Rust Engine</p>
          </div>

          <Button onClick={handlePickFile} className="w-full">Upload Image</Button>

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

            <div className="flex justify-between items-center"><label>Slices</label><span>{count}</span></div>
            <Slider value={[count]} min={3} max={24} onValueChange={([v]) => setCount(v)} />
            
            <div className="flex justify-between items-center"><label>Zoom</label><span>{settings.zoom.toFixed(2)}x</span></div>
            <Slider value={[settings.zoom]} min={0.1} max={32.0} step={0.01} onValueChange={([v]) => setSettings(s => ({...s, zoom: v}))} />

            <div className="flex justify-between items-center"><label>Rotation</label><span>{settings.rotation.toFixed(2)} radians</span></div>
            <Slider value={[settings.rotation]} min={0.0} max={2 * Math.PI} step={0.01} onValueChange={([v]) => setSettings(s => ({...s, rotation: v}))} />
          </div>

          {/* Group 2: Output */}
          <div className="space-y-4">
            <div className="flex justify-between items-center"><label>Resolution</label><span>{settings.resolution}px</span></div>
            <Slider value={[settings.resolution]} min={256} max={8192} step={256} onValueChange={([v]) => setSettings(s => ({...s, resolution: v}))} />
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center"><label>Tile Count</label><span>{settings.tile_count}</span></div>
            <Slider value={[settings.tile_count]} min={0.1} max={64.0} step={0.1} onValueChange={([v]) => setSettings(s => ({...s, tile_count: v}))} />
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center"><label>Tile Count</label><span>{settings.hue_rotate} degrees</span></div>
            <Slider value={[settings.hue_rotate]} min={0} max={360} step={1} onValueChange={([v]) => setSettings(s => ({...s, hue_rotate: v}))} />
          </div>

          <div className="flex flex-col gap-2 pt-4">
            <Button onClick={handleRender} variant="outline">Refresh Preview</Button>
            <Button onClick={handleExport} className="bg-primary">Export PNG</Button>
            <Button onClick={handleVideo} className="bg-primary">Export MP4</Button>
          </div>

          <div className="mt-auto grid grid-cols-2 gap-2">
            <Button variant="ghost" size="sm" onClick={saveProject}>Save Project</Button>
            <Button variant="ghost" size="sm" onClick={loadProject}>Load Project</Button>
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
        </main>
      </div>
    </div>
  );
}

export default App;
