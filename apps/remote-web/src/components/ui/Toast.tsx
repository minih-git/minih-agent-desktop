/**
 * Top glass toast (ADR mobile-redesign D4).
 *
 * Anchored below the status-bar / top safe-area inset so transient confirmations
 * never collide with the bottom tab bar or composer dock.
 */
import { useEffect, type ReactNode } from "react";

export interface ToastProps {
  message: ReactNode;
  visible: boolean;
  onDismiss?: () => void;
  duration?: number;
  className?: string;
}

export function Toast({
  message,
  visible,
  onDismiss,
  duration = 2500,
  className = "",
}: ToastProps) {
  useEffect(() => {
    if (!visible || !onDismiss) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [visible, onDismiss, duration]);

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[95] flex justify-center px-4 pt-[max(14px,calc(env(safe-area-inset-top)+8px))]">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex max-w-full items-center gap-2 rounded-[var(--rm-radius-group,18px)] border border-[var(--rm-hair)] bg-[var(--rm-glass-strong)] px-4 py-2.5 text-[14px] font-semibold text-[var(--rm-text-primary)] shadow-[var(--rm-shadow)] backdrop-blur-[20px] backdrop-saturate-[1.8] animate-[rm-toast-in_0.5s_var(--rm-ease-spring)] ${className}`}
      >
        <i
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-[image:var(--rm-aurora)]"
        />
        <span className="truncate">{message}</span>
      </div>
    </div>
  );
}
