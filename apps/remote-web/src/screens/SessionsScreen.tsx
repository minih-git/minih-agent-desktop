/**
 * Sessions of one host (PR-4).
 *
 * The list comes from `session/list`; the running state is the Host's own
 * `RacpSession.status`. Creating a session is out of scope: the desktop owns
 * session creation.
 */
import type { RacpSession } from "@minih-agent/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppShell, Button, Card, FailureBanner, Pill } from "../components/Chrome.js";
import { useHostStatus } from "../hooks/useHostStatus.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, type HostClient } from "../lib/host-client.js";
import { listSessions } from "../lib/mutations.js";
import { gatewayOrigin } from "../lib/runtime.js";

function statusTone(status: RacpSession["status"]): "ok" | "warn" | "bad" | "neutral" {
  if (status === "running") return "ok";
  if (status === "waiting_permission") return "warn";
  if (status === "error") return "bad";
  return "neutral";
}

export function SessionsScreen({
  hostId,
  hostLabel,
  credential,
  onOpenSession,
  onBack,
}: {
  hostId: string;
  hostLabel: string;
  credential: HostCredential;
  onOpenSession: (session: RacpSession) => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  const [failure, setFailure] = useState<OperationFailure | null>(null);
  const clientRef = useRef<HostClient | null>(null);
  const credentialKey = credential.kind === "cookie" ? credential.csrfToken : credential.token;
  const { status } = useHostStatus(hostId, credential);

  useEffect(() => {
    const client = createHostClient({
      gatewayOrigin,
      hostId,
      credential,
      onEvent: () => undefined,
      log: (level, message, data) => console.warn(`[remote-web] ${message}`, data ?? {}),
    });
    clientRef.current = client;
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [hostId, credentialKey]);

  const load = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const result = await listSessions(client);
    if (result.ok) {
      setSessions(result.value);
      setFailure(null);
      return;
    }
    setFailure(result.failure);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell
      title={hostLabel}
      onBack={onBack}
      actions={
        <>
          <Pill tone={status.kind === "online" ? "ok" : status.kind === "revoked" ? "bad" : "warn"}>
            {t(`hosts.status.${status.kind}`)}
          </Pill>
          <Button variant="ghost" aria-label={t("common.refresh")} title={t("common.refresh")} onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </>
      }
    >
      {failure ? <FailureBanner failure={failure} operationKey="operation.sessionList" onDismiss={() => setFailure(null)} /> : null}
      <h2 className="text-sm font-semibold">{t("sessions.title")}</h2>
      {sessions === null ? (
        <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">{t("app.loading")}</p>
      ) : sessions.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">{t("sessions.empty")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className="app-tap w-full rounded-xl border border-slate-200 bg-white p-3 text-left hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"
                aria-label={`${session.title || session.id}`}
                onClick={() => onOpenSession(session)}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{session.title || session.id}</span>
                  <Pill tone={statusTone(session.status)}>{t(`sessions.status.${session.status}`)}</Pill>
                </span>
                <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                  {t("sessions.updated", { date: new Date(session.updatedAt).toLocaleString(i18n.language) })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
