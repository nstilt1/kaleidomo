import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  NavLink,
  useNavigate,
  useLocation,
} from "react-router";
import { Settings, KeyRound } from "lucide-react";
import Kaleidomo from "@/components/Kaleidomo";
import { LicenseActivationCard } from "@/components/licensing/LicenseActivationCard";
import { PerformanceModeCard } from "@/components/PerformanceModeCard";
import { LicenseProvider, useLicense } from "@/lib/license-context";
import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { KaleidomoProvider } from "@/lib/kaleidomo-session-context";
import { setupAppMenu, type AppMenuHandles } from "@/lib/app-menu";
import {
  SettingsProvider,
  useSettings,
} from "@/lib/settings-context";
import { FullscreenProvider, useFullscreenContext } from "@/lib/fullscreen-context";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NumberSliderInput } from "@/components/NumberSliderInput";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EulaGate } from "./components/licensing/EulaGate";
//import { attachConsole} from "@tauri-apps/plugin-log"

function CreateIcon() {
  return (
    <img
      src="/icons/kaleidomo-nav.png"
      alt=""
      className="h-4 w-4 rounded-sm object-contain"
    />
  );
}

function AppLayout() {
  const navigate = useNavigate();

  const location = useLocation();
  const menuHandlesRef = React.useRef<AppMenuHandles | null>(null);

  React.useEffect(() => {
    void (async () => {
      menuHandlesRef.current = await setupAppMenu();
    })();
  }, []);

  React.useEffect(() => {
    const isCreate = location.pathname === "/create";
    const handles = menuHandlesRef.current;

    if (!handles) {
      return;
    }

    void handles.loadImagePreset.setEnabled(isCreate);
    void handles.saveImagePreset.setEnabled(isCreate);
    void handles.loadVideoPreset.setEnabled(isCreate);
    void handles.saveVideoPreset.setEnabled(isCreate);
    void handles.loadProject.setEnabled(isCreate);
    void handles.saveProject.setEnabled(isCreate);
  }, [location.pathname]);

  const { isUnlocked, licenseType } = useLicense();
  const { isFullscreen } = useFullscreenContext();

  const [needsUpdate, setNeedsUpdate] = React.useState(false);

  React.useEffect(() => {
    invoke<boolean>("is_new_version_available")
      .then(setNeedsUpdate)
      .catch(() => setNeedsUpdate(false));
  }, []);

  const resolvedLicenseType =
    isUnlocked && licenseType?.trim() ? licenseType : "Inactive";

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header is hidden in fullscreen so the canvas occupies the entire window */}
      <header className={`sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75${isFullscreen ? " hidden" : ""}`}>
        <div className="flex h-14 items-center justify-between gap-4 px-4">
          <nav className="flex items-center gap-1 overflow-x-auto">
            <NavLink
              to="/create"
              className={({ isActive }) =>
                [
                  "inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors whitespace-nowrap",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                ].join(" ")
              }
            >
              <CreateIcon />
              <span>Create</span>
            </NavLink>

            <NavLink
              to="/license"
              className={({ isActive }) =>
                [
                  "inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors whitespace-nowrap",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                ].join(" ")
              }
            >
              <KeyRound className="h-4 w-4" />
              <span>License</span>
            </NavLink>

            <NavLink
              to="/settings"
              className={({ isActive }) =>
                [
                  "inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors whitespace-nowrap",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                ].join(" ")
              }
            >
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </NavLink>
          </nav>

          {needsUpdate && (
            <button
              type="button"
              onClick={() => navigate("/license")}
              className={[
                "inline-flex h-10 shrink-0 items-center rounded-md border px-3 text-sm font-medium transition-colors",
                "bg-secondary text-secondary-foreground hover:bg-secondary/80",
              ].join(" ")}
            >
              {`Update available`}
            </button>
          )}

          <button
            type="button"
            onClick={() => navigate("/license")}
            className={[
              "inline-flex h-10 shrink-0 items-center rounded-md border px-3 text-sm font-medium transition-colors",
              isUnlocked
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
            ].join(" ")}
          >
            {`License type: ${resolvedLicenseType}`}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

function LicensePage() {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl">
        <LicenseActivationCard />
      </div>
    </div>
  );
}

function WedgePickerSettingsCard() {
  const {
    mode,
    setMode,
    zoomSliderMidpointPercent,
    setZoomSliderMidpointPercent,
  } = useSettings();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Wedge Picker</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium">Picker Mode</label>
          <Select
            value={mode}
            onValueChange={(value) =>
              setMode(value as "legacy" | "scaled")
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select wedge picker mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Modes</SelectLabel>
                <SelectItem value="legacy">Legacy</SelectItem>
                <SelectItem value="scaled">Scaled</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Legacy mode uses the direct backend zoom value. Scaled mode is the
            default and uses a fixed 1.5× image-diagonal reference, then maps
            that into backend zoom using the hexagonal tiling math from the
            shader.
          </p>
        </div>

        <NumberSliderInput
          label="Zoom Slider Midpoint"
          value={zoomSliderMidpointPercent * 100}
          min={20}
          max={80}
          step={1}
          onChange={(value) => setZoomSliderMidpointPercent(value / 100)}
          unit="%"
          roundToInteger={true}
        />
        <p className="text-xs text-muted-foreground">
          This controls how much of the slider track is reserved for values
          below 1.0x. A value of 50% makes 1.0x the midpoint of the zoom slider.
        </p>
      </CardContent>
    </Card>
  );
}

function SettingsPage() {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl space-y-4">
        <PerformanceModeCard />
        <WedgePickerSettingsCard />
      </div>
    </div>
  );
}

function CreatePage() {
  return (
    <div className="h-full min-h-0">
      <Kaleidomo />
    </div>
  );
}

// Rendered in the floating controls window (label "controls") that opens
// alongside the fullscreen canvas. Wraps Kaleidomo with controlsOnly=true
// so only the sidebar is shown — no canvas, no engine initialisation.
// useControlsSync inside Kaleidomo handles bidirectional settings sync with
// the main window via Tauri events.
function ControlsPage() {
  const { exitFullscreen } = useFullscreenContext();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <button
        type="button"
        className="shrink-0 border-b px-4 py-3 text-left font-semibold hover:bg-accent"
        onClick={() => void exitFullscreen()}
      >
        Exit Fullscreen (Esc)
      </button>
      <div className="min-h-0 flex-1">
        <Kaleidomo controlsOnly={true} />
      </div>
    </div>
  );
}

export default function App() {
  const isControlsWindow = getCurrentWindow().label === "controls";

  const providers = (children: React.ReactNode) => (
    <LicenseProvider>
      <KaleidomoProvider>
        <SettingsProvider>
          <FullscreenProvider disablePointerExit={isControlsWindow}>
            {children}
          </FullscreenProvider>
        </SettingsProvider>
      </KaleidomoProvider>
    </LicenseProvider>
  );

  // The controls webview is a dedicated native window. Render its content
  // directly instead of routing it through AppLayout or EulaGate.
  if (isControlsWindow) {
    return providers(<ControlsPage />);
  }

  return (
    <EulaGate>
      {providers(
        <HashRouter>
          <Routes>
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Navigate to="/create" replace />} />
              <Route path="create" element={<CreatePage />} />
              <Route path="license" element={<LicensePage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </HashRouter>,
      )}
    </EulaGate>
  );
}
