import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HostCredential } from "../lib/credential-port.js";
import { probeHostStatus, type HostStatus } from "../lib/host-status.js";
import { gatewayOrigin } from "../lib/runtime.js";

export type HostStatusView = { kind: "checking" } | HostStatus;

/**
 * Probes one host on mount and on demand. The result is only ever a status:
 * the probe never throws, so a failing host shows as `error` with its reason.
 *
 * A host with no local credential is "not paired" rather than a failed request:
 * a native build drops the Keychain item when the app is reinstalled or the item
 * is lost, while the registry entry survives in `localStorage`.
 */
export function useHostStatus(hostId: string, credential: HostCredential | null): {
  status: HostStatusView;
  refresh: () => void;
} {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HostStatusView>({ kind: "checking" });
  const [revision, setRevision] = useState(0);
  const credentialKey = credential ? (credential.kind === "cookie" ? credential.csrfToken : credential.token) : "";

  useEffect(() => {
    if (!credential) {
      setStatus({ kind: "error", code: "UNAUTHORIZED", message: t("hosts.notPaired") });
      return;
    }
    let cancelled = false;
    setStatus({ kind: "checking" });
    void probeHostStatus({ gatewayOrigin, hostId, credential }).then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => {
      cancelled = true;
    };
    // `credential` is derived from `credentialKey`; depending on the object
    // itself would re-probe on every render, because the port builds a fresh
    // one for each call.
  }, [hostId, credentialKey, revision, t]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return { status, refresh };
}
