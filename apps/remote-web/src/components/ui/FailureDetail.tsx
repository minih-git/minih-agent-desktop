/**
 * The stored reason behind a failure, folded away behind a summary line.
 *
 * A failure card answers "what do I do next" — retry, switch model, free some
 * context. It deliberately does not answer "what went wrong", because the answer
 * is a technical sentence a reader does not want in front of them. Keeping it one
 * tap away is what makes a phone-only failure diagnosable: the attempt already
 * stores a reason with the key and the request payload stripped, so nothing here
 * needs a remote session or a debug build.
 */
import { useTranslation } from "react-i18next";

export interface FailureDetailProps {
  /** A reason safe to show, or null when the attempt recorded none. */
  reason: string | null;
  className?: string;
}

export function FailureDetail({ reason, className = "" }: FailureDetailProps) {
  const { t } = useTranslation();
  if (!reason) return null;
  return (
    <details className={`mt-1.5 min-w-0 ${className}`}>
      <summary className="cursor-pointer list-none text-[11px] leading-[15px] text-[var(--rm-text-muted)] underline decoration-dotted underline-offset-2 [&::-webkit-details-marker]:hidden">
        {t("directChat.failureDetail")}
      </summary>
      <p className="mt-1 break-words font-mono text-[11px] leading-[15px] text-[var(--rm-text-muted)]">
        {reason}
      </p>
    </details>
  );
}