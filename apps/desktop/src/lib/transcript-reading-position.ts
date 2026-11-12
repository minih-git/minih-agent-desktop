import { transcriptHasLayout, transcriptSitsAtBottom } from "./transcript-scroll";

export type TranscriptReadingPosition = {
  pinned: boolean;
  messageId?: string;
  offset: number;
  scrollTop: number;
  windowSize: number;
  /**
   * The tail message of the transcript this position was captured in.
   *
   * #A100: a bookmark captured after the session's newest turn was recorded
   * forever, even though the conversation kept growing while the pane was
   * hidden. Reopening such a session restored a mid-history page and showed
   * the "load later messages" pill. The tail anchor lets every reveal path
   * detect that the session has moved on since the bookmark was taken and
   * discard it instead of restoring a position in history that is no longer
   * the place the reader left.
   */
  tailMessageId?: string;
};
export type TranscriptDisclosureChoice = { open: boolean; revealRequest?: number };
type ReadingState = {
  position?: TranscriptReadingPosition;
  disclosures: Map<string, TranscriptDisclosureChoice>;
};

// Renderer-lifetime bookmarks, independent of the bounded DOM and message caches.
// No messages, elements, subscriptions, or persisted user data are retained here.
const readingStates = new Map<string, ReadingState>();
export function sessionReadingState(sessionId: string): ReadingState {
  let state = readingStates.get(sessionId);
  if (!state) {
    state = { disclosures: new Map() };
    readingStates.set(sessionId, state);
  }
  return state;
}
export function getTranscriptReadingPosition(sessionId: string | undefined) {
  return sessionId ? readingStates.get(sessionId)?.position : undefined;
}
export type TranscriptRevealOwnership = "reading-position" | "pinned" | "retained";

/**
 * Whether a bookmark still describes a position worth restoring.
 *
 * `tailMessageId` is the id of the transcript's last row at capture time. A
 * reveal whose transcript ends at another row has appended content since the
 * bookmark was taken (the session kept running while its pane was hidden), so
 * the recorded position no longer means "where the reader left" — it means a
 * point in history. Bookmarks without a tail anchor (in-memory states from an
 * earlier renderer run, or tests) keep the previous behavior: the session
 * cannot be proven to have moved on.
 */
export function transcriptReadingPositionIsStale(
  position: TranscriptReadingPosition,
  tailMessageId: string | undefined,
): boolean {
  if (position.pinned || !position.tailMessageId || !tailMessageId) return false;
  return position.tailMessageId !== tailMessageId;
}

/**
 * The tail anchor a fresh sample records for a bookmark.
 *
 * #A100 decides staleness by comparing the bookmark's tail with the session's
 * live tail, which only means "the session grew after the reader left" when the
 * anchor is the tail the reader was actually looking at. Re-sampling a bookmark
 * from layout — a `ResizeObserver` frame, a scroll event no gesture produced, a
 * follow correction — must therefore keep the anchor it already has. Refreshing
 * it on every sample made an unpinned bookmark claim the growing session as
 * current, so a session whose follow was released during a reply (a manual
 * disclosure or a scroll up) reopened at the row the reader was passing time on
 * instead of the newest turn, and kept doing so on every later visit.
 *
 * A reader's own reading operation re-anchors the bookmark to the tail that was
 * current when they did it: a real scroll gesture, a manual disclosure toggle, a
 * settled history page, search or minimap navigation. A pinned bookmark always
 * records the live tail, because the bottom is the newest turn.
 */
export function readingBookmarkTail({
  pinned,
  readingTailMessageId,
  previousTailMessageId,
  liveTailMessageId,
}: {
  pinned: boolean;
  /** The canonical tail at the reader's last reading operation, if any. */
  readingTailMessageId: string | undefined;
  /** The tail the bookmark already records. */
  previousTailMessageId: string | undefined;
  /** The canonical tail right now. */
  liveTailMessageId: string | undefined;
}): string | undefined {
  if (pinned) return liveTailMessageId;
  return readingTailMessageId ?? previousTailMessageId ?? liveTailMessageId;
}

/** A recorded unpinned bookmark wins over a stale follow flag on pane reveal. */
export function transcriptRevealOwnership(
  bookmark: TranscriptReadingPosition | undefined,
  pending: boolean,
  pinned: boolean,
): TranscriptRevealOwnership {
  if (bookmark?.pinned === false || pending) return "reading-position";
  return pinned ? "pinned" : "retained";
}

export function forgetTranscriptReadingState(sessionId: string) {
  readingStates.delete(sessionId);
}

/**
 * Sample only a visible layout; hidden panes must never replace a bookmark.
 *
 * A scroller that sits within the re-pin band of its own bottom is captured as
 * pinned even when follow mode was released. Interactions that are not reading
 * history hand the scroller to the disclosure anchor — expanding a tool,
 * thinking or activity title does exactly that (#324) — so the sticky follow
 * flag alone recorded a session the reader never left the newest turn of as
 * "scrolled up". Restoring such a bookmark pages history around an old message
 * and opens the session mid-way, needing a manual scroll back to the tail.
 */
export function captureTranscriptReadingPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  pinned: boolean,
  windowSize: number,
  tailMessageId: string | undefined,
): TranscriptReadingPosition | undefined {
  if (!transcriptHasLayout(scroller)) return;
  if (pinned || transcriptSitsAtBottom(scroller)) {
    return { pinned: true, offset: 0, scrollTop: scroller.scrollTop, windowSize, tailMessageId };
  }
  const viewport = scroller.getBoundingClientRect();
  // A prepended page can regroup answers. Prefer the actual visible message,
  // whose identity survives regrouping, then fall back to a turn container.
  for (const selector of ["[data-message-id]", "[data-minimap-id]"]) {
    for (const row of content.querySelectorAll<HTMLElement>(selector)) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.height === 0) continue;
      const messageId = row.dataset.messageId ?? row.dataset.minimapId;
      if (messageId) return { pinned, messageId, offset: rect.top - viewport.top,
        scrollTop: scroller.scrollTop, windowSize, tailMessageId };
    }
  }
}

function readingPositionRow(content: HTMLElement, messageId: string): HTMLElement | null {
  const id = CSS.escape(messageId);
  return content.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    ?? content.querySelector<HTMLElement>(`[data-minimap-id="${id}"]`);
}

/** Test the intended position before correcting lazy-layout displacement. */
export function isTranscriptReadingAnchorVisible(
  scroller: HTMLElement,
  content: HTMLElement,
  position: TranscriptReadingPosition,
): boolean {
  if (!transcriptHasLayout(scroller) || !position.messageId) return false;
  const height = readingPositionRow(content, position.messageId)?.getBoundingClientRect().height ?? 0;
  return height > 0 && position.offset < scroller.clientHeight && position.offset + height > 0;
}

/** Returns false until the bookmarked row is actually mounted. */
export function restoreTranscriptReadingPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  position: TranscriptReadingPosition,
): boolean {
  if (!transcriptHasLayout(scroller)) return false;
  if (position.messageId) {
    const row = readingPositionRow(content, position.messageId);
    if (row) {
      const rect = row.getBoundingClientRect();
      if (rect.height > 0) {
        const delta = rect.top - scroller.getBoundingClientRect().top - position.offset;
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
        return true;
      }
    }
  }
  // The anchored row is not mounted. A reveal mounts only a trailing slice of
  // history (lib/transcript-window.ts:23-28), so an older bookmark can point
  // at a row that is not in the DOM yet. The restore hook waits for the history
  // lookup to finish before applying this fallback; otherwise its alignment
  // deadline could abort a slow lookup.
  //
  // The bookmark already recorded the absolute offset it was taken at, so fall
  // back to it for an approximate position. `false` is reserved for a bookmark
  // with no usable offset at all, which only a never-laid-out pane produces.
  if (!Number.isFinite(position.scrollTop) || position.scrollTop < 0) return false;
  if (Math.abs(scroller.scrollTop - position.scrollTop) > 0.5) scroller.scrollTop = position.scrollTop;
  return true;
}
