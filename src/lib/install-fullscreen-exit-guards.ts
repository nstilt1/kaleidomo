import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Installs fullscreen escape handlers before React mounts.
 *
 * React state is deliberately not involved. The Rust command checks the native
 * main-window fullscreen state and does nothing when the app is windowed, so
 * these listeners are safe to keep installed for the lifetime of each webview.
 */
export function installFullscreenExitGuards(): void {
  const currentWindow = getCurrentWindow();
  const isControlsWindow = currentWindow.label === "controls";

  const exitIfFullscreen = (): void => {
    void invoke<boolean>("exit_fullscreen_if_active")
      .then((didExit) => {
        if (didExit) {
          document.documentElement.dataset.nativeFullscreen = "false";
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to exit fullscreen:", error);
      });
  };

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;

      event.preventDefault();
      event.stopImmediatePropagation();
      exitIfFullscreen();
    },
    true,
  );

  // The controls window must remain interactive. Pointer-to-exit applies only
  // to the main canvas window; Escape works from either window.
  if (!isControlsWindow) {
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        if (document.documentElement.dataset.nativeFullscreen !== "true") return;
        exitIfFullscreen();
      },
      true,
    );
  }
}
