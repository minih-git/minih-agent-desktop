import type { RacpSession } from "@minih-agent/shared";
import { ChevronDown, ChevronRight, ChevronUp, Laptop, MoreHorizontal } from "lucide-react";
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

export function HostRow({
  entry,
  isExpanded,
  onToggleExpand,
  onOpen,
  onOpenMore,
  onAskAgain,
  onForgetAndPair,
}: HostRowProps) {
  const { t } = useTranslation();
  const credential = credentialPort.credentialFor(entry.hostId);
  const { status, sessions, refresh } = useHostStatus(entry.hostId, credential);

  const isOnline = status.kind === "online";
  const isDanger = status.kind === "revoked" || status.kind === "error";
  const dotStatus = hostDotStatus(status);
  const statusLine = formatHostStatusLine(status, t);
  const helpText = formatHostStatusHelp(status, entry, t);
  const action = hostStatusAction(status, entry);

  const summary = isOnline && sessions !== null ? summarizeHostSessions(entry.hostId, sessions) : null;
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
    <div className="relative overflow-hidden rounded-2xl bg-[var(--rm-bg-surface)] shadow-[var(--rm-shadow)] ring-1 ring-[var(--rm-separator)] transition-colors">
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

      <div className={`px-4 py-3.5 ${attention || isDanger ? "pl-[19px]" : ""}`}>
        <div className="flex items-center gap-3">
          {/* Main tappable host card body */}
          <button
            type="button"
            onClick={handleRowClick}
            className="flex min-w-0 flex-1 items-center gap-3 text-left active:opacity-75"
            aria-label={`${entry.label}，${statusLine}`}
          >
            <span className="sr-only">Open </span>
            {/* Laptop icon tile with status dot badge */}
            <div
              className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--rm-bg-inset)] ${
                isOnline ? "text-[var(--rm-text-primary)]" : "text-[var(--rm-text-muted)]"
              }`}
            >
              <Laptop className="h-5 w-5" aria-hidden="true" />
              <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--rm-bg-surface)]">
                <StatusDot status={dotStatus} size="small" />
              </span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
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
                className={`mt-0.5 truncate text-[13px] leading-[18px] ${
                  status.kind === "revoked"
                    ? "font-medium text-[var(--rm-error)]"
                    : isOnline
                      ? "text-[var(--rm-success)]"
                      : "text-[var(--rm-text-secondary)]"
                }`}
              >
                {statusLine}
              </div>
            </div>

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
            aria-label={`${entry.label} 的更多操作`}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--rm-text-muted)] transition-colors active:bg-[var(--rm-bg-inset)]"
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Card footer: session status pills & activity timestamp when online */}
        {summary !== null ? (
          <button
            type="button"
            onClick={handleRowClick}
            tabIndex={-1}
            className="mt-2.5 flex w-full min-w-0 items-center gap-1.5 border-t border-[var(--rm-separator)] pt-2.5 text-left active:opacity-75"
          >
            {attention ? <SessionStatusPill view="approval" count={summary.waiting} /> : null}
            {summary.running > 0 ? <SessionStatusPill view="running" count={summary.running} /> : null}
            {!attention && summary.running === 0 ? (
              <span className="truncate text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                {summary.total === 0 ? t("projects.startHere") : t("projects.nothingWaiting")}
              </span>
            ) : null}
            {when ? (
              <span className="ml-auto shrink-0 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                {t("sessions.updated", { date: when })}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>

      {/* Inline expansion for non-online states */}
      {!isOnline && isExpanded && helpText ? (
        <div className="border-t border-[var(--rm-separator)] bg-[var(--rm-bg-inset)] px-4 py-3">
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
