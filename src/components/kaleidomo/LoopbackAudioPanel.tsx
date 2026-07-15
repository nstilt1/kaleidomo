// src/components/kaleidomo/LoopbackAudioPanel.tsx
//
// UI panel for system audio loopback source selection.
// Shown inside the Audio tab when the Tauri app is running (not in the browser).
//
// Behaviour by platform:
//   Windows  — shows "System Audio (all apps)" immediately, no prompt needed.
//   macOS    — shows "System Audio" and per-app list after the user clicks
//              "Scan Sources". First-time use triggers the macOS Screen
//              Recording permission dialog automatically.
//   Linux    — shows PipeWire monitor sources immediately.
//
// The component emits peaks via `onPeakRef` (a ref, not a callback) so the
// parent can feed them into the existing audio-reactive render path without
// re-rendering on every frame.

import { useEffect, useRef, useState } from "react";
import { AudioSource, LoopbackStatus, UseLoopbackAudioReturn } from "@/lib/use-loopback-audio";

interface LoopbackAudioPanelProps {
  loopback: UseLoopbackAudioReturn;
  /** Called with a new peak value each poll cycle (~30 fps). */
  onPeak: (peak: number) => void;
}

function kindLabel(kind: AudioSource["kind"]): string {
  switch (kind) {
    case "system_loopback": return "System";
    case "application":     return "App";
    case "input_device":    return "Input";
  }
}

function statusLabel(status: LoopbackStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "loading":
      return "Scanning";
    case "active":
      return "Live";
    case "error":
      return "Error";
  }
}

function statusClassName(status: LoopbackStatus): string {
  switch (status) {
    case "active":
      return "border-green-500/40 bg-green-500/10 text-green-500";
    case "loading":
      return "border-amber-500/40 bg-amber-500/10 text-amber-500";
    case "error":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "idle":
      return "border-border bg-muted text-muted-foreground";
  }
}

export function LoopbackAudioPanel({ loopback, onPeak }: LoopbackAudioPanelProps) {
  const { status, error, sources, selectedId, peakRef, listSources, startCapture, stopCapture } = loopback;
  const [displayPeak, setDisplayPeak] = useState(0);

  // Forward peaks to the parent every animation frame while active.
  // Using rAF rather than interval ties us to the render cadence.
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (status !== "active") {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      onPeak(0);
      setDisplayPeak(0);
      return;
    }
    const tick = () => {
      const peak = peakRef.current;
      onPeak(peak);
      setDisplayPeak(peak);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [status, peakRef, onPeak]);

  const systemSources = sources.filter((s) => s.kind === "system_loopback");
  const appSources    = sources.filter((s) => s.kind === "application");
  const inputSources  = sources.filter((s) => s.kind === "input_device");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Live System Audio
        </p>
        <span
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusClassName(status)}`}
          role="status"
          aria-live="polite"
        >
          {status === "active" && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          )}
          {statusLabel(status)}
        </span>
      </div>

      {/* macOS note — ScreenCaptureKit requires the user to grant permission */}
      {sources.length === 0 && status === "idle" && (
        <p className="text-xs text-muted-foreground">
          Click <strong>Scan Sources</strong> to discover available audio sources.
          {" "}On macOS, you may be prompted to grant Screen &amp; System Audio Recording permission.
        </p>
      )}

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive space-y-1">
          <p className="font-medium">Capture error</p>
          <p>{error}</p>
          {error.includes("Screen Recording") && (
            <p className="text-muted-foreground">
              Open <strong>System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording</strong> and enable Kaleidomo.
            </p>
          )}
        </div>
      )}

      {/* Source list */}
      {sources.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
          {systemSources.length > 0 && (
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide pt-1">System</p>
          )}
          {systemSources.map((src) => (
            <SourceRow
              key={src.id}
              source={src}
              isSelected={selectedId === src.id}
              isActive={status === "active"}
              onSelect={() => {
                if (selectedId === src.id && status === "active") {
                  stopCapture();
                } else {
                  startCapture(src.id);
                }
              }}
            />
          ))}

          {appSources.length > 0 && (
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide pt-1">Applications</p>
          )}
          {appSources.map((src) => (
            <SourceRow
              key={src.id}
              source={src}
              isSelected={selectedId === src.id}
              isActive={status === "active"}
              onSelect={() => {
                if (selectedId === src.id && status === "active") {
                  stopCapture();
                } else {
                  startCapture(src.id);
                }
              }}
            />
          ))}

          {inputSources.length > 0 && (
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide pt-1">Input Devices</p>
          )}
          {inputSources.map((src) => (
            <SourceRow
              key={src.id}
              source={src}
              isSelected={selectedId === src.id}
              isActive={status === "active"}
              onSelect={() => {
                if (selectedId === src.id && status === "active") {
                  stopCapture();
                } else {
                  startCapture(src.id);
                }
              }}
            />
          ))}
        </div>
      )}

      <div className="space-y-1" aria-label="Live system audio peak">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Input peak</span>
          <span className="font-mono">{displayPeak.toFixed(3)}</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-75"
            style={{ width: `${Math.min(100, Math.max(0, displayPeak * 100))}%` }}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={status === "loading"}
          onClick={listSources}
          className="flex-1 text-xs border rounded px-2 py-1.5 bg-background hover:bg-accent disabled:opacity-50 transition-colors"
        >
          {status === "loading" ? "Scanning…" : sources.length > 0 ? "Refresh Sources" : "Scan Sources"}
        </button>
        {status === "active" && (
          <button
            type="button"
            onClick={stopCapture}
            className="text-xs border border-destructive/40 text-destructive rounded px-2 py-1.5 hover:bg-destructive/10 transition-colors"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

// ── Source row ────────────────────────────────────────────────────────────────

interface SourceRowProps {
  source: AudioSource;
  isSelected: boolean;
  isActive: boolean;
  onSelect: () => void;
}

function SourceRow({ source, isSelected, isActive, onSelect }: SourceRowProps) {
  const isCapturing = isSelected && isActive;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs border transition-colors text-left
        ${isCapturing
          ? "bg-primary/10 border-primary/40 text-primary"
          : "bg-background border-border hover:bg-accent"}`}
    >
      <span className="truncate flex-1">{source.label}</span>
      <span className={`shrink-0 text-[10px] px-1 rounded ${isCapturing ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
        {isCapturing ? "●  active" : kindLabel(source.kind)}
      </span>
    </button>
  );
}