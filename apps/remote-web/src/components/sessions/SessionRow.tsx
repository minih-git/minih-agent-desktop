import type { RacpSession } from "@minih-agent/shared";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StatusDot, type StatusType } from "../ui/StatusDot.js";
import { formatRelativeTime } from "../../lib/session-format.js";

export interface SessionRowProps {
  session: RacpSession;
  onOpen: () => void;
}

export function SessionRow({ session, onOpen }: SessionRowProps) {
  const { t } = useTranslation();

  let dotStatus: StatusType = "muted";
  let statusWord = "";

  if (session.status === "running") {
    dotStatus = "running";
    statusWord = t("sessions.status.running");
  } else if (session.status === "waiting_permission") {
    dotStatus = "decision";
    statusWord = t("sessions.status.waiting_permission");
  } else if (session.status === "error") {
    dotStatus = "error";
    statusWord = t("sessions.status.error");
  }

  const rawRel = formatRelativeTime(session.updatedAt);
  const timeText =
    rawRel === "justNow"
      ? t("common.justNow")
      : rawRel === "yesterday"
        ? t("common.yesterday")
        : rawRel;

  const title = session.title || t("session.untitled");

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-h-[56px] items-center gap-3 px-4 py-3 text-left transition-colors active:bg-[var(--rm-bg-inset)]"
      aria-label={title}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center">
        {dotStatus !== "muted" ? (
          <StatusDot status={dotStatus} size="small" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--rm-text-faint)]" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={`truncate text-[15px] font-semibold leading-[20px] ${session.title ? "text-[var(--rm-text-primary)]" : "text-[var(--rm-text-secondary)]"}`}>
          {title}
        </div>
        <div className="flex items-center gap-1.5 truncate text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
          <span>{timeText}</span>
          {statusWord ? (
            <>
              <span>·</span>
              <span
                className={
                  dotStatus === "decision"
                    ? "font-medium text-[var(--rm-decision)]"
                    : dotStatus === "running"
                      ? "font-medium text-[var(--rm-running)]"
                      : dotStatus === "error"
                        ? "font-medium text-[var(--rm-error)]"
                        : ""
                }
              >
                {statusWord}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex items-center pr-1 text-[var(--rm-text-muted)]">
        <ChevronRight className="h-4 w-4 stroke-[2]" aria-hidden="true" />
      </div>
    </button>
  );
}
