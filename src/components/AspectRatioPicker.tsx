import { useMemo } from "react";
import { NumberSliderInput } from "@/components/NumberSliderInput";

type AspectRatioMode = string;

type AspectRatioPickerProps = {
  numerator: number;
  denominator: number;
  mode: AspectRatioMode;
  onModeChange: (mode: AspectRatioMode) => void;
  onChange: (numerator: number, denominator: number) => void;
  className?: string;
  customMin?: number;
  customMax?: number;
};

type Preset = {
  label: string;
  numerator: number;
  denominator: number;
};

const PRESETS: Preset[] = [
  { label: "9:16", numerator: 9, denominator: 16 },
  { label: "3:4", numerator: 3, denominator: 4 },
  { label: "1:1", numerator: 1, denominator: 1 },
  { label: "4:3", numerator: 4, denominator: 3 },
  { label: "16:9", numerator: 16, denominator: 9 },
];

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }

  return x || 1;
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.round(value));
}

export function reduceRatio(numerator: number, denominator: number) {
  const n = Math.max(1, Math.round(numerator));
  const d = Math.max(1, Math.round(denominator));
  const divisor = gcd(n, d);

  return {
    numerator: n / divisor,
    denominator: d / divisor,
  };
}

function normalizeRatio(numerator: number, denominator: number) {
  const n = normalizePositiveInteger(numerator);
  const d = normalizePositiveInteger(denominator);
  const divisor = gcd(n, d);

  return {
    numerator: n / divisor,
    denominator: d / divisor,
  };
}

export function AspectRatioPicker({
  numerator,
  denominator,
  mode,
  onModeChange,
  onChange,
  className = "",
  customMin = 1,
  customMax = 64,
}: AspectRatioPickerProps) {
  const normalized = useMemo(() => {
    return normalizeRatio(numerator, denominator);
  }, [numerator, denominator]);

  const selectedPresetLabel = useMemo(() => {
    const preset = PRESETS.find(
      (p) =>
        p.numerator === normalized.numerator &&
        p.denominator === normalized.denominator
    );

    return preset?.label ?? null;
  }, [normalized]);

  const safeNumerator = normalizePositiveInteger(numerator);
  const safeDenominator = normalizePositiveInteger(denominator);

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex justify-between items-center">
        <label className="text-sm font-medium">Aspect Ratio</label>
        <span className="text-sm text-muted-foreground tabular-nums">
          {normalized.numerator}:{normalized.denominator}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => {
          const isSelected =
            mode === "preset" && selectedPresetLabel === preset.label;

          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => {
                onModeChange("preset");
                onChange(preset.numerator, preset.denominator);
              }}
              className={[
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                isSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background hover:bg-muted",
              ].join(" ")}
              aria-pressed={isSelected}
            >
              {preset.label}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => onModeChange("custom")}
          className={[
            "rounded-md border px-3 py-1.5 text-sm transition-colors",
            mode === "custom"
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background hover:bg-muted",
          ].join(" ")}
          aria-pressed={mode === "custom"}
        >
          Custom
        </button>
      </div>

      {mode === "custom" ? (
        <div className="gap-4">
          <NumberSliderInput
            label="Ratio Width"
            value={safeNumerator}
            min={customMin}
            max={customMax}
            step={1}
            unit=""
            roundToInteger={true}
            onChange={(nextNumerator) => {
              onChange(normalizePositiveInteger(nextNumerator), safeDenominator);
            }}
          />

          <NumberSliderInput
            label="Ratio Height"
            value={safeDenominator}
            min={customMin}
            max={customMax}
            step={1}
            unit=""
            roundToInteger={true}
            onChange={(nextDenominator) => {
              onChange(safeNumerator, normalizePositiveInteger(nextDenominator));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}