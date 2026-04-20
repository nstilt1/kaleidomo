import React from "react";

export type WedgePickerMode = "legacy" | "scaled";

type SettingsContextValue = {
  mode: WedgePickerMode;
  setMode: React.Dispatch<React.SetStateAction<WedgePickerMode>>;
  zoomSliderMidpointPercent: number;
  setZoomSliderMidpointPercent: React.Dispatch<React.SetStateAction<number>>;
};

const SettingsContext =
  React.createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mode, setMode] = React.useState<WedgePickerMode>("scaled");
  const [zoomSliderMidpointPercent, setZoomSliderMidpointPercent] =
    React.useState(0.5);

  const value = React.useMemo(
    () => ({
      mode,
      setMode,
      zoomSliderMidpointPercent,
      setZoomSliderMidpointPercent,
    }),
    [mode, zoomSliderMidpointPercent]
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = React.useContext(SettingsContext);

  if (!ctx) {
    throw new Error(
      "useSettings must be used within WedgePickerSettingsProvider"
    );
  }

  return ctx;
}
