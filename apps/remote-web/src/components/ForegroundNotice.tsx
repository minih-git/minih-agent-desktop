/**
 * A notification that arrives while the app is open (spec §17.6.4).
 *
 * The iOS plugin's `willPresent` returns no presentation options when the build
 * configures none, so the system shows nothing in the foreground; without this
 * the user would simply never learn that a run finished behind their back. The
 * bar is not a system banner on purpose: the user is already looking at the
 * screen the notification is about, and a banner over it would hide the thing
 * they are reading.
 *
 * Attention notices stay until they are opened or dismissed — they are the reason
 * the phone spoke. Outcome notices leave on their own.
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, CircleHelp, Shield, X } from "lucide-react";

export type ForegroundNotice = {
  /** One of `RACP_NOTIFY_KINDS`. */
  kind: string;
  hostId: string;
  sessionId: string;
};

const ATTENTION_KINDS = ["approval.requested", "input.requested"];

export function isAttentionNotice(kind: string): boolean {
  return ATTENTION_KINDS.includes(kind);
}

/** How long an outcome notice stays before it leaves by itself. */
export const OUTCOME_NOTICE_MS = 6000;

export interface ForegroundNoticeBarProps {
  notice: ForegroundNotice;
  onOpen: () => void;
  onDismiss: () => void;
}

export function ForegroundNoticeBar({ notice, onOpen, onDismiss }: ForegroundNoticeBarProps) {
  const { t } = useTranslation();
  const attention = isAttentionNotice(notice.kind);

  useEffect(() => {
    if (attention) return undefined;
    const timer = setTimeout(onDismiss, OUTCOME_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [attention, notice.kind, onDismiss]);

  const glyph =
    notice.kind === "turn.completed" ? (
      <Check className="h-[15px] w-[15px] text-[var(--rm-success)]" strokeWidth={3} aria-hidden="true" />
    ) : notice.kind === "turn.failed" ? (
      <AlertCircle className="h-5 w-5 text-[var(--rm-error)]" strokeWidth={2.2} aria-hidden="true" />
    ) : notice.kind === "input.requested" ? (
      <CircleHelp className="h-5 w-5 text-[var(--rm-decision)]" strokeWidth={2.2} aria-hidden="true" />
    ) : (
      <Shield className="h-5 w-5 text-[var(--rm-decision)]" strokeWidth={2.2} aria-hidden="true" />
    );

  return (
    <div
      role="status"
      aria-live="polite"
      className="rm-nav absolute left-3 right-3 top-[calc(env(safe-area-inset-top,0px)+52px)] z-40 flex items-center gap-2.5 rounded-[14px] bg-[var(--rm-bg-raised)] px-3 py-2.5 shadow-[0_0_0_1px_var(--rm-separator),0_8px_24px_rgba(0,0,0,0.08)]"
    >
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center">{glyph}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold leading-[19px] text-[var(--rm-text-primary)]">
          {t(`push.notify.${notice.kind}.title`)}
        </div>
        {/* The payload carries no sentence and no title (§11.6), so the body is
            the kind's own line. Resolving a session title here would need a read
            this bar is not worth; the tap opens the session, which is where the
            title is. */}
        <div className="truncate text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
          {t(`push.notify.${notice.kind}.body`)}
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="flex h-11 shrink-0 items-center rounded-[10px] px-3 text-[14px] font-semibold text-[var(--rm-text-primary)] active:opacity-60"
      >
        {t("notice.open")}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("common.close")}
        className="flex h-11 w-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--rm-text-secondary)] active:opacity-60"
      >
        <X className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}
