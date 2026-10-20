/**
 * Scroll decisions for the timeline (rollout D).
 *
 * The session screen used to have no scroll handling at all: the whole document
 * scrolled, so opening a long conversation landed on the oldest row, the
 * composer sat far below, and a new message arrived off-screen. What "follow the
 * newest row" means is a small amount of arithmetic, and keeping it here — pure,
 * with no DOM — is what makes it testable without a browser.
 *
 * The rules, in one place:
 *   - the reader is "at the bottom" when they are within `FOLLOW_THRESHOLD_PX`
 *     of it; only then does new content scroll itself into view;
 *   - otherwise the newest rows are counted as unread and the screen offers a
 *     way back down;
 *   - inserting older rows above keeps the reader where they were, by preserving
 *     the distance to the bottom rather than the raw offset.
 */

/** How close to the bottom still counts as "following the conversation". */
export const FOLLOW_THRESHOLD_PX = 80;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Pixels between the current offset and the bottom, never negative. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

/** Whether new content should scroll itself into view. */
export function isNearBottom(metrics: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

/** The offset that shows the newest row. */
export function bottomOffset(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/** The two ends of the transcript, which is what "something arrived" means. */
export type TimelineEdges = { itemCount: number; firstItemId: string; lastItemId: string };

/**
 * How many rows arrived at the *end* of the transcript.
 *
 * Older rows loaded above the reader are not new messages, however many of them
 * arrived: they leave the last row exactly where it was, so they count as zero
 * and the screen keeps saying "back to latest" without a number. Only a changed
 * last row is new content, and then at least one row — the count can otherwise
 * be zero when a row was trimmed at the cap or a streamed row grew in place.
 */
export function appendedRows(before: TimelineEdges, after: TimelineEdges): number {
  if (after.lastItemId === before.lastItemId) return 0;
  // Both ends moved: a prepend and an append in one commit. The appended rows
  // cannot be separated from the prepended ones, so the honest answer is "at
  // least the new last row".
  if (after.firstItemId !== before.firstItemId) return 1;
  return Math.max(1, after.itemCount - before.itemCount);
}

/**
 * How many rows have arrived while the reader was not at the bottom.
 *
 * Following the conversation clears the count; a row the reader caused (their
 * own message) counts too, because they still have not seen the reply that came
 * with it.
 */
export function unreadAfter(current: number, input: { following: boolean; appended: number }): number {
  if (input.following) return 0;
  return Math.max(0, current + input.appended);
}

/**
 * Whether the reader asked for less motion. Absent (a non-browser test, an old
 * webview) means "no preference", which is the same as allowing motion.
 */
export function prefersReducedMotion(query: ((query: string) => { matches: boolean }) | undefined): boolean {
  if (!query) return false;
  try {
    return query("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}
