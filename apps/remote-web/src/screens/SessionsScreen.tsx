import type { RacpSession } from "@minih-agent/shared";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useHostStatus } from "../hooks/useHostStatus.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, type HostClient } from "../lib/host-client.js";
import { listSessions } from "../lib/mutations.js";
import { gatewayOrigin } from "../lib/runtime.js";
import { groupSessionsByDate } from "../lib/session-format.js";
import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import { SessionRow } from "../components/sessions/SessionRow.js";

export interface SessionsScreenProps {
  hostId: string;
  hostLabel: string;
  credential: HostCredential;
  onOpenSession: (session: RacpSession) => void;
  onBack: () => void;
}

export function SessionsScreen({
  hostId,
  hostLabel,
  credential,
  onOpenSession,
  onBack,
}: SessionsScreenProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  const [failure, setFailure] = useState<OperationFailure | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
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
    setIsRefreshing(true);
    const result = await listSessions(client);
    setIsRefreshing(false);
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

  // Foreground refresh
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [load]);

  const isOnline = status.kind === "online";
  const subStatus = (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--rm-text-secondary)]">
      <StatusDot status={isOnline ? "online" : "offline"} size="small" />
      <span>{isOnline ? t("hosts.status.online") : t("hosts.status.offline")}</span>
    </span>
  );

  const groups = sessions ? groupSessionsByDate(sessions) : [];

  return (
    <Screen>
      <NavBar
        title={hostLabel}
        subtitle={subStatus}
                onBack={onBack}
        trailing={
          <button
            type="button"
            onClick={() => void load()}
            disabled={isRefreshing}
            aria-label={t("common.refresh")}
            className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] active:opacity-60"
          >
            <RefreshCw
              className={`h-5 w-5 ${isRefreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </button>
        }
      />

      <ScreenContent>
        {failure ? (
          <div className="mb-4">
            <Banner
              tone="error"
              action={
                <Button variant="plain" size="small" onClick={() => void load()}>
                  {t("common.refresh")}
                </Button>
              }
            >
              {failure.message || t("operation.sessionList")}
            </Banner>
          </div>
        ) : null}

        {sessions === null ? (
          <div className="space-y-4">
            <SectionHeader title=" " />
            <ListGroup>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="flex min-h-[56px] items-center gap-3 px-4 py-3">
                  <Skeleton className="h-2 w-2 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/5" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </ListGroup>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            title={t("session.emptyTitle")}
            description={t("session.emptyDesc")}
          />
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.key}>
                <SectionHeader title={t(group.labelKey)} />
                <ListGroup>
                  {group.items.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      onOpen={() => onOpenSession(session)}
                    />
                  ))}
                </ListGroup>
              </div>
            ))}

            <p className="pt-2 text-center text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("session.computerNotice")}
            </p>
          </div>
        )}
      </ScreenContent>
    </Screen>
  );
}
