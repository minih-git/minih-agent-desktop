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
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex items-center gap-2 rounded-full bg-[var(--rm-bg-raised)] px-4 py-2 text-[14px] font-semibold text-[var(--rm-text-primary)] shadow-[0_4px_16px_rgba(0,0,0,0.18)] ring-1 ring-[var(--rm-separator)] animate-[rm-fade-down_0.2s_ease-out] ${className}`}
      >
        {message}
      </div>
    </div>
  );
}
