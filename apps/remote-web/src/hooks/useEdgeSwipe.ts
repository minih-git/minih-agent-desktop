/**
 * The swipe-back hook: full-screen rightward touch drag for native iOS builds.
 *
 * Uses TouchEvents with a non-passive `touchmove` listener so that once a
 * horizontal rightward drag is recognized (`state === "dragging"`), calling
 * `event.preventDefault()` stops iOS WebKit's UIScrollView from firing
 * `touchcancel`/`pointercancel` mid-swipe. While `state === "pending"`, it
 * never calls `preventDefault()`, keeping vertical scrolling completely native.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  classifyDrag,
  completesOnRelease,
  dragFrame,
  mayStartEdgeGesture,
  type EdgeGestureState,
} from "../lib/edge-gesture.js";

export type EdgeSwipeOptions = {
  enabled: boolean;
  /** Whether the current screen has somewhere to go back to. */
  canGoBack: boolean;
  onBack: () => void;
};

function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * If the user touches inside a horizontally scrollable element (such as a wide
 * `<pre>` or table) that has been scrolled to the right (`scrollLeft > 0`), let
 * a rightward drag scroll that element back to its left edge first.
 */
function insideScrolledHorizontalElement(target: EventTarget | null): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== document.body) {
    if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") {
      return true;
    }
    if (node.scrollWidth > node.clientWidth + 2 && node.scrollLeft > 0) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

export type EdgeSwipeView = {
  state: EdgeGestureState;
  /** How far the outgoing screen has moved, in CSS pixels. */
  offset: number;
  /** 0–1, for the screen underneath's parallax. */
  progress: number;
};

export function useEdgeSwipe(options: EdgeSwipeOptions): EdgeSwipeView {
  const [view, setView] = useState<EdgeSwipeView>({ state: "idle", offset: 0, progress: 0 });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const reset = useCallback(() => setView({ state: "idle", offset: 0, progress: 0 }), []);

  useEffect(() => {
    if (!options.enabled) {
      reset();
      return undefined;
    }
    let state: EdgeGestureState = "idle";
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let touchId: number | null = null;
    let startedAt = 0;

    const finish = (complete: boolean) => {
      const current = optionsRef.current;
      state = "idle";
      touchId = null;
      reset();
      if (complete) current.onBack();
    };

    const findTouch = (list: TouchList, id: number): Touch | null => {
      for (let i = 0; i < list.length; i += 1) {
        const item = list.item(i);
        if (item && item.identifier === id) return item;
      }
      return null;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        if (touchId !== null) finish(false);
        return;
      }
      const touch = event.touches[0]!;
      state = "idle";
      touchId = null;
      const current = optionsRef.current;
      if (insideScrolledHorizontalElement(event.target)) return;
      if (
        !mayStartEdgeGesture({
          startX: touch.clientX,
          sheetOpen: modalOpen(),
          canGoBack: current.canGoBack,
          pointerType: "touch",
        })
      ) {
        return;
      }
      state = "pending";
      touchId = touch.identifier;
      startX = touch.clientX;
      lastX = touch.clientX;
      startY = touch.clientY;
      startedAt = event.timeStamp;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (touchId === null) return;
      const touch = findTouch(event.changedTouches, touchId) ?? findTouch(event.touches, touchId);
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      lastX = touch.clientX;
      if (state === "pending") {
        const verdict = classifyDrag({ dx, dy });
        if (verdict.kind === "reject") {
          state = "cancelled";
          touchId = null;
          reset();
          return;
        }
        if (verdict.kind === "undecided") return;
        state = "dragging";
      }
      if (state === "dragging" && event.cancelable) {
        event.preventDefault();
      }
      const offset = Math.max(0, dx);
      const frame = dragFrame({ offset, viewportWidth: window.innerWidth });
      setView({ state, offset, progress: frame.parallax });
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (touchId === null) return;
      const touch = findTouch(event.changedTouches, touchId);
      const endX = touch ? touch.clientX : lastX;
      const dragging = state === "dragging";
      const offset = Math.max(0, endX - startX);
      const elapsed = Math.max(1, event.timeStamp - startedAt);
      const velocity = (endX - startX) / elapsed;
      finish(
        dragging &&
          completesOnRelease({ offset, velocity, viewportWidth: window.innerWidth }),
      );
    };

    const onTouchCancel = (event: TouchEvent) => {
      if (touchId === null) return;
      // If the user already dragged past the completion threshold when the OS
      // interrupts the touch, still complete the back navigation instead of
      // snapping back unexpectedly.
      const touch = findTouch(event.changedTouches, touchId);
      const endX = touch ? touch.clientX : lastX;
      const dragging = state === "dragging";
      const offset = Math.max(0, endX - startX);
      const elapsed = Math.max(1, event.timeStamp - startedAt);
      const velocity = (endX - startX) / elapsed;
      finish(
        dragging &&
          completesOnRelease({ offset, velocity, viewportWidth: window.innerWidth }),
      );
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchCancel);
      reset();
    };
  }, [options.enabled, reset]);

  return view;
}
