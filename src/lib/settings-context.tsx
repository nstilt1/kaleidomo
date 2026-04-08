import React from "react";

export type WedgePickerMode = "legacy" | "scaled";

type SettingsContextValue = {
  mode: WedgePickerMode;
  setMode: React.Dispatch<React.SetStateAction<WedgePickerMode>>;
  diagonalMultiplier: number;
  setDiagonalMultiplier: React.Dispatch<React.SetStateAction<number>>;
};

const SettingsContext =
  React.createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mode, setMode] = React.useState<WedgePickerMode>("legacy");
  const [diagonalMultiplier, setDiagonalMultiplier] = React.useState(1.5);

  const value = React.useMemo(
    () => ({
      mode,
      setMode,
      diagonalMultiplier,
      setDiagonalMultiplier,
    }),
    [mode, diagonalMultiplier]
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