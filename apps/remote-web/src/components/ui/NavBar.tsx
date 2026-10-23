/**
 * Glass navigation bar (ADR mobile-redesign D4, spec §6.2).
 *
 * Root and hero screens start with a transparent bar and transition to the
 * blurred glass surface once the sibling `<main>` scrolls past 12 px; detail
 * screens can also pass `solid` to keep the glass surface visible from the top.
 *
 * Supports a centred title, an optional single-line subtitle or interactive
 * model pill slot beneath the title, a leading back button or avatar action,
 * and trailing icon actions.
 */
import { ChevronDown, ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export interface AvatarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Initial or short monogram rendered inside the gradient circle. */
  initial?: string;
}

export function AvatarButton({
  initial = "M",
  className = "",
  ...rest
}: AvatarButtonProps) {
  return (
    <button
      type="button"
      className={`grid h-[44px] w-[44px] shrink-0 place-items-center rounded-[14px] text-[var(--rm-text-secondary)] outline-none transition-[transform,background-color] duration-150 ease-[var(--rm-ease-out)] active:scale-[0.88] active:bg-[var(--rm-bg-surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--rm-accent-1)] ${className}`}
      {...rest}
    >
      <span
        aria-hidden="true"
        className="grid h-[34px] w-[34px] place-items-center rounded-full bg-[image:var(--rm-aurora)] text-[14px] font-bold text-white shadow-[0_0_0_2px_var(--rm-bg-page),0_0_0_3.5px_rgba(124,92,255,0.5)]"
      >
        {initial}
      </span>
    </button>
  );
}

export interface ModelPillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: ReactNode;
}

export function ModelPill({ label, className = "", ...rest }: ModelPillProps) {
  return (
    <button
      type="button"
      className={`mt-1 inline-flex h-[28px] max-w-full items-center gap-1.5 rounded-[14px] border-[1.5px] border-transparent px-2.5 pl-2 text-[13px] font-semibold text-[var(--rm-text-primary)] outline-none [background:linear-gradient(var(--rm-bg-solid),var(--rm-bg-solid))_padding-box,var(--rm-aurora)_border-box] transition-transform duration-150 ease-[var(--rm-ease-out)] active:scale-[0.96] disabled:opacity-50 ${className}`}
      {...rest}
    >
      <i
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full bg-[image:var(--rm-aurora)]"
      />
      <span className="truncate">{label}</span>
      <ChevronDown
        className="h-3.5 w-3.5 shrink-0 text-[var(--rm-text-muted)]"
        strokeWidth={2.4}
        aria-hidden="true"
      />
    </button>
  );
}

export interface NavBarProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /**
   * Optional full-width row beneath the title's grid row, for a strip that
   * must not be squeezed into the narrow centre column (the session's status
   * chips). It wraps instead of clipping, so every item stays readable on a
   * 390 px phone.
   */
  strip?: ReactNode;
  /** Optional model chooser pill rendered beneath the title. */
  modelPill?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  /** Optional avatar action in the leading slot when `onBack` is not set. */
  onAvatarClick?: () => void;
  avatarLabel?: string;
  avatarInitial?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  scrolled?: boolean;
  /** Force the blurred glass surface on before scrolling (e.g. detail screens). */
  solid?: boolean;
  largeTitle?: boolean;
  className?: string;
}

export function NavBar({
  title,
  subtitle,
  strip,
  modelPill,
  onBack,
  backLabel = "Back",
  onAvatarClick,
  avatarLabel = "Settings",
  avatarInitial = "M",
  leading,
  trailing,
  scrolled,
  solid = false,
  largeTitle = false,
  className = "",
}: NavBarProps) {
  const headerRef = useRef<HTMLElement>(null);
  const [autoScrolled, setAutoScrolled] = useState(false);

  useEffect(() => {
    if (scrolled !== undefined || solid) return;
    const header = headerRef.current;
    const scroller = header?.parentElement?.querySelector("main");
    if (!scroller) return;
    const onScroll = () => {
      setAutoScrolled(scroller.scrollTop > 12);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [scrolled, solid]);

  const isScrolled = scrolled ?? autoScrolled;
  const isSolid = solid || isScrolled;

  return (
    <header
      ref={headerRef}
      data-solid={isSolid ? "true" : "false"}
      className={`rm-nav sticky top-0 z-20 flex-none border-b transition-[background-color,border-color,backdrop-filter,box-shadow] duration-250 ease-[var(--rm-ease-out)] ${
        isSolid
          ? "border-[var(--rm-hair)] bg-[var(--rm-glass)] backdrop-blur-[22px] backdrop-saturate-[1.6]"
          : "border-transparent bg-transparent"
      } ${className}`}
    >
      <div className="grid min-h-[44px] grid-cols-[96px_1fr_96px] items-center px-1.5 py-0.5">
        <div className="flex items-center">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label={backLabel}
              title={backLabel}
              className="grid h-[44px] w-[44px] place-items-center rounded-[14px] text-[var(--rm-text-secondary)] outline-none transition-[transform,background-color] duration-150 ease-[var(--rm-ease-out)] active:scale-[0.88] active:bg-[var(--rm-bg-surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--rm-accent-1)]"
            >
              <ChevronLeft className="h-[22px] w-[22px] stroke-[2.4]" aria-hidden="true" />
            </button>
          ) : onAvatarClick ? (
            <AvatarButton
              onClick={onAvatarClick}
              aria-label={avatarLabel}
              title={avatarLabel}
              initial={avatarInitial}
            />
          ) : (
            leading
          )}
        </div>

        <div className="min-w-0 text-center">
          {title ? (
            <h1
              className={`truncate text-[17px] font-semibold leading-[22px] text-[var(--rm-text-primary)] transition-opacity duration-200 ${
                largeTitle && !isSolid ? "opacity-0" : "opacity-100"
              }`}
            >
              {title}
            </h1>
          ) : null}
          {subtitle ? (
            // One line, and the bar's own height is fixed: a subtitle wider than
            // the center column must shrink and clip rather than wrap, which
            // pushed the fixed-height bar out of shape (a long computer name).
            <div className="flex min-w-0 items-center justify-center gap-1 overflow-hidden text-[12px] font-medium leading-[15px] text-[var(--rm-text-muted)]">
              {subtitle}
            </div>
          ) : null}
          {modelPill ? (
            <div className="flex min-w-0 items-center justify-center">{modelPill}</div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-1">{trailing}</div>
      </div>
      {strip ? (
        <div className="flex flex-wrap items-center justify-center gap-1.5 px-2 pb-1">{strip}</div>
      ) : null}
    </header>
  );
}
