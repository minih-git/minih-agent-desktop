/**
 * The edge-swipe hook: one point listener, one overlay, one navigation.
 *
 * Only a native iOS build mounts this. A browser already has its own edge
 * gesture driving the history (`screen-history.ts`), and running both would make
 * one swipe pop twice.
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

/**
 * Whether a modal sheet is open right now.
 *
 * Every sheet in this client renders through `components/ui/Sheet`, which marks
 * itself `role="dialog" aria-modal="true"`. Reading that contract at gesture
 * time keeps this hook from needing a sheet state passed down from six screens,
 * and it cannot drift: a component that forgets the attributes is not a sheet.
 */
function modalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export type EdgeSwipeView = {
  state: EdgeGestureState;
  /** How far the outgoing screen has moved, in CSS pixels. */
  offset: number;
  /** 0–1, for the screen underneath's parallax. */
  progress: number;
};

/**
 * Track a left-edge drag and call `onBack` when it completes.
 *
 * The listener is passive on purpose: this gesture never blocks a scroll it
 * decided not to own. It is attached to `document` once for the lifetime of the
 * screen, and removed on unmount and whenever it is disabled — a session screen
 * that unmounts mid-drag must not leave a listener behind.
 */
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
    let pointerId: number | null = null;
    // Velocity is measured over the whole drag: an instantaneous sample from a
    // pair of events a millisecond apart is noise, not intent (see
    // `MIN_FLICK_DISTANCE_FRACTION`).
    let startedAt = 0;

    const finish = (complete: boolean) => {
      const current = optionsRef.current;
      state = "idle";
      pointerId = null;
      reset();
      if (complete) current.onBack();
    };

    const onStart = (event: PointerEvent) => {
      state = "idle";
      pointerId = null;
      const current = optionsRef.current;
      if (!mayStartEdgeGesture({
        startX: event.clientX,
        sheetOpen: modalOpen(),
        canGoBack: current.canGoBack,
        pointerType: event.pointerType,
      })) {
        return;
      }
      state = "pending";
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startedAt = event.timeStamp;
    };

    const onMove = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (state === "pending") {
        const verdict = classifyDrag({ dx, dy });
        if (verdict.kind === "reject") {
          state = "cancelled";
          pointerId = null;
          reset();
          return;
        }
        if (verdict.kind === "undecided") return;
        state = "dragging";
      }
      const offset = Math.max(0, dx);
      const frame = dragFrame({ offset, viewportWidth: window.innerWidth });
      setView({ state, offset, progress: frame.parallax });
    };

    const onEnd = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const dragging = state === "dragging";
      const offset = Math.max(0, event.clientX - startX);
      const elapsed = Math.max(1, event.timeStamp - startedAt);
      const velocity = (event.clientX - startX) / elapsed;
      // "cancelled" means the drag decided it was a scroll, so nothing happens.
      finish(
        dragging &&
          completesOnRelease({ offset, velocity, viewportWidth: window.innerWidth }),
      );
    };

    const onCancel = () => {
      if (pointerId === null) return;
      finish(false);
    };

    document.addEventListener("pointerdown", onStart, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", onEnd, { passive: true });
    document.addEventListener("pointercancel", onCancel, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", onStart);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onCancel);
      reset();
    };
  }, [options.enabled, reset]);

  return view;
}
