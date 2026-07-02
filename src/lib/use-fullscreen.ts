// src/lib/use-fullscreen.ts
//
// Hook that manages fullscreen state, synced with the Tauri window.
//
// Usage:
//   const { isFullscreen, toggleFullscreen, exitFullscreen } = useFullscreen();
//
// Keyboard shortcut:
//   F11       — toggle (all platforms)
//   Cmd+Ctrl+F — toggle (macOS convention)
//   Escape    — exit fullscreen
//
// The hook listens for the `tauri://window-resized` event so it stays in sync
// when the user presses Esc or uses the OS window controls to exit fullscreen.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface UseFullscreenReturn {
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
  enterFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
}

export function useFullscreen(): UseFullscreenReturn {
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Debounce flag so we don't fire two syncs at once.
  const syncingRef = useRef(false);

  // Read the current window state from Tauri.
  const syncState = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      const fs = await invoke<boolean>("get_fullscreen");
      setIsFullscreen(fs);
    } catch {
      // Not a Tauri context (browser dev mode) — stay false.
    } finally {
      syncingRef.current = false;
    }
  }, []);

  const enterFullscreen = useCallback(async () => {
    try {
      await invoke("set_fullscreen", { fullscreen: true });
      setIsFullscreen(true);
    } catch {/* browser dev mode */}
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      await invoke("set_fullscreen", { fullscreen: false });
      setIsFullscreen(false);
    } catch {/* browser dev mode */}
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Subscribe to window resize events to detect OS-level fullscreen changes
  // (e.g. user presses Esc, or the green traffic-light button on macOS).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onResized(() => { syncState(); })
      .then((fn) => { unlisten = fn; })
      .catch(() => {/* not in Tauri */});
    return () => { unlisten?.(); };
  }, [syncState]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F11 — all platforms
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      // Cmd+Ctrl+F — macOS convention (matches what the OS green button does)
      if (e.key === "f" && e.metaKey && e.ctrlKey) {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      // Escape — exit only (don't toggle into fullscreen with Escape)
      if (e.key === "Escape" && isFullscreen) {
        e.preventDefault();
        exitFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen, toggleFullscreen, exitFullscreen]);

  // Read initial state.
  useEffect(() => { syncState(); }, [syncState]);

  return { isFullscreen, toggleFullscreen, enterFullscreen, exitFullscreen };
}