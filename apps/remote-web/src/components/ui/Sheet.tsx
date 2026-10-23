/**
 * Glass bottom sheet with spring entrance and drag-to-dismiss (ADR mobile-redesign D4).
 *
 * Keeps `role="dialog"` and `aria-modal="true"` so `useEdgeSwipe` knows a
 * modal sheet is open and never intercepts horizontal gestures beneath it.
 * Dragging the top grab handle downward follows the finger via `requestAnimationFrame`
 * and dismisses past 110 px, or springs back when released earlier.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

const DISMISS_DRAG_PX = 110;

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
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startYRef = useRef<number | null>(null);
  const latestDyRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      setDragY(0);
      setDragging(false);
      startYRef.current = null;
      latestDyRef.current = 0;
      if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    startYRef.current = event.clientY;
    latestDyRef.current = 0;
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (startYRef.current === null) return;
    const dy = Math.max(0, event.clientY - startYRef.current);
    latestDyRef.current = dy;
    if (typeof requestAnimationFrame === "function") {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setDragY(latestDyRef.current);
      });
    } else {
      setDragY(dy);
    }
  };

  const finishDrag = () => {
    if (startYRef.current === null) return;
    startYRef.current = null;
    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const dy = latestDyRef.current;
    latestDyRef.current = 0;
    setDragging(false);
    if (dy > DISMISS_DRAG_PX) {
      setDragY(0);
      onClose();
    } else {
      setDragY(0);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* Scrim */}
      <div
        className="fixed inset-0 bg-[var(--rm-scrim)] backdrop-blur-xs animate-[rm-scrim-in_0.25s_var(--rm-ease-out)]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        role="dialog"
        aria-modal="true"
        data-dragging={dragging ? "true" : "false"}
        style={
          dragY > 0
            ? {
                transform: `translateY(${dragY}px)`,
                transition: dragging ? "none" : "transform 0.5s var(--rm-ease-spring)",
              }
            : undefined
        }
        className={`rm-dock relative z-10 mx-auto flex max-h-[88dvh] w-full max-w-[640px] flex-col rounded-t-[var(--rm-radius-sheet,28px)] border-t border-[var(--rm-hair)] bg-[var(--rm-glass-strong)] px-4 pt-1 text-[var(--rm-text-primary)] shadow-[var(--rm-shadow)] backdrop-blur-[30px] backdrop-saturate-[1.8] animate-[rm-sheet-in_0.5s_var(--rm-ease-spring)] transition-transform duration-500 ease-[var(--rm-ease-spring)] ${className}`}
      >
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          className="grid cursor-grab touch-none place-items-center py-2.5 select-none active:cursor-grabbing"
          aria-hidden="true"
        >
          <i className="h-[5px] w-[38px] rounded-[3px] bg-[var(--rm-text-faint)] opacity-85" />
        </div>

        {title ? (
          <h2 className="px-1 text-left text-[19px] font-bold leading-[24px] text-[var(--rm-text-primary)]">
            {title}
          </h2>
        ) : null}
        {description ? (
          <p className="mt-1 px-1 text-left text-[13px] leading-[19px] text-[var(--rm-text-muted)]">
            {description}
          </p>
        ) : null}

        <div className="mt-3 flex flex-col gap-2 overflow-y-auto pb-1">{children}</div>
      </div>
    </div>
  );
}
