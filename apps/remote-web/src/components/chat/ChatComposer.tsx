import { ArrowUp, Clock, Loader2 } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TurnAttempt } from "../../hooks/useSessionScreen.js";
import { createIdempotencyKey, createRequestId } from "../../lib/ids.js";

export interface ChatComposerProps {
  sending: boolean;
  disabled: boolean;
  archived: boolean;
  queued: boolean;
  onSend: (attempt: TurnAttempt) => Promise<boolean>;
}

export function ChatComposer({
  sending,
  disabled,
  archived,
  queued,
  onSend,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [retrying, setRetrying] = useState(false);
  const attemptRef = useRef<TurnAttempt | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize textarea between 1 and 6 lines (approx 32px to 144px)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 32), 144);
    el.style.height = `${nextHeight}px`;
  }, [text]);

  if (archived) {
    return (
      <div className="py-3 text-center text-[14px] text-[var(--rm-text-muted)]">
        {t("session.archived")}
      </div>
    );
  }

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;

    const attempt =
      attemptRef.current?.text === trimmed
        ? attemptRef.current
        : {
            text: trimmed,
            idempotencyKey: createIdempotencyKey(),
            requestId: createRequestId(),
          };
    attemptRef.current = attempt;

    const sent = await onSend(attempt);
    if (sent) {
      attemptRef.current = null;
      setRetrying(false);
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "32px";
      }
      return;
    }
    setRetrying(true);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const isBlank = text.trim().length === 0;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 w-full">
      {/* Hint above composer */}
      {retrying ? (
        <div className="flex items-center gap-1.5 px-2 text-[12px] text-[var(--rm-error)]">
          <span>{t("composer.retryHint")}</span>
        </div>
      ) : queued && !isBlank ? (
        <div className="flex items-center gap-1.5 px-2 text-[12px] text-[var(--rm-text-muted)]">
          <Clock size={13} />
          <span>{t("composer.queueHint")}</span>
        </div>
      ) : null}

      {/* Pill field */}
      <div className="flex items-end gap-2 rounded-[22px] border border-[var(--rm-separator)] bg-[var(--rm-bg-surface)] p-1.5 pl-4 transition-colors focus-within:border-[var(--rm-accent)]">
        <textarea
          ref={textareaRef}
          value={text}
          disabled={disabled}
          rows={1}
          placeholder={t("composer.placeholder")}
          aria-label={t("composer.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 resize-none bg-transparent py-1 text-[16px] leading-[24px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none min-h-[32px] max-h-[144px]"
        />
        <button
          type="submit"
          disabled={disabled || sending || isBlank}
          aria-label={t("composer.send")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--rm-accent)] text-[var(--rm-on-accent)] transition-opacity disabled:opacity-25 cursor-pointer disabled:cursor-default"
        >
          {sending ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <ArrowUp size={20} strokeWidth={2.4} />
          )}
          <span className="sr-only">
            {sending ? t("composer.sending") : t("composer.send")}
          </span>
        </button>
      </div>
    </form>
  );
}
