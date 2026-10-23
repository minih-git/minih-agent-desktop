/**
 * Grouped glass list, rows, icon tiles, and swipe-action rows (ADR mobile-redesign D4).
 *
 * `ListGroup` renders a blurred glass container with 18 px radius and hairline
 * dividers. `ListRow` supports a leading slot (or icon tile), title, subtitle,
 * trailing value/control, chevron, and tactile press feedback. `SwipeRow` wraps
 * a row with horizontal pointer-drag reveal for trailing action buttons.
 */
import { ChevronRight } from "lucide-react";
import {
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

export interface ListGroupProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function ListGroup({ children, className = "", ...rest }: ListGroupProps) {
  return (
    <div
      className={`relative divide-y divide-[var(--rm-hair)] overflow-hidden rounded-[var(--rm-radius-group,18px)] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] backdrop-blur-md ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface ListRowProps {
  leading?: ReactNode;
  /** Optional icon automatically wrapped in an `IconTile` when `leading` is omitted. */
  leadingIcon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional right-aligned value label shown before `trailing` / `chevron`. */
  value?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  compact?: boolean;
  children?: ReactNode;
  badge?: ReactNode;
}

export function ListRow({
  leading,
  leadingIcon,
  title,
  subtitle,
  value,
  trailing,
  chevron = false,
  destructive = false,
  disabled = false,
  onClick,
  className = "",
  compact = false,
  children,
  badge,
}: ListRowProps) {
  const isInteractive = Boolean(onClick) && !disabled;
  const minHeight = compact ? "min-h-[52px]" : "min-h-[56px]";
  const resolvedLeading =
    leading ?? (leadingIcon ? <IconTile badge={badge}>{leadingIcon}</IconTile> : null);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-disabled={disabled || undefined}
      className={`relative flex w-full items-center gap-3 px-4 py-3 text-left select-none outline-none ${minHeight} ${
        isInteractive
          ? "cursor-pointer transition-[transform,background-color] duration-[180ms] ease-[var(--rm-ease-out)] active:scale-[0.985] active:bg-[var(--rm-bg-surface-2)] focus-visible:bg-[var(--rm-bg-surface-2)]"
          : ""
      } ${disabled ? "opacity-50" : ""} ${className}`}
      onClick={isInteractive ? onClick : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
    >
      {resolvedLeading ? (
        <div className="flex shrink-0 items-center justify-center">{resolvedLeading}</div>
      ) : null}

      <div className="min-w-0 flex-1">
        <div
          className={`text-[16px] font-semibold leading-[22px] ${
            destructive ? "text-[var(--rm-error)]" : "text-[var(--rm-text-primary)]"
          }`}
        >
          {title}
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[13px] leading-[19px] text-[var(--rm-text-muted)]">
            {subtitle}
          </div>
        ) : null}
        {children}
      </div>

      {(value !== undefined || trailing || chevron) && (
        <div className="flex shrink-0 items-center gap-1.5 text-[13px] text-[var(--rm-text-muted)]">
          {value !== undefined ? <span className="text-right">{value}</span> : null}
          {trailing}
          {chevron ? (
            <ChevronRight
              className="h-4 w-4 text-[var(--rm-text-faint)] stroke-[2.2]"
              aria-hidden="true"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

export interface IconTileProps extends HTMLAttributes<HTMLDivElement> {
  badge?: ReactNode;
  children: ReactNode;
}

export function IconTile({ badge, children, className = "", ...rest }: IconTileProps) {
  return (
    <div
      className={`relative grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] bg-[var(--rm-bg-surface-2)] text-[var(--rm-text-secondary)] ${className}`}
      {...rest}
    >
      {children}
      {badge ? (
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--rm-bg-solid)]">
          {badge}
        </span>
      ) : null}
    </div>
  );
}

export interface SwipeAction {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  tone?: "pin" | "archive" | "danger" | "neutral";
  onClick: () => void;
}

export interface SwipeRowProps extends HTMLAttributes<HTMLDivElement> {
  actions: readonly SwipeAction[];
  actionWidth?: number;
  children?: ReactNode;
}

const SWIPE_TONE_CLASSES: Record<NonNullable<SwipeAction["tone"]>, string> = {
  pin: "bg-[#6366f1] text-white",
  archive: "bg-[#f59e0b] text-white",
  danger: "bg-[#ef4444] text-white",
  neutral: "bg-[var(--rm-bg-surface-2)] text-[var(--rm-text-primary)]",
};

/**
 * Horizontal swipe-to-reveal row actions (ADR mobile-redesign D4).
 *
 * Uses pointer events + CSS transform so swiping left reveals trailing actions
 * without blocking vertical list scrolling (`touch-action: pan-y`).
 */
export function SwipeRow({
  actions,
  actionWidth = 72,
  children,
  className = "",
  ...rest
}: SwipeRowProps) {
  const maxReveal = actions.length * actionWidth;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef<number | null>(null);
  const baseOffsetRef = useRef(0);
  const swipedRef = useRef(false);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (actions.length === 0) return;
    startXRef.current = event.clientX;
    baseOffsetRef.current = offset;
    swipedRef.current = false;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (startXRef.current === null) return;
    const dx = event.clientX - startXRef.current;
    if (!dragging && Math.abs(dx) > 6) {
      setDragging(true);
      swipedRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (dragging || Math.abs(dx) > 6) {
      const next = Math.min(0, Math.max(-(maxReveal + 20), baseOffsetRef.current + dx));
      setOffset(next);
    }
  };

  const finishSwipe = () => {
    if (startXRef.current === null) return;
    startXRef.current = null;
    setDragging(false);
    const shouldOpen = offset < -Math.min(80, maxReveal / 2);
    setOffset(shouldOpen ? -maxReveal : 0);
  };

  return (
    <div className={`rm-swipe-row ${className}`} {...rest}>
      {actions.length > 0 ? (
        <div className="rm-swipe-actions">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              style={{ width: actionWidth }}
              onClick={() => {
                setOffset(0);
                action.onClick();
              }}
              className={`flex flex-col items-center justify-center gap-1 text-[12px] font-semibold ${
                SWIPE_TONE_CLASSES[action.tone ?? "neutral"]
              }`}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div
        data-dragging={dragging ? "true" : "false"}
        style={offset !== 0 ? { transform: `translateX(${offset}px)` } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={finishSwipe}
        onClickCapture={(event) => {
          if (swipedRef.current) {
            event.preventDefault();
            event.stopPropagation();
            swipedRef.current = false;
          } else if (offset !== 0) {
            setOffset(0);
          }
        }}
        className="rm-swipe-front"
      >
        {children}
      </div>
    </div>
  );
}
