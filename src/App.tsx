import { BrowserRouter, Routes, Route, Navigate, Outlet, NavLink, useNavigate, useLocation } from "react-router";
import { Settings, KeyRound } from "lucide-react"
import Kaleidomo from "@/components/Kaleidomo"
import { LicenseActivationCard } from "@/components/licensing/LicenseActivationCard"
import { PerformanceModeCard } from "@/components/PerformanceModeCard"
import { LicenseProvider, useLicense } from "@/lib/license-context"
import React from "react"
import { invoke } from "@tauri-apps/api/core"
import { KaleidomoProvider } from "@/lib/kaleidomo-session-context" 
import { setupAppMenu, type AppMenuHandles } from "@/lib/app-menu";

//import { attachConsole} from "@tauri-apps/plugin-log"

function CreateIcon() {
  return (
    <img
      src="/icons/kaleidomo-nav.png"
      alt=""
      className="h-4 w-4 rounded-sm object-contain"
    />
  )
}

function AppLayout() {
  const navigate = useNavigate()

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
  const { isUnlocked, licenseType } = useLicense()

  const [needsUpdate, setNeedsUpdate] = React.useState(false);

  React.useEffect(() => {
    invoke<boolean>("is_new_version_available")
      .then(setNeedsUpdate)
      .catch(() => setNeedsUpdate(false));
  }, [])

  const resolvedLicenseType =
    isUnlocked && licenseType?.trim() ? licenseType : "Inactive"

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
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
                "bg-secondary text-secondary-foreground hover:bg-secondary/80"
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
  )
}

function LicensePage() {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl">
        <LicenseActivationCard />
      </div>
    </div>
  )
}

function SettingsPage() {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-4xl space-y-4">
        <PerformanceModeCard />
      </div>
    </div>
  )
}

function CreatePage() {
  return (
    <div className="h-full min-h-0">
      <Kaleidomo />
    </div>
  )
}

export default function App() {
  return (
    <LicenseProvider>
      <KaleidomoProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<AppLayout />}>
              <Route index element={<Navigate to="/create" replace />} />
              <Route path="create" element={<CreatePage />} />
              <Route path="license" element={<LicensePage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </KaleidomoProvider>
    </LicenseProvider>
  )
}