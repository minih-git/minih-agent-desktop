/**
 * The iOS edge-swipe back gesture (R7 follow-up), as pure decisions.
 *
 * The native shell cannot use `allowsBackForwardNavigationGestures`: that gesture
 * shows a WebView snapshot and, worse, drives the *history* while the app's own
 * state (a streaming session, an open sheet) changes underneath it. So the
 * gesture is ours, and it is deliberately narrow:
 *
 * - it only starts within `EDGE_WIDTH` of the left edge, so a horizontal scroll
 *   inside a code block or a table, and the timeline's vertical scroll, are
 *   untouched;
 * - a drag that is mostly vertical, or that never clearly moves right, is
 *   abandoned rather than turned into a navigation;
 * - on release the screen completes the pop past a distance or a velocity
 *   threshold, and otherwise springs back — the two things a native swipe does.
 *
 * Everything here is arithmetic over numbers, so the thresholds are testable
 * without a browser.
 */

/** How far from the left edge a gesture must start, in CSS pixels. */
export const EDGE_WIDTH = 20;

/**
 * How much horizontal travel before a drag is treated as a back gesture at all.
 * Below this the touch may still be a tap or the start of a vertical scroll.
 */
export const HORIZONTAL_SLOP = 12;

/** Past this fraction of the viewport width, releasing completes the pop. */
export const COMPLETE_FRACTION = 1 / 3;

/** Past this velocity (px/ms), a short but fast flick also completes it. */
export const COMPLETE_VELOCITY = 0.5;

/**
 * How far the finger must travel before a flick can complete the pop.
 *
 * A touch event can arrive a millisecond after the previous one, and an
 * instantaneous velocity computed from that pair is pure noise: a 40 px drag
 * measured over a 1 ms gap reads as 6.7 px/ms, which the first version of this
 * rule accepted as a deliberate flick. Requiring a real distance first makes a
 * short drag spring back whatever its reported speed.
 */
export const MIN_FLICK_DISTANCE_FRACTION = 0.15;

export type EdgeGestureState = "idle" | "pending" | "dragging" | "cancelled";

export type EdgeGestureInput = {
  /** Distance from the left edge of the viewport, in CSS pixels. */
  startX: number;
  /** Whether a sheet or dialog is open: the swipe then belongs to it, or to nothing. */
  sheetOpen: boolean;
  /** Whether there is anywhere to go back to. */
  canGoBack: boolean;
  /** Touch pointer only: a mouse drag is not a phone gesture. */
  pointerType: string;
};

/**
 * Whether this touch may become a back swipe. A gesture that starts off the edge,
 * or while a sheet is open, or with nowhere to go, is never intercepted — the
 * page keeps it, which is what keeps horizontal scrolling working.
 */
export function mayStartEdgeGesture(input: EdgeGestureInput): boolean {
  if (input.pointerType !== "touch") return false;
  if (input.sheetOpen) return false;
  if (!input.canGoBack) return false;
  return input.startX >= 0 && input.startX <= EDGE_WIDTH;
}

export type DragVerdict =
  /** Not enough movement to decide yet. */
  | { kind: "undecided" }
  /** This is a vertical scroll or a leftward gesture: release the touch. */
  | { kind: "reject" }
  /** Dragging horizontally from the edge: track it. */
  | { kind: "drag"; offset: number };

/** Classify the movement since touch-down. */
export function classifyDrag(input: { dx: number; dy: number }): DragVerdict {
  // Mostly vertical: the timeline's scroll. Never steal it.
  if (Math.abs(input.dy) > Math.abs(input.dx) && Math.abs(input.dy) > HORIZONTAL_SLOP) {
    return { kind: "reject" };
  }
  if (input.dx < -HORIZONTAL_SLOP) return { kind: "reject" };
  if (input.dx < HORIZONTAL_SLOP) return { kind: "undecided" };
  return { kind: "drag", offset: Math.max(0, input.dx) };
}

/** Whether releasing now completes the pop or springs back. */
export function completesOnRelease(input: {
  offset: number;
  /** Average speed of the whole drag, px/ms; negative when it moved left. */
  velocity: number;
  viewportWidth: number;
}): boolean {
  if (input.viewportWidth <= 0) return false;
  // A fast leftward flick cancels even a long drag: the user changed their mind.
  if (input.velocity <= -COMPLETE_VELOCITY) return false;
  const flickable = input.offset >= input.viewportWidth * MIN_FLICK_DISTANCE_FRACTION;
  if (flickable && input.velocity >= COMPLETE_VELOCITY) return true;
  return input.offset >= input.viewportWidth * COMPLETE_FRACTION;
}

/** How far the outgoing screen is drawn, and how visible the one beneath is. */
export function dragFrame(input: {
  offset: number;
  viewportWidth: number;
}): { progress: number; parallax: number } {
  if (input.viewportWidth <= 0) return { progress: 0, parallax: 0 };
  const progress = Math.max(0, Math.min(1, input.offset / input.viewportWidth));
  // The screen underneath slides a third of the distance, which is the
  // parallax a native push/pop has.
  return { progress, parallax: progress * (1 / 3) };
}
