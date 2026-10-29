import type { RacpSession } from "@minih-agent/shared";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Laptop,
  Monitor,
  MoreHorizontal,
  Server,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useHostStatus } from "../../hooks/useHostStatus.js";
import {
  formatHostStatusHelp,
  formatHostStatusLine,
  hostDotStatus,
  hostStatusAction,
  type HostDisplayStatusKind,
} from "../../lib/host-display.js";
import type { HostRegistryEntry } from "../../lib/host-registry.js";
import { credentialPort } from "../../lib/runtime.js";
import { relativeTimeText } from "../../lib/session-format.js";
import { createSessionViews, needsUser, sessionStateOf } from "../../lib/session-state.js";
import { Button } from "../ui/Button.js";
import { StatusDot } from "../ui/StatusDot.js";
import { SessionStatusPill } from "../ui/StatusMark.js";

export interface HostRowProps {
  entry: HostRegistryEntry;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onOpen: () => void;
  onOpenMore: (statusKind: HostDisplayStatusKind, refresh: () => void) => void;
  onAskAgain: () => void;
  onForgetAndPair: () => void;
  /** Bumped by the list to re-probe this row without remounting it. */
  refreshSignal?: number;
}

const sessionViews =
  typeof window !== "undefined" && window.localStorage
    ? createSessionViews(window.localStorage)
    : null;

function summarizeHostSessions(hostId: string, sessions: readonly RacpSession[]) {
  let waiting = 0;
  let running = 0;
  let lastActivity: string | undefined;
  for (const session of sessions) {
    const view = sessionStateOf(session, sessionViews?.get(hostId, session.id));
    if (needsUser(view)) waiting += 1;
    else if (view === "running") running += 1;
    if (session.updatedAt && (!lastActivity || session.updatedAt > lastActivity)) {
      lastActivity = session.updatedAt;
    }
  }
  return { total: sessions.length, waiting, running, lastActivity };
}

function HostGlyph({ label }: { label: string }) {
  const lower = label.toLowerCase();
  if (lower.includes("server") || lower.includes("linux") || lower.includes("ubuntu")) {
    return <Server className="h-[22px] w-[22px]" aria-hidden="true" />;
  }
  if (
    lower.includes("win") ||
    lower.includes("desktop") ||
    lower.includes("pc") ||
    lower.includes("imac") ||
    lower.includes("studio")
  ) {
    return <Monitor className="h-[22px] w-[22px]" aria-hidden="true" />;
  }
  return <Laptop className="h-[22px] w-[22px]" aria-hidden="true" />;
}

export function HostRow({
  entry,
  isExpanded,
  onToggleExpand,
  onOpen,
  onOpenMore,
  onAskAgain,
  onForgetAndPair,
  refreshSignal = 0,
}: HostRowProps) {
  const { t } = useTranslation();
  const credential = credentialPort.credentialFor(entry.hostId);
  const { status, sessions, refresh } = useHostStatus(entry.hostId, credential, refreshSignal);

  const isOnline = status.kind === "online";
  const isDanger = status.kind === "revoked" || status.kind === "error";
  const dotStatus = hostDotStatus(status);
  const statusLine = formatHostStatusLine(status, t);
  const helpText = formatHostStatusHelp(status, entry, t);
  const action = hostStatusAction(status, entry);

  const summary =
    isOnline && sessions !== null ? summarizeHostSessions(entry.hostId, sessions) : null;
  const attention = (summary?.waiting ?? 0) > 0;
  const when = summary?.lastActivity
    ? relativeTimeText(summary.lastActivity, {
        justNow: t("common.justNow"),
        yesterday: t("common.yesterday"),
      })
    : "";

  const handleRowClick = () => {
    if (isOnline) {
      onOpen();
    } else {
      onToggleExpand();
    }
  };

  const handleFixAction = () => {
    if (action.action === "refresh") {
      void refresh();
    } else if (action.action === "askAgain") {
      onAskAgain();
    } else if (action.action === "forgetAndPair") {
      onForgetAndPair();
    }
  };

  return (
    <div className="relative overflow-hidden rounded-[22px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] shadow-[var(--rm-shadow)] backdrop-blur-md transition-colors">
      {attention ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 h-full w-[3px] bg-[var(--rm-decision)]"
        />
      ) : isDanger ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 h-full w-[3px] bg-[var(--rm-error)]"
        />
      ) : null}

      <div className={`p-4 ${attention || isDanger ? "pl-[19px]" : ""}`}>
        <div className="flex items-center gap-3.5">
          {/* Main tappable host card body */}
          <button
            type="button"
            onClick={handleRowClick}
            className="flex min-w-0 flex-1 items-center gap-3.5 text-left transition-transform duration-150 active:scale-[0.985]"
            aria-label={`${entry.label}, ${statusLine}`}
          >
            <span className="sr-only">{t("hosts.open")} </span>
            {/* OS / computer icon tile with status dot badge */}
            <div
              className={`relative grid h-[48px] w-[48px] shrink-0 place-items-center rounded-[15px] bg-[var(--rm-bg-surface-2)] ${
                isOnline ? "text-[var(--rm-text-primary)]" : "text-[var(--rm-text-muted)]"
              }`}
            >
              <HostGlyph label={entry.label} />
              <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--rm-bg-surface)]">
                <StatusDot status={dotStatus} size="small" />
              </span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[17px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
                  {entry.label}
                </span>
                {summary !== null ? (
                  <span className="shrink-0 text-[12px] leading-4 text-[var(--rm-text-muted)]">
                    {summary.total === 0
                      ? t("projects.noSessions")
                      : t("projects.sessionCount", { count: summary.total })}
                  </span>
                ) : null}
              </div>
              <div
                className={`mt-1 min-w-0 truncate text-[13px] leading-[18px] ${
                  status.kind === "revoked"
                    ? "font-medium text-[var(--rm-error)]"
                    : isOnline
                      ? "text-[var(--rm-text-secondary)]"
                      : "text-[var(--rm-text-muted)]"
                }`}
              >
                <span className="truncate">{statusLine}</span>
              </div>
            </div>

            {attention ? (
              <SessionStatusPill view="approval" count={summary?.waiting} />
            ) : (summary?.running ?? 0) > 0 ? (
              <SessionStatusPill view="running" count={summary?.running} />
            ) : null}

            <div className="flex shrink-0 items-center text-[var(--rm-text-faint)]">
              {isOnline ? (
                <ChevronRight className="h-4 w-4 stroke-[2]" aria-hidden="true" />
              ) : isExpanded ? (
                <ChevronUp className="h-4 w-4 stroke-[2]" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4 stroke-[2]" aria-hidden="true" />
              )}
            </div>
          </button>

          {/* Action sheet trigger */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMore(status.kind, refresh);
            }}
            aria-label={t("hosts.moreActions", { label: entry.label })}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--rm-text-muted)] transition-colors active:bg-[var(--rm-bg-surface-2)]"
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Card footer: activity status & timestamp when online */}
        {summary !== null && (!attention && summary.running === 0 || Boolean(when)) ? (
          <button
            type="button"
            onClick={handleRowClick}
            tabIndex={-1}
            className="mt-2.5 flex w-full min-w-0 items-center gap-1.5 border-t border-[var(--rm-hair)] pt-2.5 text-left active:opacity-75"
          >
            {!attention && summary.running === 0 ? (
              <span className="truncate text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                {summary.total === 0 ? t("projects.startHere") : t("projects.nothingWaiting")}
              </span>
            ) : null}
            {when ? (
              <span className="ml-auto shrink-0 text-[12px] leading-[16px] text-[var(--rm-text-muted)]">
                {t("sessions.updated", { date: when })}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>

      {/* Inline expansion for non-online states */}
      {!isOnline && isExpanded && helpText ? (
        <div className="border-t border-[var(--rm-hair)] bg-[var(--rm-bg-surface-2)] px-4 py-3">
          <p className="mb-3 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
            {helpText}
          </p>
          {action.action !== "none" ? (
            <Button
              variant={action.action === "forgetAndPair" ? "destructive" : "secondary"}
              size="small"
              onClick={handleFixAction}
            >
              {t(action.labelKey)}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
