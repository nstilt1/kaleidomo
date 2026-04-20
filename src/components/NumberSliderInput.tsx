import { useEffect, useMemo, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { roundToNearestMultiple } from "@/components/Kaleidomo";

type NumberSliderInputProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  roundToInteger?: boolean;
  disabled?: boolean;
  className?: string;
  roundToMultipleOf?: number | null;
  setExternalValue?: (value: number) => void;
  setExternalValue2?: (value: number) => void;
  externalValueName?: string;
  externalValue2Name?: string;
  limitedCap?: number;
  limitedMin?: number;
  shouldLimit?: boolean;
  presetValues?: number[];
  sliderScale?: "linear" | "splitLog";
  sliderMidpointValue?: number;
  sliderMidpointPercent?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeLogRatio(value: number, start: number, end: number): number {
  if (value <= 0 || start <= 0 || end <= 0 || start === end) {
    return 0;
  }

  return Math.log(value / start) / Math.log(end / start);
}

function formatDisplayValue(
  value: number,
  roundToInteger: boolean,
  roundToMultipleOf: null | number
): string {
  if (roundToInteger) return String(Math.round(value));
  if (roundToMultipleOf) return roundToNearestMultiple(value, roundToMultipleOf).toString();
  return String(Number(value.toFixed(4)));
}

export function NumberSliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = "",
  roundToInteger = false,
  disabled = false,
  className = "",
  roundToMultipleOf = null,
  setExternalValue,
  setExternalValue2,
  externalValueName,
  externalValue2Name,
  limitedCap,
  limitedMin,
  shouldLimit = false,
  presetValues = [],
  sliderScale = "linear",
  sliderMidpointValue = 1,
  sliderMidpointPercent = 0.5,
}: NumberSliderInputProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const effectiveMin = shouldLimit && limitedMin != null ? limitedMin : min;
  const effectiveMax = shouldLimit && limitedCap != null ? limitedCap : max;
  const showMaxLimitNotice = shouldLimit && limitedCap != null && limitedCap < max;

  const displayValue = useMemo(() => {
    return formatDisplayValue(value, roundToInteger, roundToMultipleOf);
  }, [value, roundToInteger, roundToMultipleOf]);

  useEffect(() => {
    if (isEditing) setDraft(displayValue);
  }, [isEditing, displayValue]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const normalizeValue = (raw: number): number => {
    let normalized = roundToInteger ? Math.round(raw) : raw;
    if (roundToMultipleOf) normalized = roundToNearestMultiple(normalized, roundToMultipleOf);
    return clamp(normalized, effectiveMin, effectiveMax);
  };

  const normalizedMidpointPercent = clamp(sliderMidpointPercent, 0.05, 0.95);
  const canUseSplitLog =
    sliderScale === "splitLog" &&
    effectiveMin > 0 &&
    effectiveMax > 0 &&
    sliderMidpointValue > effectiveMin &&
    sliderMidpointValue < effectiveMax;

  const sliderToActualValue = (sliderValue: number): number => {
    if (!canUseSplitLog) {
      return normalizeValue(sliderValue);
    }

    const clampedSlider = clamp(sliderValue, 0, 1);

    if (clampedSlider <= normalizedMidpointPercent) {
      const sectionT = clampedSlider / normalizedMidpointPercent;
      const actual =
        effectiveMin *
        Math.exp(Math.log(sliderMidpointValue / effectiveMin) * sectionT);
      return normalizeValue(actual);
    }

    const sectionT =
      (clampedSlider - normalizedMidpointPercent) /
      (1 - normalizedMidpointPercent);
    const actual =
      sliderMidpointValue *
      Math.exp(Math.log(effectiveMax / sliderMidpointValue) * sectionT);

    return normalizeValue(actual);
  };

  const actualToSliderValue = (actualValue: number): number => {
    const normalizedActual = normalizeValue(actualValue);

    if (!canUseSplitLog) {
      return normalizedActual;
    }

    if (normalizedActual <= sliderMidpointValue) {
      const sectionT = safeLogRatio(
        normalizedActual,
        effectiveMin,
        sliderMidpointValue
      );
      return clamp(sectionT * normalizedMidpointPercent, 0, 1);
    }

    const sectionT = safeLogRatio(
      normalizedActual,
      sliderMidpointValue,
      effectiveMax
    );

    return clamp(
      normalizedMidpointPercent + sectionT * (1 - normalizedMidpointPercent),
      0,
      1
    );
  };

  const commitDraft = () => {
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed)) {
      setDraft(displayValue);
      setIsEditing(false);
      return;
    }
    onChange(normalizeValue(parsed));
    setIsEditing(false);
  };

  const cancelDraft = () => {
    setDraft(displayValue);
    setIsEditing(false);
  };

  const hasExternalSetter = Boolean(setExternalValue || setExternalValue2);

  const buttonLabel = (() => {
    const names = [externalValueName, externalValue2Name].filter(
      (name): name is string => Boolean(name && name.trim())
    );
    return names.length === 0 ? "Set External Value" : `Set ${names.join(" / ")}`;
  })();

  const handleSetExternalValues = () => {
    const normalized = normalizeValue(value);
    setExternalValue?.(normalized);
    setExternalValue2?.(normalized);
  };

  // NEW: preset click handler
  const handlePresetClick = (v: number) => {
    onChange(normalizeValue(v));
  };

  return (
    <div className={className}>
      <div className="flex justify-between items-center gap-4 mb-2">
        <label className="text-sm font-medium">{label}</label>

        {!isEditing ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => !disabled && setIsEditing(true)}
            className="text-sm tabular-nums rounded px-2 py-1 hover:bg-muted disabled:opacity-50"
          >
            {displayValue} {unit}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="number"
              inputMode={roundToInteger ? "numeric" : "decimal"}
              step={roundToInteger ? 1 : step}
              min={effectiveMin}
              max={effectiveMax}
              value={draft}
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitDraft();
                else if (e.key === "Escape") cancelDraft();
              }}
              className="w-24 rounded border bg-background px-2 py-1 text-sm text-right tabular-nums"
            />
            {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
          </div>
        )}
      </div>

      <Slider
        value={[actualToSliderValue(value)]}
        min={canUseSplitLog ? 0 : effectiveMin}
        max={canUseSplitLog ? 1 : effectiveMax}
        step={canUseSplitLog ? 0.001 : roundToInteger ? 1 : step}
        disabled={disabled}
        onValueChange={([next]) =>
          onChange(canUseSplitLog ? sliderToActualValue(next) : normalizeValue(next))
        }
      />

      {/* NEW: preset buttons */}
      {presetValues.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {presetValues.map((p) => (
            <button
              key={p}
              type="button"
              disabled={disabled}
              onClick={() => handlePresetClick(p)}
              className="px-3 py-1.5 text-sm rounded-full border hover:bg-muted disabled:opacity-50 tabular-nums"
            >
              {formatDisplayValue(p, roundToInteger, roundToMultipleOf)} {unit}
            </button>
          ))}
        </div>
      )}

      {hasExternalSetter && (
        <button
          type="button"
          disabled={disabled}
          onClick={handleSetExternalValues}
          className="mt-2 rounded border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      )}

      {showMaxLimitNotice && (
        <div className="mt-3 rounded-md border border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">
          Upon activating a Perpetual license, the bounds for this parameter will change to the
          following bounds: {min} to {max} {unit}
        </div>
      )}
    </div>
  );
}