/**
 * Thin loader for the kaleidomo-core WASM module.
 *
 * The wasm-bindgen `--target web` output lives in `public/wasm/` and is NOT
 * bundled by Vite — it is served as a static asset and imported at runtime via
 * a dynamic `import()`.  We initialise the WASM binary once (via `init()`)
 * then cache the module so callers always get the same reference.
 *
 * Usage:
 *   const { LiveKaleidoscopeEngine, WasmVideoSettings } = await loadWasm();
 *   const engine = await new LiveKaleidoscopeEngine(canvas);
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmModule = any;

let wasmPromise: Promise<WasmModule> | null = null;

export async function loadWasm(): Promise<WasmModule> {
  if (wasmPromise) return wasmPromise;

  wasmPromise = (async () => {
    // Dynamic import of the wasm-bindgen JS glue. Vite will NOT try to bundle
    // it because it lives in /public — the leading slash makes it a URL import.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — no generated .d.ts at dev time; types come from the stub below
    const mod = await import(/* @vite-ignore */ "/wasm/kaleidomo_core.js");

    // `init()` fetches and compiles the .wasm binary.
    await mod.default();

    return mod;
  })();

  return wasmPromise;
}