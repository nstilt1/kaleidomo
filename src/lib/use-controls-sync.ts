// src/lib/use-controls-sync.ts
//
// Bidirectional render-state synchronisation between the main (fullscreen)
// window and the floating controls window that opens alongside it.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Design                                                                  │
// │                                                                         │
// │  Both windows load the same Vite bundle. Each has its own JS heap and   │
// │  React state — there is no shared memory between them.                  │
// │                                                                         │
// │  Synchronisation uses Tauri's global event system:                      │
// │                                                                         │
// │   Main window                       Controls window                      │
// │   ───────────                       ───────────────                      │
// │   emit("kd://state", fullState)   ──► listen → apply local state       │
// │   listen("kd://patch")            ◄── emit("kd://patch", fullState)   │
// │                                                                         │
// │  "kd://state" is the authoritative render state broadcast by the main  │
// │  window.                                                                │
// │                                                                         │
// │  "kd://patch" is emitted by the controls window whenever the user      │
// │  changes a render-driving value. The main window applies that state to  │
// │  the fullscreen renderer.                                               │
// │                                                                         │
// │  "kd://request-state" handles the case where the controls webview      │
// │  mounts after the main window's most recent broadcast. The controls     │
// │  window installs its listener first, then requests the current state.   │
// │                                                                         │
// │  To avoid feedback loops, each side skips the next outbound event after │
// │  applying a state received from the other window.                       │
// └─────────────────────────────────────────────────────────────────────────┘
//
// This hook synchronises the complete state that directly affects rendering,
// not only the nested Settings object. In particular, the Slices control is
// stored separately as `count`, so it must be included explicitly or changes
// made in the controls window will not affect the fullscreen output.
//
// Usage — main window (in Kaleidomo.tsx):
//   useControlsSync({
//     role: "main",
//     settings,
//     count,
//     kaleidoType,
//     imagePath,
//     imageSrc,
//     imgWidth,
//     imgHeight,
//     setSettings,
//     setCount,
//     setKaleidoType,
//     setImagePath,
//     setImageSrc,
//     setImgWidth,
//     setImgHeight,
//   });
//
// Usage — controls window:
//   Pass the same values and setters with role: "controls".

import { useEffect, useMemo, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { Settings } from "./kaleidomo-session-context";

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/** Full authoritative render state broadcast by the main window. */
const EVT_STATE = "kd://state";

/** Render-state update emitted by the controls window. */
const EVT_PATCH = "kd://patch";

/** Request for the main window to rebroadcast its current render state. */
const EVT_REQUEST_STATE = "kd://request-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All React state that directly determines what the fullscreen renderer shows.
 *
 * `count` is intentionally separate from `settings`: it is the Slices value.
 * The image fields are included so both windows remain attached to the same
 * source image and dimensions.
 */
export interface ControlsSyncState {
  settings: Settings;
  count: number;
  kaleidoType: string;
  imagePath: string;
  imageSrc: string;
  imgWidth: number;
  imgHeight: number;
}

interface UseControlsSyncOptions extends ControlsSyncState {
  /**
   * "main" is the fullscreen window that owns the visible renderer.
   * "controls" is the floating controls window.
   */
  role: "main" | "controls";
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  setCount: React.Dispatch<React.SetStateAction<number>>;
  setKaleidoType: React.Dispatch<React.SetStateAction<string>>;
  setImagePath: React.Dispatch<React.SetStateAction<string>>;
  setImageSrc: React.Dispatch<React.SetStateAction<string>>;
  setImgWidth: React.Dispatch<React.SetStateAction<number>>;
  setImgHeight: React.Dispatch<React.SetStateAction<number>>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useControlsSync({
  role,
  settings,
  count,
  kaleidoType,
  imagePath,
  imageSrc,
  imgWidth,
  imgHeight,
  setSettings,
  setCount,
  setKaleidoType,
  setImagePath,
  setImageSrc,
  setImgWidth,
  setImgHeight,
}: UseControlsSyncOptions) {
  // Set when remote state is applied so the resulting React render does not
  // immediately echo the same state back to the sender.
  const suppressNextOutbound = useRef(false);

  // Build one stable payload containing every render-driving value. useMemo
  // prevents the outbound effect from running solely because a new object was
  // allocated during an otherwise unchanged render.
  const state = useMemo<ControlsSyncState>(
    () => ({
      settings,
      count,
      kaleidoType,
      imagePath,
      imageSrc,
      imgWidth,
      imgHeight,
    }),
    [settings, count, kaleidoType, imagePath, imageSrc, imgWidth, imgHeight],
  );

  // Event listeners are installed once per window. Keep the latest state in a
  // ref so the main window can answer a later state request without reinstalling
  // its listener every time a slider changes.
  const latestStateRef = useRef(state);
  latestStateRef.current = state;

  /** Apply state received from the other Tauri window to this window's React state. */
  const applyRemoteState = (remote: ControlsSyncState) => {
    suppressNextOutbound.current = true;
    setSettings(remote.settings);
    setCount(remote.count);
    setKaleidoType(remote.kaleidoType);
    setImagePath(remote.imagePath);
    setImageSrc(remote.imageSrc);
    setImgWidth(remote.imgWidth);
    setImgHeight(remote.imgHeight);
  };

  // Install the role-specific inbound listeners once for the lifetime of this
  // window. Tauri's listen() is asynchronous, so every listener is collected
  // and disposed if the component unmounts before installation finishes.
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const install = async () => {
      if (role === "main") {
        // The fullscreen window receives changes made in the controls window.
        unlisteners.push(
          await listen<ControlsSyncState>(EVT_PATCH, (event) => {
            applyRemoteState(event.payload);
          }),
        );

        // The controls window may open after the last normal state broadcast.
        // Respond with the most recent authoritative state when requested.
        unlisteners.push(
          await listen(EVT_REQUEST_STATE, () => {
            void emit(EVT_STATE, latestStateRef.current);
          }),
        );
      } else {
        // The controls window treats state from the main window as authoritative.
        unlisteners.push(
          await listen<ControlsSyncState>(EVT_STATE, (event) => {
            applyRemoteState(event.payload);
          }),
        );

        // Install the listener before requesting state so the response cannot
        // arrive before this controls webview is ready to receive it.
        await emit(EVT_REQUEST_STATE);
      }

      // If the component was disposed while listen() was awaiting, immediately
      // tear down the listeners that were just installed.
      if (disposed) {
        for (const unlisten of unlisteners) {
          unlisten();
        }
      }
    };

    void install().catch((error) => {
      console.error("Failed to install controls synchronization", error);
    });

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };

    // The role and React state setters are stable for the lifetime of a window.
    // Reinstalling listeners on every state update would create duplicate event
    // handlers and stale closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // Broadcast local state changes. The main window publishes authoritative
  // state; the controls window publishes user-driven updates for the main
  // window to apply.
  useEffect(() => {
    if (suppressNextOutbound.current) {
      // This render was caused by remote state, so do not echo it back.
      suppressNextOutbound.current = false;
      return;
    }

    void emit(role === "main" ? EVT_STATE : EVT_PATCH, state).catch((error) => {
      console.error("Failed to synchronize controls state", error);
    });
  }, [role, state]);
}
