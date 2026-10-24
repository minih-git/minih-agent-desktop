/**
 * A notification that arrives while the app is open (spec §17.6.4).
 *
 * The iOS plugin's `willPresent` returns no presentation options when the build
 * configures none, so the system shows nothing in the foreground; without this
 * the user would simply never learn that a run finished behind their back.
 *
 * It is a centred dialog rather than a bar under the navigation bar: the bar
 * stacked a safe-area inset on top of a fixed offset and left a blank block
 * above its own text, and being narrow it was easy to miss. The dialog is
 * rendered on `<body>`, so the page's own stacking context — and the tab bar in
 * front of it — cannot cover it.
 *
 * Attention notices stay until they are opened or dismissed — they are the
 * reason the phone spoke. Outcome notices leave on their own.
 */
import { AlertCircle, Check, CircleHelp, Shield, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { takeModalFocus } from "../lib/modal-focus.js";

import { Button } from "./ui/Button.js";

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

export interface ForegroundNoticeDialogProps {
  notice: ForegroundNotice;
  onOpen: () => void;
  onDismiss: () => void;
}

export function ForegroundNoticeDialog({ notice, onOpen, onDismiss }: ForegroundNoticeDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  const attention = isAttentionNotice(notice.kind);
  /**
   * The parent passes a new callback on every render, and it re-renders while a
   * run streams. Depending on it would clear and restart the timer each time,
   * so an outcome notice would never leave. The callback is read through a ref.
   */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  /**
   * Focus starts on the close control and goes back where it came from when the
   * notice leaves, so a keyboard user is never left at the top of the page.
   */
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return takeModalFocus(
      typeof document !== "undefined" ? document : null,
      closeRef.current,
      dialogRef.current,
    );
  }, []);

  useEffect(() => {
    if (attention) return undefined;
    const timer = setTimeout(() => dismissRef.current(), OUTCOME_NOTICE_MS);
    return () => clearTimeout(timer);
    // The ids belong in the dependency list: a second notice of the same kind
    // for another session is a different thing to read, and keeping the old
    // timer would close it early.
  }, [attention, notice.kind, notice.hostId, notice.sessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    // Escape dismisses, as it does every sheet (§7).
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const glyph =
    notice.kind === "turn.completed" ? (
      <Check className="h-[22px] w-[22px] text-[var(--rm-success)]" strokeWidth={3} aria-hidden="true" />
    ) : notice.kind === "turn.failed" ? (
      <AlertCircle className="h-6 w-6 text-[var(--rm-error)]" strokeWidth={2.2} aria-hidden="true" />
    ) : notice.kind === "input.requested" ? (
      <CircleHelp className="h-6 w-6 text-[var(--rm-decision)]" strokeWidth={2.2} aria-hidden="true" />
    ) : (
      <Shield className="h-6 w-6 text-[var(--rm-decision)]" strokeWidth={2.2} aria-hidden="true" />
    );

  const dialog = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-6">
      {/* Tapping outside is the same decision as the close button. */}
      <div
        className="absolute inset-0 bg-[rgba(0,0,0,0.42)] [animation:rm-scrim-in_0.2s_var(--rm-ease-out)]"
        onClick={onDismiss}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="relative z-10 w-full max-w-[340px] rounded-[24px] border border-[var(--rm-hair)] bg-[var(--rm-glass-strong)] px-5 pb-4 pt-6 text-center text-[var(--rm-text-primary)] shadow-[var(--rm-shadow)] backdrop-blur-[30px] backdrop-saturate-[1.8] [animation:rm-pop_0.3s_var(--rm-ease-spring)]"
      >
        {/* The tint is a wash, not a filled mark: §17.4 keeps the filled mark for
            the status pill, so the two never read as the same thing. */}
        <span
          aria-hidden="true"
          className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-[var(--rm-bg-surface-2)]"
        >
          {glyph}
        </span>
        <h2 id={titleId} className="text-[17px] font-bold leading-[23px] text-[var(--rm-text-primary)]">
          {t(`push.notify.${notice.kind}.title`)}
        </h2>
        {/* The payload carries no sentence and no title (§11.6), so the body is
            the kind's own line. Resolving a session title here would need a read
            this dialog is not worth; the button opens the session, which is
            where the title is. */}
        <p id={bodyId} className="mt-1 text-[13px] leading-[19px] text-[var(--rm-text-secondary)]">
          {t(`push.notify.${notice.kind}.body`)}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Button variant="primary" size="large" onClick={onOpen}>
            {t("notice.open")}
          </Button>
          <Button variant="secondary" size="large" onClick={onDismiss}>
            {t("common.close")}
          </Button>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-[var(--rm-text-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--rm-accent-1)] active:opacity-60"
        >
          <X className="h-4 w-4" strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  // On `<body>`, like the sheets: inside the page tree the root's transform and
  // the tab bar's paint order decide who is on top, and it was not this.
  // Server rendering (the tests) has no document and renders in place.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
