import { useEffect, type ReactNode } from "react";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  className = "",
}: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* Scrim */}
      <div
        className="fixed inset-0 bg-[var(--rm-scrim)] backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        role="dialog"
        aria-modal="true"
        className={`rm-dock relative z-10 mx-auto flex max-h-[90dvh] w-full max-w-[640px] flex-col rounded-t-[20px] bg-[var(--rm-bg-raised)] p-4 text-[var(--rm-text-primary)] shadow-2xl animate-[rm-rise_0.25s_cubic-bezier(0.2,0,0,1)] ${className}`}
      >
        <div className="mx-auto mb-3 mt-1 h-1 w-9 rounded-full bg-[var(--rm-separator)] opacity-60" />

        {title ? (
          <h2 className="text-center text-[17px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
            {title}
          </h2>
        ) : null}
        {description ? (
          <p className="mt-1 text-center text-[14px] leading-[20px] text-[var(--rm-text-secondary)]">
            {description}
          </p>
        ) : null}

        <div className="mt-3 flex flex-col gap-2 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
