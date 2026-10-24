import { ArrowUp, Clock, Loader2, Paperclip, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { submitsOnEnter, type ComposerSend } from "../../lib/composer-send.js";
import {
  attemptSignature,
  attachmentPayload,
  canAddAttachment,
  type AttachmentRejection,
  type PendingAttachment,
  prepareAttachment,
} from "../../lib/composer-attachments.js";
import { createIdempotencyKey, createRequestId } from "../../lib/ids.js";

export interface ChatComposerProps {
  sending: boolean;
  disabled: boolean;
  archived: boolean;
  queued: boolean;
  /**
   * Direct chat hides attachments (`ADR` §5): the model gateway path has no
   * attachment upload, and showing a control that cannot work would be worse
   * than not showing it.
   */
  hideAttachments?: boolean;
  /** The initial text, so a stored draft reopens where the user left it. */
  initialText?: string;
  /**
   * Called as the text changes. A container that keeps a draft uses it; a
   * container that does not (the remote session) leaves it out.
   */
  onDraftChange?: (text: string) => void;
  onSend: (attempt: ComposerSend) => Promise<boolean>;
  placeholder?: string;
}

/**
 * Shrink a picture until it fits the inline budget.
 *
 * Longest edge first, then quality, then edge again — the order that keeps text
 * legible longest, because a screenshot is mostly thin glyphs. `createImageBitmap`
 * and `canvas` are the browser's own decoders, so this handles whatever the phone
 * produced without shipping an image library.
 */
async function downscaleImage(bytes: Uint8Array, mimeType: string): Promise<{ bytes: Uint8Array } | null> {
  if (typeof createImageBitmap !== "function") return null;
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const ladder = [
      { edge: 1440, quality: 0.82 },
      { edge: 1280, quality: 0.78 },
      { edge: 1080, quality: 0.72 },
      { edge: 900, quality: 0.66 },
      { edge: 720, quality: 0.6 },
      { edge: 560, quality: 0.55 },
    ];
    for (const step of ladder) {
      const scale = Math.min(1, step.edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", step.quality));
      if (!encoded) continue;
      const shrunk = new Uint8Array(await encoded.arrayBuffer());
      if (shrunk.byteLength <= 160 * 1024) return { bytes: shrunk };
    }
    return null;
  } finally {
    bitmap.close();
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

export function ChatComposer({
  sending,
  disabled,
  archived,
  queued,
  hideAttachments = false,
  initialText = "",
  placeholder,
  onDraftChange,
  onSend,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [rejection, setRejection] = useState<AttachmentRejection | null>(null);
  const attemptRef = useRef<ComposerSend | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // One line is 40px — a 24px line box plus `py-2` above and below — so the
  // field is exactly as tall as the 40px send button. The pill aligns its
  // children to the bottom (`items-end`), and a 32px field therefore left 8px
  // of empty space above the text and nothing below: the input looked like it
  // hung low instead of sitting in the middle. Six lines (160px) is the cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 40), 160);
    el.style.height = `${nextHeight}px`;
  }, [text]);

  if (archived) {
    return (
      <div className="py-3 text-center text-[14px] text-[var(--rm-text-muted)]">
        {t("session.archived")}
      </div>
    );
  }

  const rejectionText = (reason: AttachmentRejection): string =>
    reason === "too-many"
      ? t("composer.attachmentLimit", { count: 6 })
      : reason === "unsupported"
        ? t("composer.attachmentUnsupported")
        : t("composer.attachmentTooLarge");

  const addFiles = async (files: readonly File[]): Promise<void> => {
    setRejection(null);
    let next = [...attachments];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const prepared = await prepareAttachment(
        { name: file.name || "attachment", bytes, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
        downscaleImage,
      );
      if (!prepared.ok) {
        setRejection(prepared.reason);
        continue;
      }
      const allowed = canAddAttachment(next, prepared.attachment);
      if (!allowed.ok) {
        setRejection(allowed.reason);
        continue;
      }
      next = [...next, prepared.attachment];
    }
    setAttachments(next);
  };

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    // A picture on its own is a message ("what is this?"), so the text may be empty
    // when something is attached.
    if ((!trimmed && attachments.length === 0) || sending || disabled) return;

    const payload = attachmentPayload(attachments);
    const signature = attemptSignature(trimmed, payload);
    const attempt =
      attemptRef.current && attemptSignature(attemptRef.current.text, attemptRef.current.attachments ?? []) === signature
        ? attemptRef.current
        : {
            text: trimmed,
            ...(payload.length > 0 ? { attachments: payload } : {}),
            idempotencyKey: createIdempotencyKey(),
            requestId: createRequestId(),
          };
    attemptRef.current = attempt;
    const sent = await onSend(attempt);
    if (sent) {
      attemptRef.current = null;
      setText("");
      setAttachments([]);
      setRejection(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "40px";
      }
      return;
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME owns Enter while it is composing: it commits the candidate, and
    // sending here would post half-typed text.
    if (
      !submitsOnEnter({
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.keyCode,
      })
    ) {
      return;
    }
    e.preventDefault();
    void submit();
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const handleFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Clearing the input lets the same file be picked again after a removal.
    e.target.value = "";
    if (files.length > 0) void addFiles(files);
  };

  const isBlank = text.trim().length === 0 && attachments.length === 0;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 w-full">
      {/* Hint above composer */}
      {rejection ? (
        <div className="flex items-center gap-1.5 px-2 text-[12px] text-[var(--rm-error)]">
          <span>{rejectionText(rejection)}</span>
        </div>
      ) : queued && !isBlank ? (
        <div className="flex items-center gap-1.5 px-2 text-[12px] text-[var(--rm-text-muted)]">
          <Clock size={13} />
          <span>{t("composer.queueHint")}</span>
        </div>
      ) : null}

      {/* Chips: what this message will carry */}
      {attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 px-2" aria-label={t("composer.attachments")}>
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex max-w-full items-center gap-1.5 rounded-full bg-[var(--rm-bg-inset)] py-1 pl-1 pr-1.5">
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded-full object-cover"
                />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--rm-bg-surface)] text-[10px] text-[var(--rm-text-muted)]">
                  {attachment.name.split(".").at(-1)?.slice(0, 3).toUpperCase() ?? "FILE"}
                </span>
              )}
              <span className="min-w-0 truncate text-[12px] text-[var(--rm-text-secondary)]">{attachment.name}</span>
              <span className="shrink-0 text-[11px] text-[var(--rm-text-faint)]">{formatSize(attachment.size)}</span>
              <button
                type="button"
                onClick={() => {
                  setRejection(null);
                  setAttachments((current) => current.filter((entry) => entry.id !== attachment.id));
                }}
                aria-label={t("composer.removeAttachment", { name: attachment.name })}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--rm-text-muted)] active:opacity-60"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Pill field */}
      <div className="flex items-end gap-1.5 rounded-[26px] border border-[var(--rm-hair)] bg-[var(--rm-glass-strong)] p-1.5 pl-2 shadow-[var(--rm-shadow)] backdrop-blur-[22px] transition-colors focus-within:border-[var(--rm-accent)]">
        {hideAttachments ? null : (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,text/*,application/json,.md,.txt,.ts,.tsx,.js,.jsx,.py,.go,.rs,.json,.yaml,.yml,.toml,.css,.html,.sh,.log,.csv"
              onChange={handleFiles}
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
              aria-label={t("composer.attach")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--rm-text-muted)] transition-opacity disabled:opacity-25 active:opacity-60"
            >
              <Paperclip size={18} />
            </button>
          </>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          disabled={disabled}
          rows={1}
          placeholder={placeholder ?? t("composer.placeholder")}
          aria-label={placeholder ?? t("composer.placeholder")}
          onChange={(e) => {
            setText(e.target.value);
            onDraftChange?.(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          className="flex-1 resize-none bg-transparent py-2 text-[16px] leading-[24px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none min-h-[40px] max-h-[160px]"
        />
        <button
          type="submit"
          disabled={disabled || sending || isBlank}
          aria-label={t("composer.send")}
          className="rm-send-btn flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[image:var(--rm-aurora)] text-white transition-opacity disabled:opacity-25 cursor-pointer disabled:cursor-default"
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