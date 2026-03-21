import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PerformanceMode = "cpu" | "gpu";

type PerformanceModeCardProps = {
  className?: string;
  disabled?: boolean;
  defaultMode?: PerformanceMode;
  onModeChange?: (mode: PerformanceMode) => void;
};

const STORAGE_KEY = "useGpuAcceleration";

export function PerformanceModeCard({
  className,
  disabled = false,
  defaultMode = "gpu",
  onModeChange,
}: PerformanceModeCardProps) {
  const [mode, setMode] = React.useState<PerformanceMode>(defaultMode);
  const [isInitializing, setIsInitializing] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [gpuAvailable, setGpuAvailable] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const available = await invoke<boolean>("gpu_available");

        if (!cancelled) {
          setGpuAvailable(available);
        }

        const stored = localStorage.getItem(STORAGE_KEY);

        let resolvedMode: PerformanceMode =
          stored === null ? defaultMode : stored === "true" ? "gpu" : "cpu";

        if (!available && resolvedMode === "gpu") {
          resolvedMode = "cpu";
          localStorage.setItem(STORAGE_KEY, "false");
        }

        if (!cancelled) {
          setMode(resolvedMode);
          onModeChange?.(resolvedMode);
        }

        await invoke("set_use_gpu_acceleration", {
          enabled: resolvedMode === "gpu",
        });

        if (stored === null) {
          localStorage.setItem(STORAGE_KEY, String(resolvedMode === "gpu"));
        }
      } catch (err) {
        console.error(err);

        if (!cancelled) {
          const fallback: PerformanceMode = "cpu";

          setMode(fallback);
          setGpuAvailable(false);
          onModeChange?.(fallback);
          localStorage.setItem(STORAGE_KEY, "false");

          toast.error("Failed to initialize performance mode", {
            description:
              "Kaleidomo could not verify GPU availability, so CPU mode is being used.",
          });
        }
      } finally {
        if (!cancelled) {
          setIsInitializing(false);
        }
      }
    };

    void init();

    return () => {
      cancelled = true;
    };
  }, [defaultMode, onModeChange]);

  const handleModeChange = async (nextMode: PerformanceMode) => {
    if (nextMode === "gpu" && !gpuAvailable) {
      toast.error("GPU mode is unavailable", {
        description:
          "GPU acceleration is not available on this system, so CPU mode will remain selected.",
      });
      return;
    }

    const previousMode = mode;

    setMode(nextMode);
    onModeChange?.(nextMode);
    setIsSaving(true);

    try {
      const enabled = nextMode === "gpu";

      localStorage.setItem(STORAGE_KEY, String(enabled));
      await invoke("set_use_gpu_acceleration", { enabled });
    } catch (err) {
      console.error(err);

      setMode(previousMode);
      onModeChange?.(previousMode);
      localStorage.setItem(STORAGE_KEY, String(previousMode === "gpu"));

      toast.error("Failed to update performance mode", {
        description:
          "The backend could not apply the selected performance mode, so the previous setting was restored.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const selectDisabled = disabled || isInitializing || isSaving;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Performance Mode</CardTitle>
        <CardDescription>
          Choose whether Kaleidomo should render using the CPU or GPU.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="performance-mode"
            className="text-sm font-medium leading-none"
          >
            Performance Mode
          </label>

          <Select
            value={mode}
            onValueChange={(value) =>
              void handleModeChange(value as PerformanceMode)
            }
            disabled={selectDisabled}
          >
            <SelectTrigger id="performance-mode" className="w-full">
              <SelectValue placeholder="Select a performance mode" />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="cpu">CPU (SIMD)</SelectItem>
              <SelectItem value="gpu" disabled={!gpuAvailable}>
                GPU
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-2xl border bg-muted/30 p-4">
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              CPU mode splits the rows of the image across all of its cores and
              uses SIMD to process up to 8 pixels at a time.
            </li>
            <li>
              GPU mode leverages the GPU to process the media across its cores in
              parallel. If you have a discrete GPU or an ARM GPU, this should be
              faster than the CPU.
            </li>
          </ul>

          <p className="mt-4 text-sm text-muted-foreground">
            Try generating a video with each performance mode to see which is
            faster on your device.
          </p>

          {!gpuAvailable && (
            <p className="mt-4 text-sm text-amber-600 dark:text-amber-400">
              GPU acceleration is currently unavailable on this system.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}