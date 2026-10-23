import { ChevronRight, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";

import { relativeTimeText } from "../../lib/session-format.js";
import type { ProjectSummary } from "../../lib/session-groups.js";
import { SessionStatusPill } from "../ui/StatusMark.js";

export interface ProjectCardProps {
  summary: ProjectSummary;
  onOpen: () => void;
}

/**
 * One project, as S5 shows it (spec §17.2).
 *
 * Two facts, not six: how many sessions need the user, and how many are running.
 * A third count would read as noise, and the settled ones are one tap away.
 *
 * A project with something waiting gets a 3 px rail on its left edge — a second
 * cue beside the pill, never the only one.
 */
export function ProjectCard({ summary, onOpen }: ProjectCardProps) {
  const { t } = useTranslation();
  const label = summary.label ?? t("sessions.otherGroup");
  const attention = summary.waiting > 0;
  const when = summary.lastActivity
    ? relativeTimeText(summary.lastActivity, {
        justNow: t("common.justNow"),
        yesterday: t("common.yesterday"),
      })
    : "";

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative w-full overflow-hidden rounded-[20px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] px-4 py-3.5 text-left shadow-[var(--rm-shadow)] backdrop-blur-md transition-[transform,background-color] duration-150 active:scale-[0.985] active:bg-[var(--rm-bg-surface-2)] ${
        attention ? "pl-[19px]" : ""
      }`}
    >
      {attention ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 h-full w-[3px] bg-[var(--rm-decision)]"
        />
      ) : null}

      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[var(--rm-bg-surface-2)] text-[var(--rm-accent-2)]"
        >
          <Folder className="h-4 w-4 stroke-[2]" />
        </span>
        <span className="min-w-0 truncate text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
          {label}
        </span>
        <span className="shrink-0 text-[12px] leading-4 text-[var(--rm-text-muted)]">
          {summary.total === 0
            ? t("projects.noSessions")
            : t("projects.sessionCount", { count: summary.total })}
        </span>
        <span className="ml-auto flex shrink-0 items-center text-[var(--rm-text-faint)]">
          <ChevronRight className="h-4 w-4 stroke-2" aria-hidden="true" />
        </span>
      </span>

      <span className="mt-2 flex min-w-0 items-center gap-1.5">
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
      </span>
    </button>
  );
}
