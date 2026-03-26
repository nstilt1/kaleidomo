import * as React from "react";
import { invoke } from "@tauri-apps/api/core";

type NullableNumber = number | null | undefined;
type NullableString = string | null | undefined;

interface LicenseDataWire {
  version?: string;
  licenseType?: string;
  license_type?: string;
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

interface LicenseContextValue {
  licenseInfo: LicenseInfo | null;
  isLoading: boolean;
  refreshLicense: () => Promise<void>;
  isUnlocked: boolean;
  licenseType: string | null;
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

const LicenseContext = React.createContext<LicenseContextValue | undefined>(undefined);

export function LicenseProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [licenseInfo, setLicenseInfo] = React.useState<LicenseInfo | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  const refreshLicense = React.useCallback(async () => {
    try {
      const info = await fetchLicenseInfo();
      setLicenseInfo(info);
    } catch (error) {
      console.error("Failed to load license info - `license_data` was error:", error);
      setLicenseInfo(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshLicense();
  }, [refreshLicense]);

  const value = React.useMemo<LicenseContextValue>(
    () => ({
      licenseInfo,
      isLoading,
      refreshLicense,
      isUnlocked: licenseInfo?.isUnlocked ?? false,
      licenseType: licenseInfo?.licenseData.licenseType || null,
    }),
    [licenseInfo, isLoading, refreshLicense],
  );

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

export function useLicense(): LicenseContextValue {
  const context = React.useContext(LicenseContext);
  if (!context) {
    throw new Error("useLicense must be used within a LicenseProvider");
  }
  return context;
}