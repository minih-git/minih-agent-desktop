/**
 * Turn composer (PR-4).
 *
 * The idempotency key belongs to the user action, not to the request: it is
 * created when the message is first sent and reused while the same text is
 * retried, so a lost response cannot start the same turn twice.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TurnAttempt } from "../hooks/useSessionScreen.js";
import { createIdempotencyKey, createRequestId } from "../lib/ids.js";
import { Button } from "./Chrome.js";

export function Composer({
  sending,
  disabled,
  queued,
  onSend,
}: {
  sending: boolean;
  disabled: boolean;
  queued: boolean;
  onSend: (attempt: TurnAttempt) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [retrying, setRetrying] = useState(false);
  const attemptRef = useRef<TurnAttempt | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const attempt =
      attemptRef.current?.text === trimmed
        ? attemptRef.current
        : { text: trimmed, idempotencyKey: createIdempotencyKey(), requestId: createRequestId() };
    attemptRef.current = attempt;
    const sent = await onSend(attempt);
    if (sent) {
      attemptRef.current = null;
      setRetrying(false);
      setText("");
      return;
    }
    setRetrying(true);
  };

  return (
    <form
      className="app-safe-area sticky bottom-0 border-t border-slate-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        value={text}
        rows={2}
        disabled={disabled}
        aria-label={t("composer.placeholder")}
        placeholder={t("composer.placeholder")}
        onChange={(event) => setText(event.target.value)}
        className="w-full resize-none rounded-lg border border-slate-300 bg-white p-2 text-[16px] dark:border-slate-700 dark:bg-slate-950"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={disabled || sending || text.trim().length === 0}>
          {sending ? t("composer.sending") : t("composer.send")}
        </Button>
        {queued ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("composer.queueHint")}</p>
        ) : retrying ? (
          <p className="text-xs text-red-600 dark:text-red-300">{t("composer.retryHint")}</p>
        ) : null}
      </div>
    </form>
  );
}
