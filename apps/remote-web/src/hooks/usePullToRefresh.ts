import { useEffect, useState, type RefObject } from "react";

import { createPullTracker } from "../lib/pull-to-refresh.js";

/**
 * Pull-down-to-refresh for a scrolling container (`ScreenContent`).
 *
 * The hosts list's spec promises "pull down to re-probe every computer" and the
 * screen shipped no gesture to do it: the only refresh sat inside one row's
 * menu, so a phone could not learn that another computer had come back — or that
 * this one had gone away — without reopening the app.
 *
 * The native touch is deliberately left alone (no `preventDefault`): the element
 * already scrolls, and the gesture is only claimed while it sits at its very top,
 * which is exactly where the browser draws its own overscroll. Momentum, nested
 * scrolling and keyboard behaviour stay untouched here; the reported state only
 * drives the indicator, and what a drag means lives in `pull-to-refresh.ts` so it
 * is testable without a browser.
 */
export function usePullToRefresh(input: {
  scrollRef: RefObject<HTMLElement | null>;
  onRefresh: () => void;
}): { pulling: boolean } {
  const { scrollRef, onRefresh } = input;
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const tracker = createPullTracker();

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      tracker.start({
        touches: event.touches.length,
        scrollTop: element.scrollTop,
        clientY: touch.clientY,
      });
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      setPulling(tracker.move({ clientY: touch.clientY }));
    };
    const onTouchEnd = (event: TouchEvent) => {
      setPulling(false);
      const clientY = event.changedTouches[0]?.clientY;
      if (tracker.end(clientY === undefined ? {} : { clientY })) onRefresh();
    };
    const onTouchCancel = () => {
      tracker.cancel();
      setPulling(false);
    };

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchCancel);
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [scrollRef, onRefresh]);

  return { pulling };
}