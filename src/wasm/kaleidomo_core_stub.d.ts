/**
 * Minimal hand-written declarations for the wasm-bindgen output.
 * The real generated .d.ts (from wasm-bindgen) will be placed at
 * src/wasm/kaleidomo_core.d.ts by build_wasm.sh — that file is more
 * complete and takes precedence when it exists.
 *
 * This stub exists so TypeScript does not error in CI or on first checkout
 * before the wasm build has been run.
 */

export declare class WasmVideoSettings {
  constructor();
  animation_duration: number;
  rotation_range: number;
  rotation_cycles: number;
  rotation_start_offset: number;
  hue_range: number;
  hue_cycles: number;
  hue_start_offset: number;
  fps: number;
  zoom_max: number;
  zoom_min: number;
  zoom_start_offset: number;
  num_zoom_loops: number;
  orientation_range: number;
  orientation_cycles: number;
  orientation_start_offset: number;
  orientation_duration: number;
  audio_reactive_enabled: boolean;
  audio_orientation_amount: number;
  audio_reorientation_amount: number;
  audio_peak_smoothing: number;
  hero_circle_left_x: number;
  hero_circle_right_x: number;
  hero_circle_y: number;
  hero_desired_left_rotation: number;
  set_rotation_fn(f: string): void;
  get_rotation_fn(): string;
  set_hue_fn(f: string): void;
  get_hue_fn(): string;
  set_zoom_fn(f: string): void;
  get_zoom_fn(): string;
  set_orientation_fn(f: string): void;
  get_orientation_fn(): string;
}

export declare class LiveKaleidoscopeEngine {
  constructor(canvas: HTMLCanvasElement): Promise<LiveKaleidoscopeEngine>;
  load_source_image(rgba_bytes: Uint8Array, width: number, height: number): void;
  load_image_from_url(url: string): Promise<void>;
  start_animation(
    count: number,
    offset_x: number,
    offset_y: number,
    zoom: number,
    tile_count: number,
    triangle_center_x: number,
    triangle_center_y: number,
    triangle_rotation_rad: number,
    kaleido_type_idx: number,
    hue_rotation: number,
    video_settings: WasmVideoSettings,
  ): void;
  update_animation_settings(
    count: number,
    offset_x: number,
    offset_y: number,
    zoom: number,
    tile_count: number,
    triangle_center_x: number,
    triangle_center_y: number,
    triangle_rotation_rad: number,
    kaleido_type_idx: number,
    hue_rotation: number,
    video_settings: WasmVideoSettings,
  ): void;
  stop_animation(): void;
  set_audio_peaks(peaks: Float32Array): void;
  clear_audio_peaks(): void;
}

/** Called by the generated glue to fetch + compile the .wasm binary. */
declare function init(input?: string | URL | Request | BufferSource): Promise<void>;
export default init;