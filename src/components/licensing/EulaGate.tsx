import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { EulaModal } from "./EulaModal";
import { EULA_SECTIONS } from "./eulaContent";

type EulaStatus = {
  accepted: boolean;
  acceptedVersion: string | null;
  currentVersion: string;
  text: string;
};

type Props = {
  children: React.ReactNode;
};

export function EulaGate({ children }: Props) {
  const [loading, setLoading] = React.useState(true);
  const [accepted, setAccepted] = React.useState(false);
  const [checked, setChecked] = React.useState(false);
  const [accepting, setAccepting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<EulaStatus | null>(null);
  const [forceOpenFromMenu, setForceOpenFromMenu] = React.useState(false);

  const loadStatus = React.useCallback(async () => {
    setError(null);

    try {
      const result = await invoke<EulaStatus>("get_eula_status");
      setStatus(result);
      setAccepted(result.accepted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  React.useEffect(() => {
    const onOpenEula = () => {
      setChecked(false);
      setError(null);
      setForceOpenFromMenu(true);
    };

    window.addEventListener("menu-open-eula", onOpenEula);
    return () => {
      window.removeEventListener("menu-open-eula", onOpenEula);
    };
  }, []);

  const handleAccept = React.useCallback(async () => {
    setError(null);
    setAccepting(true);

    try {
      await invoke("accept_eula");
      const updated = await invoke<EulaStatus>("get_eula_status");
      setStatus(updated);
      setAccepted(updated.accepted);
      setForceOpenFromMenu(false);
      setChecked(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccepting(false);
    }
  }, []);

  const handleDecline = React.useCallback(() => {
    if (accepted) {
      setForceOpenFromMenu(false);
      setChecked(false);
      setError(null);
      return;
    }

    setError("You must accept the EULA to continue using the app.");
  }, [accepted]);

  const modalOpen = !loading && (!accepted || forceOpenFromMenu);
  const viewOnly = accepted && forceOpenFromMenu;
  const version = status?.currentVersion ?? "unknown";

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <>
      {children}

      <EulaModal
        open={modalOpen}
        version={version}
        sections={EULA_SECTIONS}
        acceptedChecked={checked}
        onAcceptedCheckedChange={setChecked}
        onAccept={handleAccept}
        onDecline={handleDecline}
        accepting={accepting}
        error={error}
        viewOnly={viewOnly}
      />
    </>
  );
}