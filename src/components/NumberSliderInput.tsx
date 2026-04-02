import { useEffect, useMemo, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { roundToNearestMultiple } from "@/components/AppContent";

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
  limitedMin?: number,
  shouldLimit?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDisplayValue(
  value: number,
  roundToInteger: boolean,
  roundToMultipleOf: null | number
): string {
  if (roundToInteger) {
    return String(Math.round(value));
  }

  if (roundToMultipleOf) {
    return roundToNearestMultiple(value, roundToMultipleOf).toString();
  }

  const rounded = Number(value.toFixed(4));
  return String(rounded);
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
}: NumberSliderInputProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const effectiveMin = shouldLimit && limitedMin != null ? limitedMin : min;
  const effectiveMax = shouldLimit && limitedCap != null ? limitedCap : max;
  const showMaxLimitNotice = shouldLimit && limitedCap != null && limitedCap < max;
  const showMinLimitNotice = shouldLimit && limitedMin != null && limitedMin > min;

  const displayValue = useMemo(() => {
    return formatDisplayValue(value, roundToInteger, roundToMultipleOf);
  }, [value, roundToInteger, roundToMultipleOf]);

  useEffect(() => {
    if (isEditing) {
      setDraft(displayValue);
    }
  }, [isEditing, displayValue]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const normalizeValue = (raw: number): number => {
    let normalized = roundToInteger ? Math.round(raw) : raw;

    if (roundToMultipleOf) {
      normalized = roundToNearestMultiple(normalized, roundToMultipleOf);
    }

    return clamp(normalized, effectiveMin, effectiveMax);
  };

  const commitDraft = () => {
    const parsed = Number(draft.trim());

    if (!Number.isFinite(parsed)) {
      setDraft(displayValue);
      setIsEditing(false);
      return;
    }

    const nextValue = normalizeValue(parsed);
    onChange(nextValue);
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

    if (names.length === 0) {
      return "Set External Value";
    }

    return `Set ${names.join(" / ")}`;
  })();

  const handleSetExternalValues = () => {
    const normalized = normalizeValue(value);

    setExternalValue?.(normalized);
    setExternalValue2?.(normalized);
  };

  return (
    <div className={className}>
      <div className="flex justify-between items-center gap-4 mb-2">
        <label className="text-sm font-medium">{label}</label>

        {!isEditing ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!disabled) {
                setIsEditing(true);
              }
            }}
            className="text-sm tabular-nums rounded px-2 py-1 hover:bg-muted disabled:opacity-50"
            aria-label={`Edit ${label}`}
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
                if (e.key === "Enter") {
                  commitDraft();
                } else if (e.key === "Escape") {
                  cancelDraft();
                }
              }}
              className="w-24 rounded border bg-background px-2 py-1 text-sm text-right tabular-nums"
              aria-label={`${label} value`}
            />
            {unit ? (
              <span className="text-sm text-muted-foreground">{unit}</span>
            ) : null}
          </div>
        )}
      </div>

      <Slider
        value={[normalizeValue(value)]}
        min={effectiveMin}
        max={effectiveMax}
        step={roundToInteger ? 1 : step}
        disabled={disabled}
        onValueChange={([next]) => {
          onChange(normalizeValue(next));
        }}
      />

      {hasExternalSetter ? (
        <button
          type="button"
          disabled={disabled}
          onClick={handleSetExternalValues}
          className="mt-2 rounded border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      ) : null}

      {showMaxLimitNotice ? (
        <div className="mt-3 rounded-md border border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700">
          Upon activating a Perpetual license, the bounds for this parameter will 
          change to the following bounds: {min} to {max} {unit ? ` ${unit}` : ""}
        </div>
      ) : null}
    </div>
  );
}