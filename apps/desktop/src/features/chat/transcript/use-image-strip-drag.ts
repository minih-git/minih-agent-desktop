import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  beginImageStripDrag,
  imageStripDragBlocksClick,
  moveImageStripDrag,
  type ImageStripDrag,
} from "./image-strip-drag";

type StripDragHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Drops the click a drag would otherwise deliver to the tile under it. */
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

/**
 * Drag-to-scroll for one overflowing row of tiles.
 *
 * A trackpad or a scroll wheel already scrolls the row sideways; this adds the
 * pointer press that the tiles themselves, being buttons, would otherwise
 * swallow. Listeners live on `window` for the length of the gesture only, so a
 * press released outside the row still ends, and unmounting mid-drag releases
 * them and the pending click suppression too.
 */
export function useImageStripDrag(): {
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  dragging: boolean;
  handlers: StripDragHandlers;
} {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ImageStripDrag | null>(null);
  const suppressClickRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag || !scroller || event.pointerId !== drag.pointerId) return;
    const next = moveImageStripDrag(drag, event.clientX);
    dragRef.current = next.drag;
    if (next.scrollLeft !== null) scroller.scrollLeft = next.scrollLeft;
  }, []);

  const endGesture = useCallback(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endGesture);
    window.removeEventListener("pointercancel", endGesture);
    if (imageStripDragBlocksClick(dragRef.current)) {
      // The click the browser pairs with this gesture arrives right after
      // `pointerup`, so the suppression has to outlive the gesture itself.
      suppressClickRef.current = true;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
  }, [onPointerMove]);

  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endGesture);
    window.removeEventListener("pointercancel", endGesture);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
    dragRef.current = null;
  }, [endGesture, onPointerMove]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    // Only a primary-button press on a row that actually overflows: a press on
    // a row that fits has nothing to scroll, and stays an ordinary click.
    if (event.button !== 0 || !scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    suppressClickRef.current = false;
    dragRef.current = beginImageStripDrag(event.pointerId, event.clientX, scroller.scrollLeft);
    setDragging(true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endGesture);
    window.addEventListener("pointercancel", endGesture);
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return { scrollerRef, dragging, handlers: { onPointerDown, onClickCapture } };
}
