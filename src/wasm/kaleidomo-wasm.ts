// kaleidomo-wasm.ts
let wasmPromise: Promise<any> | null = null;

export async function loadWasm(): Promise<any> {
  if (wasmPromise) return wasmPromise;

  wasmPromise = (async () => {
    // Use window.location.origin to build an absolute URL —
    // Vite's import analyzer only intercepts bare/relative paths,
    // not runtime string expressions or absolute URLs.
    const jsUrl = window.location.origin + "/wasm/kaleidomo_core.js";
    const wasmBinUrl = new URL("/wasm/kaleidomo_core_bg.wasm", window.location.origin);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ jsUrl);

    await (mod.default as (input?: URL) => Promise<void>)(wasmBinUrl);

    return mod;
  })();

  return wasmPromise;
}