/* tslint:disable */
/* eslint-disable */

export class LiveKaleidoscopeEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Clear the audio peak buffer and reset smoothing state.
     */
    clear_audio_peaks(): void;
    /**
     * Convenience: fetch an image URL with `fetch`, decode it, upload to GPU.
     * Returns a Promise<void> — await it in TypeScript before calling start_animation.
     */
    load_image_from_url(url: string): Promise<void>;
    /**
     * Load raw RGBA pixel bytes into the GPU source texture.
     * Call this before `start_animation`.
     */
    load_source_image(rgba_bytes: Uint8Array, width: number, height: number): void;
    /**
     * Creates a persistent GPU rendering context bound directly to a browser canvas element.
     */
    constructor(canvas: HTMLCanvasElement);
    /**
     * Set normalized audio peaks (one f32 per video frame, values 0.0–1.0).
     * Call this after decoding and normalizing audio in TypeScript.
     */
    set_audio_peaks(peaks: Float32Array): void;
    /**
     * Begin the rAF loop.
     *
     * * `base_settings_js` — a JS object matching `KaleidoSettings` (count, offset_x/y, zoom,
     *   tile_count, triangle_center_x/y, triangle_rotation_rad, kaleido_type_idx, hue_rotation)
     * * `video_settings` — a `WasmVideoSettings` instance
     */
    start_animation(count: number, offset_x: number, offset_y: number, zoom: number, tile_count: number, triangle_center_x: number, triangle_center_y: number, triangle_rotation_rad: number, kaleido_type_idx: number, hue_rotation: number, video_settings: WasmVideoSettings): void;
    /**
     * Cancel the animation loop (idempotent).
     */
    stop_animation(): void;
    update_animation_settings(count: number, offset_x: number, offset_y: number, zoom: number, tile_count: number, triangle_center_x: number, triangle_center_y: number, triangle_rotation_rad: number, kaleido_type_idx: number, hue_rotation: number, video_settings: WasmVideoSettings): void;
}

/**
 * Animation parameters passed from TypeScript. All fields are public so
 * they can be set directly from JS via a plain object converted with
 * `serde-wasm-bindgen`, or built field-by-field.
 */
export class WasmVideoSettings {
    free(): void;
    [Symbol.dispose](): void;
    get_hue_fn(): string;
    get_orientation_fn(): string;
    get_rotation_fn(): string;
    get_zoom_fn(): string;
    constructor();
    set_hue_fn(f: string): void;
    set_orientation_fn(f: string): void;
    set_rotation_fn(f: string): void;
    set_zoom_fn(f: string): void;
    /**
     * Total loop duration in seconds (e.g. 10.0)
     */
    animation_duration: number;
    audio_orientation_amount: number;
    audio_peak_smoothing: number;
    audio_reactive_enabled: boolean;
    audio_reorientation_amount: number;
    fps: number;
    hero_circle_left_x: number;
    hero_circle_right_x: number;
    hero_circle_y: number;
    hero_desired_left_rotation: number;
    hue_cycles: number;
    /**
     * Hue sweep range in degrees (e.g. 60)
     */
    hue_range: number;
    hue_start_offset: number;
    num_zoom_loops: number;
    /**
     * Independent orientation cycles per second (base reorientation speed, no audio)
     */
    orientation_base_speed: number;
    orientation_cycles: number;
    orientation_duration: number;
    /**
     * Multiplier applied to the smoothed audio peak for orientation + rotation kick
     */
    orientation_peak_multiplier: number;
    orientation_range: number;
    orientation_start_offset: number;
    rotation_cycles: number;
    /**
     * How many radians to sweep across the rotation range per loop
     */
    rotation_range: number;
    rotation_start_offset: number;
    zoom_max: number;
    zoom_min: number;
    zoom_start_offset: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_wasmvideosettings_animation_duration: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_audio_orientation_amount: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_audio_peak_smoothing: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_audio_reactive_enabled: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_audio_reorientation_amount: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_fps: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_hero_circle_left_x: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_hero_circle_right_x: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_hero_circle_y: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_hero_desired_left_rotation: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_hue_cycles: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_hue_range: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_hue_start_offset: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_num_zoom_loops: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_orientation_base_speed: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_orientation_cycles: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_orientation_duration: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_orientation_peak_multiplier: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_orientation_range: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_orientation_start_offset: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_rotation_cycles: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_rotation_range: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_rotation_start_offset: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_zoom_max: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_zoom_min: (a: number) => number;
    readonly __wbg_get_wasmvideosettings_zoom_start_offset: (a: number) => number;
    readonly __wbg_livekaleidoscopeengine_free: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_animation_duration: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_audio_orientation_amount: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_audio_peak_smoothing: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_audio_reactive_enabled: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_audio_reorientation_amount: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_fps: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_hero_circle_left_x: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_hero_circle_right_x: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_hero_circle_y: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_hero_desired_left_rotation: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_hue_cycles: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_hue_range: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_hue_start_offset: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_num_zoom_loops: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_orientation_base_speed: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_orientation_cycles: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_orientation_duration: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_orientation_peak_multiplier: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_orientation_range: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_orientation_start_offset: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_rotation_cycles: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_rotation_range: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_rotation_start_offset: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_zoom_max: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_zoom_min: (a: number, b: number) => void;
    readonly __wbg_set_wasmvideosettings_zoom_start_offset: (a: number, b: number) => void;
    readonly __wbg_wasmvideosettings_free: (a: number, b: number) => void;
    readonly livekaleidoscopeengine_clear_audio_peaks: (a: number) => void;
    readonly livekaleidoscopeengine_load_image_from_url: (a: number, b: number, c: number) => number;
    readonly livekaleidoscopeengine_load_source_image: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly livekaleidoscopeengine_new: (a: number) => number;
    readonly livekaleidoscopeengine_set_audio_peaks: (a: number, b: number) => void;
    readonly livekaleidoscopeengine_start_animation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly livekaleidoscopeengine_stop_animation: (a: number) => void;
    readonly livekaleidoscopeengine_update_animation_settings: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly wasmvideosettings_get_hue_fn: (a: number, b: number) => void;
    readonly wasmvideosettings_get_orientation_fn: (a: number, b: number) => void;
    readonly wasmvideosettings_get_rotation_fn: (a: number, b: number) => void;
    readonly wasmvideosettings_get_zoom_fn: (a: number, b: number) => void;
    readonly wasmvideosettings_new: () => number;
    readonly wasmvideosettings_set_hue_fn: (a: number, b: number, c: number) => void;
    readonly wasmvideosettings_set_orientation_fn: (a: number, b: number, c: number) => void;
    readonly wasmvideosettings_set_rotation_fn: (a: number, b: number, c: number) => void;
    readonly wasmvideosettings_set_zoom_fn: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_717: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_2287: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_720: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_10357: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_2289: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
