import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import {
  AlertCircle,
  Eye,
  Info,
  Loader2,
  PencilLine,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type NullableNumber = number | null | undefined;
type NullableString = string | null | undefined;

const LICENSE_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const LICENSE_SYNC_LAST_AT_KEY = "license.sync.lastAt";
const SHARE_HARDWARE_INFO_KEY = "license.shareHardwareInfo";

interface LicenseDataWire {
  version?: string;
  licenseType?: string;
  license_type?: string;
  licenseCode?: string;
  license_code?: string;
  customerFirstName?: string;
  customer_first_name?: string;
  customerLastName?: string;
  customer_last_name?: string;
  machineCount?: NullableNumber;
  machine_count?: NullableNumber;
  machineLimit?: NullableNumber;
  machine_limit?: NullableNumber;
  errorMessage?: NullableString;
  error_message?: NullableString;
}

interface LicenseInfoWire {
  isUnlocked?: boolean;
  is_unlocked?: boolean;
  licenseData?: LicenseDataWire;
  license_data?: LicenseDataWire;
}

export interface LicenseData {
  version: string;
  licenseType: string;
  licenseCode: string;
  customerFirstName: string;
  customerLastName: string;
  machineCount?: number;
  machineLimit?: number;
  errorMessage?: string;
}

export interface LicenseInfo {
  isUnlocked: boolean;
  licenseData: LicenseData;
}

export interface StatsDisplay {
  osName: string;
  computerName: string;
  is64Bit: boolean;
  usersLanguage: string;
  displayLanguage: string;
  numLogicalCores: number;
  numPhysicalCores: number;
  cpuFreqMhz: number;
  cpuArchitecture: string;
  ramMb: number;
  pageSize: number;
  cpuVendor: string;
  cpuModel: string;
  hasMmx: boolean;
  has3dNow: boolean;
  hasFma3: boolean;
  hasFma4: boolean;
  hasSse: boolean;
  hasSse2: boolean;
  hasSse3: boolean;
  hasSsse3: boolean;
  hasSse41: boolean;
  hasSse42: boolean;
  hasAvx: boolean;
  hasAvx2: boolean;
  hasAvx512f: boolean;
  hasAvx512bw: boolean;
  hasAvx512cd: boolean;
  hasAvx512dq: boolean;
  hasAvx512er: boolean;
  hasAvx512ifma: boolean;
  hasAvx512pf: boolean;
  hasAvx512vbmi: boolean;
  hasAvx512vl: boolean;
  hasAvx512vpopcntdq: boolean;
  hasNeon: boolean;
  gpuName?: string | null;
  gpuBrand?: string | null;
  gpuBackend?: string | null;
  gpuType?: string | null;
  gpuVramBytes?: number | null;
  gpuUnifiedMemory?: boolean | null;
  gpuCoreCount?: number | null;
  npuAvailable?: boolean | null;
  tpuAvailable?: boolean | null;
}

function normalizeLicenseInfo(input: LicenseInfoWire): LicenseInfo {
  console.log("In normalizeLicenseInfo");
  const data = input.licenseData ?? input.license_data ?? {};
  console.log(input);
  return {
    isUnlocked:
      typeof input.isUnlocked === "boolean"
        ? input.isUnlocked
        : Boolean(input.is_unlocked),
    licenseData: {
      version: data.version ?? "",
      licenseType: data.licenseType ?? data.license_type ?? "",
      licenseCode: data.licenseCode ?? data.license_code ?? "",
      customerFirstName: data.customerFirstName ?? data.customer_first_name ?? "",
      customerLastName: data.customerLastName ?? data.customer_last_name ?? "",
      machineCount:
        typeof data.machineCount === "number"
          ? data.machineCount
          : typeof data.machine_count === "number"
            ? data.machine_count
            : undefined,
      machineLimit:
        typeof data.machineLimit === "number"
          ? data.machineLimit
          : typeof data.machine_limit === "number"
            ? data.machine_limit
            : undefined,
      errorMessage: data.errorMessage ?? data.error_message ?? "",
    },
  };
}

async function fetchLicenseInfo(): Promise<LicenseInfo> {
  const response = await invoke<LicenseInfoWire>("license_data");
  return normalizeLicenseInfo(response);
}

async function fetchNeedsUpdate(): Promise<boolean> {
  return invoke<boolean>("is_new_version_available");
}

async function activateLicense(
  licenseCode: string,
  shareHardwareInfo: boolean,
): Promise<LicenseInfo> {
  const response = await invoke<LicenseInfoWire>("read_reply_from_webserver", {
    licenseCode,
    saveSystemStats: shareHardwareInfo,
  });

  return normalizeLicenseInfo(response);
}

async function updateLicense(
  licenseCode: string,
  shareHardwareInfo: boolean,
): Promise<LicenseInfo> {
  const response = await invoke<LicenseInfoWire>("update_license", {
    licenseCode,
    saveSystemStats: shareHardwareInfo,
  });

  return normalizeLicenseInfo(response);
}

async function deleteHardwareInfoFromCloud(
  licenseCode: string,
): Promise<LicenseInfo> {
  const response = await invoke<LicenseInfoWire>(
    "delete_hardware_info_from_cloud",
    {
      licenseCode,
    },
  );

  return normalizeLicenseInfo(response);
}

async function fetchCurrentHardwareInfo(): Promise<StatsDisplay> {
  return invoke<StatsDisplay>("display_system_stats");
}

async function fetchStoredHardwareInfo(): Promise<StatsDisplay> {
  return invoke<StatsDisplay>("get_current_cloud_info");
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatLabel(key: string): string {
  return key
    .replace(/^has/, "")
    .replace(/^is/, "is ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b3d Now\b/g, "3DNow")
    .replace(/\bMb\b/g, "MB")
    .replace(/\bMhz\b/g, "MHz")
    .replace(/\bCpu\b/g, "CPU")
    .replace(/\bGpu\b/g, "GPU")
    .replace(/\bVram\b/g, "VRAM")
    .replace(/\bNpu\b/g, "NPU")
    .replace(/\bTpu\b/g, "TPU")
    .replace(/\bAvx\b/g, "AVX")
    .replace(/\bSse\b/g, "SSE")
    .replace(/\bNeon\b/g, "NEON")
    .replace(/\bRam\b/g, "RAM")
    .replace(/\bOs\b/g, "OS")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const decimals = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatValue(key: keyof StatsDisplay, value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  if (key === "gpuVramBytes" && typeof value === "number") {
    return formatBytes(value);
  }

  return String(value);
}

type StatsEntry = {
  key: keyof StatsDisplay;
  label: string;
  currentValue: string;
  storedValue: string;
  different: boolean;
};

function buildStatsEntries(
  currentInfo: StatsDisplay | null,
  storedInfo: StatsDisplay | null,
): StatsEntry[] {
  const allKeys = new Set<keyof StatsDisplay>();

  if (currentInfo) {
    (Object.keys(currentInfo) as Array<keyof StatsDisplay>).forEach((key) => allKeys.add(key));
  }

  if (storedInfo) {
    (Object.keys(storedInfo) as Array<keyof StatsDisplay>).forEach((key) => allKeys.add(key));
  }

  return Array.from(allKeys)
    .map((key) => {
      const currentRaw = currentInfo?.[key];
      const storedRaw = storedInfo?.[key];
      const currentValue = formatValue(key, currentRaw);
      const storedValue = formatValue(key, storedRaw);

      return {
        key,
        label: formatLabel(String(key)),
        currentValue,
        storedValue,
        different: currentValue !== storedValue,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function usePersistentBoolean(
  storageKey: string,
  defaultValue: boolean,
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [value, setValue] = React.useState<boolean>(() => {
    if (typeof window === "undefined") {
      return defaultValue;
    }

    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) {
      return defaultValue;
    }

    return raw === "true";
  });

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, String(value));
    }
  }, [storageKey, value]);

  return [value, setValue];
}

function useLicenseSyncCooldown() {
  const [now, setNow] = React.useState(() => Date.now());
  const [lastSyncAt, setLastSyncAt] = React.useState<number>(() => {
    if (typeof window === "undefined") {
      return 0;
    }

    const raw = window.localStorage.getItem(LICENSE_SYNC_LAST_AT_KEY);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  });

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  const availableAt = lastSyncAt + LICENSE_SYNC_COOLDOWN_MS;
  const remainingMs = Math.max(0, availableAt - now);
  const canSync = remainingMs <= 0;

  const markSynced = React.useCallback(() => {
    const timestamp = Date.now();
    setLastSyncAt(timestamp);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LICENSE_SYNC_LAST_AT_KEY, String(timestamp));
    }
  }, []);

  return {
    canSync,
    remainingMs,
    remainingLabel: formatDuration(remainingMs),
    markSynced,
  };
}

type HardwareInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canSync: boolean;
  remainingLabel: string;
  onDeleteCloudInfo: () => Promise<void>;
  deletingCloudInfo: boolean;
  deleteDisabled: boolean;
};

function HardwareInfoDialog({
  open,
  onOpenChange,
  canSync,
  remainingLabel,
  onDeleteCloudInfo,
  deletingCloudInfo,
  deleteDisabled,
}: HardwareInfoDialogProps): React.JSX.Element {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [currentInfo, setCurrentInfo] = React.useState<StatsDisplay | null>(null);
  const [storedInfo, setStoredInfo] = React.useState<StatsDisplay | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [current, stored] = await Promise.all([
        fetchCurrentHardwareInfo(),
        fetchStoredHardwareInfo(),
    ]);

      setCurrentInfo(current);
      setStoredInfo(stored);
    } catch (err) {
      console.error("Failed to loadData for HardwareInfoDialog: ", err);
      const message =
        err instanceof Error ? err.message : "Failed to load hardware information.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (open) {
      void loadData();
    }
  }, [open, loadData]);

  const entries = React.useMemo(
    () => buildStatsEntries(currentInfo, storedInfo),
    [currentInfo, storedInfo],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl h-[90vh] overflow-hidden p-0">
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 p-6 pb-4">
            <DialogHeader>
                <DialogTitle>Stored Hardware Information</DialogTitle>
                <DialogDescription>
                Compare the hardware information currently read from this computer with the hardware
                information currently stored on your license.
                </DialogDescription>
            </DialogHeader>
            </div>

            <div className="shrink-0 space-y-3 px-6 pb-4">
            <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => void loadData()} disabled={loading}>
                {loading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh Hardware Info
                </Button>

                <Button
                type="button"
                variant="destructive"
                onClick={() => void onDeleteCloudInfo()}
                disabled={deleteDisabled || deletingCloudInfo || !canSync}
                >
                {deletingCloudInfo ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                )}
                Delete Hardware Information from Cloud
                </Button>
            </div>

            <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                Deleting hardware information from the cloud does not remove the computer name.
                </AlertDescription>
            </Alert>

            {!canSync && (
                <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                    License sync actions are available again in {remainingLabel}.
                </AlertDescription>
                </Alert>
            )}

            {error && (
                <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            </div>

            <div className="min-h-0 flex-1 px-6 pb-6">
            {loading ? (
                <div className="flex h-full items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading hardware information...
                </div>
            ) : (
                <div className="h-full rounded-lg border overflow-hidden">
                <div className="h-full overflow-auto">
                    <div className="grid grid-cols-[minmax(180px,1.2fr)_minmax(120px,1fr)_minmax(120px,1fr)] text-sm">
                    <div className="sticky top-0 z-10 bg-background border-b px-4 py-3 font-medium">
                        Field
                    </div>
                    <div className="sticky top-0 z-10 bg-background border-b border-l px-4 py-3 font-medium">
                        Current machine values
                    </div>
                    <div className="sticky top-0 z-10 bg-background border-b border-l px-4 py-3 font-medium">
                        Stored on license
                    </div>

                    {entries.map((entry) => (
                        <React.Fragment key={String(entry.key)}>
                        <div className="px-4 py-2 border-b text-muted-foreground">
                            {entry.label}
                        </div>
                        <div
                            className={`px-4 py-2 border-b border-l break-words ${
                            entry.different ? "bg-amber-50 dark:bg-amber-950/20" : ""
                            }`}
                        >
                            {entry.currentValue}
                        </div>
                        <div
                            className={`px-4 py-2 border-b border-l break-words ${
                            entry.different ? "bg-amber-50 dark:bg-amber-950/20" : ""
                            }`}
                        >
                            {entry.storedValue}
                        </div>
                        </React.Fragment>
                    ))}
                    </div>
                </div>
                </div>
            )}
            </div>
        </div>
        </DialogContent>
    </Dialog>
  );
}

export function LicenseActivationCard(): React.JSX.Element {
  const [licenseInfo, setLicenseInfo] = React.useState<LicenseInfo | null>(null);
  const [needsUpdate, setNeedsUpdate] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [showRegistrationInfo, setShowRegistrationInfo] = React.useState(false);
  const [showHardwareDialog, setShowHardwareDialog] = React.useState(false);

  const [licenseCode, setLicenseCode] = React.useState("");
  const [hasUserEdited, setHasUserEdited] = React.useState(false);
  const [shareHardwareInfo, setShareHardwareInfo] = usePersistentBoolean(
    SHARE_HARDWARE_INFO_KEY,
    false,
  );
  const [formError, setFormError] = React.useState<string | null>(null);
  const [deletingCloudInfo, setDeletingCloudInfo] = React.useState(false);
  const [updatingLicense, setUpdatingLicense] = React.useState(false);

  const { canSync, remainingLabel, markSynced } = useLicenseSyncCooldown();
  const [version, setVersion] = React.useState("");
  const [productName, setProductName] = React.useState("");
  const [downloadsUrl, setDownloadsUrl] = React.useState("");
  const [_storePageUrl, setStorePageUrl] = React.useState("");

  React.useEffect(() => {
    invoke<string>("current_version")
      .then(setVersion)
      .catch(() => setVersion(""));
    invoke<string>("product_name")
      .then(setProductName)
      .catch(() => setProductName(""));
    invoke<string>("downloads_url")
      .then(setDownloadsUrl)
      .catch(() => setDownloadsUrl(""));
    invoke<string>("store_page_url")
      .then(setStorePageUrl)
      .catch(() => setStorePageUrl(""));
  }, []);

  React.useEffect(() => {
    if (!hasUserEdited && licenseInfo?.licenseData.licenseCode) {
      setLicenseCode(licenseInfo.licenseData.licenseCode);
    }
  }, [licenseInfo, hasUserEdited]);

  const loadState = React.useCallback(async () => {
    setFormError(null);

    try {
      const [info, updateFlag] = await Promise.all([
        fetchLicenseInfo(),
        fetchNeedsUpdate().catch(() => false),
      ]);

      setLicenseInfo(info);
      setNeedsUpdate(updateFlag);
    } catch (error) {
      console.error("Failed to load license information in loadState: ", error);
      const message =
        error instanceof Error ? error.message : "Failed to load license information.";
      setFormError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void loadState();
  }, [loadState]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadState();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const trimmedCode = licenseCode.trim();

    if (!trimmedCode) {
      setFormError("Please enter your license code.");
      return;
    }

    setSubmitting(true);

    try {
      const updatedInfo = await activateLicense(trimmedCode, shareHardwareInfo);
      setLicenseInfo(updatedInfo);

      const updateFlag = await fetchNeedsUpdate().catch(() => false);
      setNeedsUpdate(updateFlag);

      if (updatedInfo.isUnlocked) {
        setLicenseCode("");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "License activation failed.";
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const effectiveLicenseCode = React.useMemo(() => {
    const codeFromState = licenseCode.trim();
    const codeFromLicense = licenseInfo?.licenseData.licenseCode?.trim() ?? "";
    return codeFromLicense || codeFromState;
  }, [licenseCode, licenseInfo]);

  const handleDeleteCloudInfo = async () => {
    if (!effectiveLicenseCode || !canSync) {
      return;
    }

    setFormError(null);
    setDeletingCloudInfo(true);

    try {
      const updatedInfo = await deleteHardwareInfoFromCloud(effectiveLicenseCode);
      setLicenseInfo(updatedInfo);
      markSynced();

      const updateFlag = await fetchNeedsUpdate().catch(() => false);
      setNeedsUpdate(updateFlag);
    } catch (error) {
      console.error("Failed to delete cloud hardware information: ", error);
      const message =
        error instanceof Error ? error.message : "Failed to delete cloud hardware information.";
      setFormError(message);
    } finally {
      setDeletingCloudInfo(false);
    }
  };

  const handleUpdateLicense = async () => {
    if (!effectiveLicenseCode || !canSync) {
      return;
    }

    setFormError(null);
    setUpdatingLicense(true);

    try {
      const updatedInfo = await updateLicense(effectiveLicenseCode, shareHardwareInfo);
      setLicenseInfo(updatedInfo);
      markSynced();

      const updateFlag = await fetchNeedsUpdate().catch(() => false);
      setNeedsUpdate(updateFlag);
    } catch (error) {
      console.error("Failed to update license: ", error);
      const message =
        error instanceof Error ? error.message : "Failed to update license.";
      setFormError(message);
    } finally {
      setUpdatingLicense(false);
    }
  };

  const machineInfoVisible =
    licenseInfo?.licenseData.machineCount !== undefined ||
    licenseInfo?.licenseData.machineLimit !== undefined;

  const syncActionDisabled =
    !effectiveLicenseCode ||
    deletingCloudInfo ||
    updatingLicense;

  const hardwareShareSection = (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-start gap-3">
        <Checkbox
          id="share-hardware-info"
          checked={shareHardwareInfo}
          onCheckedChange={(checked) => setShareHardwareInfo(checked === true)}
          disabled={submitting || deletingCloudInfo || updatingLicense}
        />
        <div className="space-y-2 flex-1">
          <label
            htmlFor="share-hardware-info"
            className="text-sm font-medium leading-none cursor-pointer"
          >
            Share anonymized hardware information with Software Licensor
          </label>

          <p className="text-sm text-muted-foreground">
            Sharing hardware information allows us to better optimize our software for your hardware.
            Your computer&apos;s name will be shared with Software Licensor regardless of your choice 
            so that you can see the devices registered with your license on the store&apos;s site.
          </p>

          <p className="text-sm text-muted-foreground">
            See the{" "}
            <a
              href="https://softwarelicensor.com/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              Privacy Policy
            </a>
            .
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <Dialog open={showHardwareDialog} onOpenChange={setShowHardwareDialog}>
              <DialogTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  <Eye className="mr-2 h-4 w-4" />
                  View Stored Hardware Info
                </Button>
              </DialogTrigger>

              <HardwareInfoDialog
                open={showHardwareDialog}
                onOpenChange={setShowHardwareDialog}
                canSync={canSync}
                remainingLabel={remainingLabel}
                onDeleteCloudInfo={handleDeleteCloudInfo}
                deletingCloudInfo={deletingCloudInfo}
                deleteDisabled={syncActionDisabled}
              />
            </Dialog>

            {licenseInfo?.isUnlocked && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleUpdateLicense()}
                disabled={syncActionDisabled || !canSync}
              >
                {updatingLicense ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Updating License...
                  </>
                ) : (
                  <>
                    <PencilLine className="mr-2 h-4 w-4" />
                    Update License
                  </>
                )}
              </Button>
            )}
          </div>

          {!canSync && (
            <p className="text-sm text-muted-foreground">
              License sync actions are available again in {remainingLabel}.
            </p>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="w-full max-w-2xl">
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl">License Activation for {productName} v{version}</CardTitle>
              <CardDescription>
                Activate your license and review your current registration status.
              </CardDescription>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={loading || refreshing || submitting || deletingCloudInfo || updatingLicense}
            >
              {refreshing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Refresh
            </Button>
          </div>

          {needsUpdate && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                A new version is available for this product. Please update to access the latest
                licensed version. New version: V{licenseInfo?.licenseData.version}. Visit the downloads page to get the latest version.
                <Button
                  type="button"
                  variant="link"
                  onClick={() => open(downloadsUrl)}
                >
                  Downloads Page
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {formError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
        </CardHeader>

        <CardContent className="space-y-6">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading license information...
            </div>
          ) : licenseInfo?.isUnlocked ? (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5" />
                  <div className="space-y-1">
                    <p className="font-medium">License status: Active</p>
                    <p className="text-sm text-muted-foreground">
                      License type: {licenseInfo.licenseData.licenseType || "Unknown"}
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowRegistrationInfo((prev) => !prev)}
                >
                  Registration Information
                </Button>
              </div>

              {showRegistrationInfo && (
                <div className="rounded-lg border p-4 space-y-2 text-sm">
                  <p>
                    <span className="font-medium">Registered to:</span>{" "}
                    {`${licenseInfo.licenseData.customerFirstName} ${licenseInfo.licenseData.customerLastName}`.trim() ||
                      "Unknown"}
                  </p>

                  <p>
                    <span className="font-medium">License type:</span>{" "}
                    {licenseInfo.licenseData.licenseType || "Unknown"}
                  </p>

                  {machineInfoVisible && (
                    <p>
                      <span className="font-medium">Machine limit:</span>{" "}
                      {licenseInfo.licenseData.machineCount ?? "?"}/
                      {licenseInfo.licenseData.machineLimit ?? "?"}
                    </p>
                  )}
                </div>
              )}

              {hardwareShareSection}
            </div>
          ) : (
            <div className="space-y-5">
              {!!licenseInfo?.licenseData.errorMessage && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{licenseInfo.licenseData.errorMessage}</AlertDescription>
                </Alert>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <label htmlFor="license-code" className="text-sm font-medium">
                    License code
                  </label>
                  <Input
                    id="license-code"
                    value={licenseCode}
                    onChange={(event) => {
                      setHasUserEdited(true);
                      setLicenseCode(event.target.value);
                    }}
                    placeholder="Enter your license code"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                  />
                </div>

                {hardwareShareSection}

                <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Activating...
                    </>
                  ) : (
                    "Activate License"
                  )}
                </Button>
              </form>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default LicenseActivationCard;