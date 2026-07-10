import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface UseFullscreenReturn {
  isFullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
  enterFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
}

export interface UseFullscreenOptions {
  /** Disable click-to-exit in the controls window while keeping Escape active. */
  disablePointerExit?: boolean;
}

export function useFullscreen(
  options: UseFullscreenOptions = {},
): UseFullscreenReturn {
  const { disablePointerExit = false } = options;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const syncingRef = useRef(false);

  const syncState = useCallback(async () => {
    if (syncingRef.current) return;

    syncingRef.current = true;
    try {
      setIsFullscreen(await invoke<boolean>("get_fullscreen"));
    } catch (error) {
      console.error("Failed to read fullscreen state:", error);
    } finally {
      syncingRef.current = false;
    }
  }, []);

  const enterFullscreen = useCallback(async () => {
    try {
      // The Rust command enters fullscreen and shows/focuses the controls
      // window as one atomic transition.
      await invoke("set_fullscreen", { fullscreen: true });
      setIsFullscreen(true);
    } catch (error) {
      console.error("Failed to enter fullscreen:", error);
      await syncState();
    }
  }, [syncState]);

  const exitFullscreen = useCallback(async () => {
    try {
      // This Rust command always targets the native window labeled "main",
      // even when Escape originates in the controls webview.
      await invoke("exit_fullscreen");
      setIsFullscreen(false);
    } catch (error) {
      console.error("Failed to exit fullscreen:", error);
      await syncState();
    }
  }, [syncState]);

  const toggleFullscreen = useCallback(async () => {
    let fullscreen = isFullscreen;

    try {
      fullscreen = await invoke<boolean>("get_fullscreen");
    } catch {
      // Fall back to the last synchronized React state.
    }

    if (fullscreen) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [enterFullscreen, exitFullscreen, isFullscreen]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWindow()
      .onResized(() => {
        void syncState();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to attach fullscreen resize listener:", error);
      });

    return () => unlisten?.();
  }, [syncState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void exitFullscreen();
        return;
      }

      if (event.key === "F11") {
        event.preventDefault();
        event.stopPropagation();
        void toggleFullscreen();
        return;
      }

      if (event.key.toLowerCase() === "f" && event.metaKey && event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        void toggleFullscreen();
      }
    };

    // Capture phase prevents canvas/input handlers from swallowing Escape.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [exitFullscreen, toggleFullscreen]);

  useEffect(() => {
    if (disablePointerExit || !isFullscreen) return;

    const onPointerDown = (event: PointerEvent) => {
      // Only the main canvas window enables this listener.
      if (event.button !== 0) return;
      void exitFullscreen();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [disablePointerExit, exitFullscreen, isFullscreen]);

  useEffect(() => {
    const onBrowserFullscreenChange = () => {
      if (!document.fullscreenElement) {
        void syncState();
      }
    };

    document.addEventListener("fullscreenchange", onBrowserFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onBrowserFullscreenChange);
    };
  }, [syncState]);

  useEffect(() => {
    void syncState();
  }, [syncState]);

  return {
    isFullscreen,
    toggleFullscreen,
    enterFullscreen,
    exitFullscreen,
  };
}
