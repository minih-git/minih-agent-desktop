import type { RacpSession } from "@minih-agent/shared";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { HostCredential } from "../lib/credential-port.js";
import { probeHostWithSessions, type HostStatus } from "../lib/host-status.js";
import { gatewayOrigin } from "../lib/runtime.js";

export type HostStatusView = { kind: "checking" } | HostStatus;

/**
 * Probes one host on mount and on demand. The result is only ever a status:
 * the probe never throws, so a failing host shows as `error` with its reason.
 *
 * Because the probe already calls `GET /hosts/{hostId}/v1/sessions`, the online
 * response carries the computer's sessions for free, letting the host card show
 * how many sessions need the user or are running without a second round-trip.
 */
export function useHostStatus(hostId: string, credential: HostCredential | null): {
  status: HostStatusView;
  sessions: RacpSession[] | null;
  refresh: () => void;
} {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HostStatusView>({ kind: "checking" });
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  const [revision, setRevision] = useState(0);
  const credentialKey = credential ? (credential.kind === "cookie" ? credential.csrfToken : credential.token) : "";

  useEffect(() => {
    if (!credential) {
      setStatus({ kind: "error", code: "UNAUTHORIZED", message: t("hosts.notPaired") });
      setSessions(null);
      return;
    }
    let cancelled = false;
    setStatus({ kind: "checking" });
    void probeHostWithSessions({ gatewayOrigin, hostId, credential }).then((result) => {
      if (!cancelled) {
        setStatus(result.status);
        setSessions(result.sessions);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hostId, credentialKey, revision, t]);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return { status, sessions, refresh };
}
