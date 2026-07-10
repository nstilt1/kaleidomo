// src/lib/use-controls-sync.ts
//
// Bidirectional settings synchronisation between the main (fullscreen) window
// and the floating controls window that opens alongside it.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Design                                                                  │
// │                                                                         │
// │  Both windows load the same Vite bundle. Each has its own JS heap and  │
// │  React state — there is no shared memory between them.                 │
// │                                                                         │
// │  Synchronisation uses Tauri's event system (tauri://event channel):    │
// │                                                                         │
// │   Main window                     Controls window                      │
// │   ───────────                     ───────────────                      │
// │   emit("kd://state", fullState)  ──►  listen → apply to local state   │
// │   listen("kd://patch")           ◄──  emit("kd://patch", partialState) │
// │                                                                         │
// │  "kd://state" is emitted by the main window whenever its settings      │
// │  change. The controls window receives this as the authoritative state. │
// │                                                                         │
// │  "kd://patch" is emitted by the controls window when the user moves    │
// │  a slider. The main window receives this and merges the partial state  │
// │  into its own settings via setSettings.                                │
// │                                                                         │
// │  To avoid feedback loops, each side skips re-emitting a change that    │
// │  arrived from the other side (tracked via a suppressRef flag).         │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Usage — main window (in Kaleidomo.tsx):
//   useControlsSync({ role: "main", settings, setSettings });
//
// Usage — controls window (in ControlsSidebar.tsx or similar):
//   useControlsSync({ role: "controls", settings, setSettings });

import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { Settings } from "./kaleidomo-session-context";

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/** Full settings state broadcast from the main window to the controls window. */
const EVT_STATE = "kd://state";

/** Partial settings patch emitted from the controls window to the main window. */
const EVT_PATCH = "kd://patch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseControlsSyncOptions {
  /** "main" = the fullscreen window that owns the canvas.
   *  "controls" = the floating controls window. */
  role: "main" | "controls";
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useControlsSync({ role, settings, setSettings }: UseControlsSyncOptions) {
  // When true, skip the next outbound emit to avoid an echo loop.
  const suppressRef = useRef(false);

  if (role === "main") {
    // ── Main window: broadcast full state whenever settings change ──────────
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      if (suppressRef.current) {
        // This change arrived as a patch from the controls window — don't
        // echo it back or the controls window will receive its own change.
        suppressRef.current = false;
        return;
      }
      void emit(EVT_STATE, settings);
    }, [settings]);

    // ── Main window: listen for patches from the controls window ────────────
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      let unlisten: (() => void) | undefined;
      listen<Partial<Settings>>(EVT_PATCH, (event) => {
        suppressRef.current = true; // don't re-broadcast this change
        setSettings((prev) => ({ ...prev, ...event.payload }));
      }).then((fn) => { unlisten = fn; }).catch(console.error);
      return () => { unlisten?.(); };
    }, [setSettings]);

  } else {
    // ── Controls window: listen for full state from the main window ─────────
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      let unlisten: (() => void) | undefined;
      listen<Settings>(EVT_STATE, (event) => {
        suppressRef.current = true; // don't echo this back as a patch
        setSettings(event.payload);
      }).then((fn) => { unlisten = fn; }).catch(console.error);
      return () => { unlisten?.(); };
    }, [setSettings]);

    // ── Controls window: emit a patch whenever the user changes settings ────
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      if (suppressRef.current) {
        // This change came from the main window — don't send it back.
        suppressRef.current = false;
        return;
      }
      void emit(EVT_PATCH, settings);
    }, [settings]);
  }
}