import React, { createContext, useContext } from "react";
import { useFullscreen, type UseFullscreenReturn } from "./use-fullscreen";

const FullscreenContext = createContext<UseFullscreenReturn | null>(null);

export function FullscreenProvider({
  children,
  disablePointerExit = false,
}: {
  children: React.ReactNode;
  disablePointerExit?: boolean;
}) {
  const fullscreen = useFullscreen({ disablePointerExit });

  return (
    <FullscreenContext.Provider value={fullscreen}>
      {children}
    </FullscreenContext.Provider>
  );
}

export function useFullscreenContext(): UseFullscreenReturn {
  const context = useContext(FullscreenContext);

  if (!context) {
    throw new Error(
      "useFullscreenContext must be used within a FullscreenProvider",
    );
  }

  return context;
}
