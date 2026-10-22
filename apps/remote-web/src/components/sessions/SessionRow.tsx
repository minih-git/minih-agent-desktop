import type { RacpSession } from "@minih-agent/shared";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SessionStatusGlyph, SessionStatusPill, SessionStatusWord } from "../ui/StatusMark.js";
import { relativeTimeText } from "../../lib/session-format.js";
import type { SessionStateView } from "../../lib/session-state.js";

export interface SessionRowProps {
  session: RacpSession;
  /** What §17.4 says this session is, decided by the screen (it knows the local view). */
  view: SessionStateView;
  /**
   * How many sessions in this list share the waiting state. More than one turns
   * the pill into "3 waiting for approval", which is the count a project card
   * shows above the same list.
   */
  waitingCount?: number;
  onOpen: () => void;
}

/**
 * One session, as S5b lists it.
 *
 * Order of the subtitle is deliberate: time, then state, then model. The model
 * truncates first because it is the least important fact on the line, and the
 * state gets a pill rather than a coloured word when the user has to act.
 */
export function SessionRow({ session, view, waitingCount, onOpen }: SessionRowProps) {
  const { t } = useTranslation();

  const timeText = relativeTimeText(session.updatedAt, {
    justNow: t("common.justNow"),
    yesterday: t("common.yesterday"),
  });

  const title = session.title || t("session.untitled");
  const attention = view === "approval" || view === "input";
  const model = session.modelLabel ?? "";
  const stopped = session.status === "aborted" && view === "idle";
  const stateWord = attention
    ? t(view === "approval" ? "sessions.status.waiting_permission" : "sessions.status.waiting_input")
    : stopped
      ? t("sessions.status.aborted")
      : "";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-[64px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors active:bg-[var(--rm-bg-inset)]"
      aria-label={stateWord ? `${title}, ${stateWord}` : title}
    >
      <SessionStatusGlyph view={view} className="shrink-0" />

      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-[15px] font-semibold leading-5 ${
            session.title ? "text-[var(--rm-text-primary)]" : "text-[var(--rm-text-secondary)]"
          }`}
        >
          {title}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
          <span className="shrink-0">{timeText}</span>
          {attention ? (
            <SessionStatusPill view={view} {...(waitingCount ? { count: waitingCount } : {})} />
          ) : (
            <>
              {stopped ? <SessionStatusWord view={view} /> : null}
              {stopped ? <span className="shrink-0">{t("sessions.status.aborted")}</span> : null}
              {!stopped && (view === "running" || view === "error" || view === "unseen") ? (
                <>
                  <span className="shrink-0">·</span>
                  <SessionStatusWord view={view} />
                </>
              ) : null}
            </>
          )}
          {model ? (
            <>
              <span className="shrink-0">·</span>
              <span className="truncate text-[var(--rm-text-muted)]">{model}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center pr-1 text-[var(--rm-text-faint)]">
        <ChevronRight className="h-4 w-4 stroke-2" aria-hidden="true" />
      </div>
    </button>
  );
}
