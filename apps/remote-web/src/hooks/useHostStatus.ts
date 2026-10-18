import { useCallback, useEffect, useState } from "react";

import type { HostCredential } from "../lib/credential-port.js";
import { probeHostStatus, type HostStatus } from "../lib/host-status.js";
import { gatewayOrigin } from "../lib/runtime.js";

export type HostStatusView = { kind: "checking" } | HostStatus;

/**
 * Probes one host on mount and on demand. The result is only ever a status:
 * the probe never throws, so a failing host shows as `error` with its reason.
 */
export function useHostStatus(hostId: string, credential: HostCredential | null): {
  status: HostStatusView;
  refresh: () => void;
} {
  const [status, setStatus] = useState<HostStatusView>({ kind: "checking" });
  const [revision, setRevision] = useState(0);
  const credentialKey = credential ? (credential.kind === "cookie" ? credential.csrfToken : credential.token) : "";

  useEffect(() => {
    if (!credential) {
      setStatus({ kind: "error", code: "UNAUTHORIZED", message: "this host is not paired in this browser" });
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
  }, [hostId, credentialKey, revision]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return { status, refresh };
}
