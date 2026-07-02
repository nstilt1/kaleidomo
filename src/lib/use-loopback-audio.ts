// src/lib/use-loopback-audio.ts
//
// React hook that manages system audio loopback capture state.
//
// Flow:
//   1. On mount (or when the user opens the audio source picker), call
//      list_loopback_sources() → populate the dropdown.
//   2. User picks a source → call start_loopback_capture(sourceId).
//   3. While active, poll get_loopback_peak() at ~30 fps.
//      The returned peak (0–1) is a drop-in replacement for the file-based
//      normalizedAudioPeaksRef values used by the existing audio-reactive path.
//   4. User stops → call stop_loopback_capture().
//
// The hook emits the live peak via a ref (not state) so the render loop can
// read it every frame without triggering React re-renders.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriMacOS } from "./native-live-preview";

// ── Types mirroring the Rust structs ─────────────────────────────────────────

export interface AudioSource {
  id: string;
  label: string;
  pid: number | null;
  kind: "system_loopback" | "application" | "input_device";
}

export type LoopbackStatus =
  | "idle"
  | "loading"   // enumerate sources
  | "active"    // capture running
  | "error";

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseLoopbackAudioReturn {
  status: LoopbackStatus;
  error: string | null;
  sources: AudioSource[];
  selectedId: string | null;
  /** Current smoothed peak, updated ~30 fps. Read this ref in the render loop. */
  peakRef: React.MutableRefObject<number>;
  listSources: () => Promise<void>;
  startCapture: (sourceId: string) => Promise<void>;
  stopCapture: () => Promise<void>;
}

export function useLoopbackAudio(): UseLoopbackAudioReturn {
  const [status, setStatus] = useState<LoopbackStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Live peak value — written by the poll interval, read by the render loop.
  // Using a ref avoids re-render churn at 30 fps.
  const peakRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Start polling the Rust side for the smoothed peak value.
  const startPoll = useCallback(() => {
    clearPoll();
    // ~30 fps — matches the default render rate.
    pollRef.current = setInterval(async () => {
      try {
        const peak = await invoke<number>("get_loopback_peak");
        peakRef.current = peak;
      } catch {
        // Ignore transient errors during polling.
      }
    }, 33);
  }, [clearPoll]);

  const listSources = useCallback(async () => {
    // listSources is only meaningful in the Tauri app.
    // In the browser (WASM path) we return an empty list — loopback
    // isn't available there.
    if (!isTauriMacOS() && typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
      setSources([]);
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const list = await invoke<AudioSource[]>("list_loopback_sources");
      setSources(list);
      setStatus("idle");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }, []);

  const startCapture = useCallback(async (sourceId: string) => {
    setError(null);
    try {
      await invoke("start_loopback_capture", { sourceId });
      setSelectedId(sourceId);
      setStatus("active");
      startPoll();
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }, [startPoll]);

  const stopCapture = useCallback(async () => {
    clearPoll();
    peakRef.current = 0;
    try {
      await invoke("stop_loopback_capture");
    } catch {
      // Ignore — if the command fails the session is already gone.
    }
    setSelectedId(null);
    setStatus("idle");
  }, [clearPoll]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      clearPoll();
      // Fire-and-forget stop so the Rust thread exits cleanly.
      invoke("stop_loopback_capture").catch(() => {});
    };
  }, [clearPoll]);

  return {
    status,
    error,
    sources,
    selectedId,
    peakRef,
    listSources,
    startCapture,
    stopCapture,
  };
}