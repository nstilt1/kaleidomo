import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Info, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

type NullableNumber = number | null | undefined;
type NullableString = string | null | undefined;

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

function normalizeLicenseInfo(input: LicenseInfoWire): LicenseInfo {
  const data = input.licenseData ?? input.license_data ?? {};

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

export function LicenseActivationCard(): React.JSX.Element {
  const [licenseInfo, setLicenseInfo] = React.useState<LicenseInfo | null>(null);
  const [needsUpdate, setNeedsUpdate] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [showRegistrationInfo, setShowRegistrationInfo] = React.useState(false);

  const [licenseCode, setLicenseCode] = React.useState("");
  const [hasUserEdited, _setHasUserEdited] = React.useState(false);
  const [shareHardwareInfo, setShareHardwareInfo] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

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
        true
      ]);

      setLicenseInfo(info);
      setNeedsUpdate(updateFlag);
    } catch (error) {
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

  const machineInfoVisible =
    licenseInfo?.licenseData.machineCount !== undefined ||
    licenseInfo?.licenseData.machineLimit !== undefined;

  return (
    <div className="w-full max-w-2xl">
      <Card className="border-border/60 shadow-sm">
        <CardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-xl">License Activation</CardTitle>
              <CardDescription>
                Activate your license and review your current registration status.
              </CardDescription>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={loading || refreshing || submitting}
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
                A new version is available for this license. Please update to access the latest
                licensed version. New version: V{licenseInfo?.licenseData.version}
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
                    onChange={(event) => setLicenseCode(event.target.value)}
                    placeholder="Enter your license code"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                  />
                </div>

                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="share-hardware-info"
                      checked={shareHardwareInfo}
                      onCheckedChange={(checked) => setShareHardwareInfo(checked === true)}
                      disabled={submitting}
                    />
                    <div className="space-y-2">
                      <label
                        htmlFor="share-hardware-info"
                        className="text-sm font-medium leading-none cursor-pointer"
                      >
                        Share anonymized hardware information with Software Licensor
                      </label>

                      <p className="text-sm text-muted-foreground">
                        Sharing hardware information enables you to see the registered devices on
                        your license. It also shares hardware stats such as amount of RAM, type of
                        CPU, SIMD instruction sets, and related anonymized system details.
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
                    </div>
                  </div>
                </div>

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