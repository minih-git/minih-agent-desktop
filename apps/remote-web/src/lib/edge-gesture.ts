/**
 * The iOS swipe-back gesture (R7 follow-up), as pure decisions.
 *
 * The native shell cannot use `allowsBackForwardNavigationGestures`: that gesture
 * shows a WebView snapshot and drives the history while the app's own state
 * changes underneath it. So the gesture is ours:
 *
 * - it can start anywhere on the screen (`startX >= 0`) as long as a modal sheet
 *   is not open and the touch is not inside a horizontally scrolled container;
 * - a drag that is mostly vertical, or that moves left, is immediately released
 *   so vertical scrolling is never stolen;
 * - on release the screen completes the pop past a distance or a velocity
 *   threshold, and otherwise springs back.
 */

/** Kept for compatibility; full-screen swipe accepts any non-negative `startX`. */
export const EDGE_WIDTH = 20;

/**
 * How much horizontal travel before a drag is treated as a back gesture at all.
 * Below this the touch may still be a tap or the start of a vertical scroll.
 */
export const HORIZONTAL_SLOP = 12;

/** Past this fraction of the viewport width, releasing completes the pop. */
export const COMPLETE_FRACTION = 0.25;

/** Past this velocity (px/ms), a short but fast flick also completes it. */
export const COMPLETE_VELOCITY = 0.35;

/**
 * How far the finger must travel before a flick can complete the pop.
 */
export const MIN_FLICK_DISTANCE_FRACTION = 0.1;

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
 * Whether this touch may become a back swipe. Any touch on the screen may start
 * a rightward back gesture when there is a previous screen and no modal sheet is open.
 */
export function mayStartEdgeGesture(input: EdgeGestureInput): boolean {
  if (input.pointerType !== "touch") return false;
  if (input.sheetOpen) return false;
  if (!input.canGoBack) return false;
  return input.startX >= 0;
}

export type DragVerdict =
  /** Not enough movement to decide yet. */
  | { kind: "undecided" }
  /** This is a vertical scroll or a leftward gesture: release the touch. */
  | { kind: "reject" }
  /** Dragging horizontally to the right: track it. */
  | { kind: "drag"; offset: number };

/** Classify the movement since touch-down. */
export function classifyDrag(input: { dx: number; dy: number }): DragVerdict {
  const absY = Math.abs(input.dy);
  // Mostly vertical: the timeline's scroll. Never steal it.
  if (absY > Math.abs(input.dx) && absY > HORIZONTAL_SLOP) {
    return { kind: "reject" };
  }
  if (input.dx < -HORIZONTAL_SLOP) return { kind: "reject" };
  if (input.dx < HORIZONTAL_SLOP) return { kind: "undecided" };
  // Require clearly horizontal movement when starting anywhere on screen.
  if (input.dx < absY * 1.2) return { kind: "reject" };
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
  return { progress, parallax: progress * (1 / 3) };
}
