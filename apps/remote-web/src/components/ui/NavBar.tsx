import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

export interface NavBarProps {
  title?: string;
  subtitle?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  scrolled?: boolean;
  largeTitle?: boolean;
  className?: string;
}

export function NavBar({
  title,
  subtitle,
  onBack,
  backLabel = "Back",
  leading,
  trailing,
  scrolled = false,
  largeTitle = false,
  className = "",
}: NavBarProps) {
  return (
    <header
      className={`rm-nav sticky top-0 z-20 flex-none bg-[var(--rm-navbg)] backdrop-blur-xl transition-[box-shadow,border-color] duration-200 ${
        scrolled ? "shadow-[0_1px_0_var(--rm-separator)]" : ""
      } ${className}`}
    >
      <div className="grid h-[44px] grid-cols-[96px_1fr_96px] items-center px-1">
        <div className="flex items-center">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label={backLabel}
              title={backLabel}
              className="flex h-[44px] w-[44px] items-center justify-center rounded-[10px] text-[var(--rm-text-primary)] transition-opacity active:opacity-60"
            >
              <ChevronLeft className="h-6 w-6 stroke-[2]" aria-hidden="true" />
            </button>
          ) : (
            leading
          )}
        </div>

        <div className="min-w-0 text-center">
          {title ? (
            <h1
              className={`truncate text-[17px] font-semibold leading-[22px] text-[var(--rm-text-primary)] transition-opacity duration-200 ${
                largeTitle && !scrolled ? "opacity-0" : "opacity-100"
              }`}
            >
              {title}
            </h1>
          ) : null}
          {subtitle ? (
            // One line, and the bar's own height is fixed: a subtitle wider than
            // the center column must shrink and clip rather than wrap, which
            // pushed the fixed-height bar out of shape (a long computer name).
            <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden text-[12px] leading-[15px] text-[var(--rm-text-muted)]">
              {subtitle}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-1">{trailing}</div>
      </div>
    </header>
  );
}
