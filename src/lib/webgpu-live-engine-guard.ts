// The project's TypeScript version predates the dom.webgpu lib entry, so
// GPU is not in scope. GPUAdapter is already declared in lib.dom.d.ts.
declare global {
  interface GPU {
    requestAdapter(options?: { powerPreference?: string }): Promise<{ limits: { maxStorageTexturesPerShaderStage: number } } | null>;
  }
  interface Navigator {
    readonly gpu: GPU;
  }
}

export type LivePreviewWebGpuSupport =
  | {
      supported: true;
      details: {
        maxStorageTexturesPerShaderStage: number;
      };
    }
  | {
      supported: false;
      reason: string;
      details?: {
        maxStorageTexturesPerShaderStage?: number;
      };
    };

const MIN_STORAGE_TEXTURES_PER_SHADER_STAGE = 1;

function getNavigatorGpu(): GPU | null {
  return typeof navigator !== "undefined" && "gpu" in navigator
    ? navigator.gpu
    : null;
}

function canCreateWebGpuContextOnTemporaryCanvas(): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const probeCanvas = document.createElement("canvas");
  const context = probeCanvas.getContext("webgpu");

  return context !== null;
}

export async function checkLivePreviewWebGpuSupport(): Promise<LivePreviewWebGpuSupport> {
  const gpu = getNavigatorGpu();

  if (!gpu) {
    return {
      supported: false,
      reason:
        "WebGPU is not available in this webview. On macOS Tauri this depends on the WKWebView/WebKit version provided by the operating system.",
    };
  }

  const adapter = await gpu.requestAdapter({
    powerPreference: "high-performance",
  });

  if (!adapter) {
    return {
      supported: false,
      reason:
        "WebGPU is present, but no compatible GPU adapter was returned for the live preview.",
    };
  }

  const maxStorageTexturesPerShaderStage =
    adapter.limits.maxStorageTexturesPerShaderStage;

  if (
    maxStorageTexturesPerShaderStage <
    MIN_STORAGE_TEXTURES_PER_SHADER_STAGE
  ) {
    return {
      supported: false,
      reason:
        "The selected WebGPU adapter does not support storage textures required by the live kaleidoscope renderer.",
      details: {
        maxStorageTexturesPerShaderStage,
      },
    };
  }

  if (!canCreateWebGpuContextOnTemporaryCanvas()) {
    return {
      supported: false,
      reason:
        "This webview exposes navigator.gpu, but canvas.getContext('webgpu') returned null. WebGPU is unavailable for canvas rendering in this webview.",
      details: {
        maxStorageTexturesPerShaderStage,
      },
    };
  }

  return {
    supported: true,
    details: {
      maxStorageTexturesPerShaderStage,
    },
  };
}