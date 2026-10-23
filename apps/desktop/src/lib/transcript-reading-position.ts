import { transcriptHasLayout, transcriptSitsAtBottom } from "./transcript-scroll";

export type TranscriptReadingPosition = {
  pinned: boolean;
  messageId?: string;
  offset: number;
  scrollTop: number;
  windowSize: number;
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
): TranscriptReadingPosition | undefined {
  if (!transcriptHasLayout(scroller)) return;
  if (pinned || transcriptSitsAtBottom(scroller)) {
    return { pinned: true, offset: 0, scrollTop: scroller.scrollTop, windowSize };
  }
  const viewport = scroller.getBoundingClientRect();
  // Prefer the outer message/turn: its offset also describes reading inside an
  // expanded tool body, whose explicit disclosure choices survive eviction.
  for (const row of content.querySelectorAll<HTMLElement>("[data-minimap-id], [data-message-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.height === 0) continue;
    const messageId = row.dataset.minimapId ?? row.dataset.messageId;
    if (messageId) return { pinned, messageId, offset: rect.top - viewport.top,
      scrollTop: scroller.scrollTop, windowSize };
  }
}

/** Returns false until the bookmarked row is actually mounted. */
export function restoreTranscriptReadingPosition(
  scroller: HTMLElement,
  content: HTMLElement,
  position: TranscriptReadingPosition,
): boolean {
  if (!transcriptHasLayout(scroller)) return false;
  if (position.messageId) {
    const id = CSS.escape(position.messageId);
    const row = content.querySelector<HTMLElement>(`[data-minimap-id="${id}"], [data-message-id="${id}"]`);
    if (row) {
      const rect = row.getBoundingClientRect();
      if (rect.height > 0) {
        scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - position.offset;
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
  scroller.scrollTop = position.scrollTop;
  return true;
}
