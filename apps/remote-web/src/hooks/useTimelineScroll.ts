/**
 * The timeline's scroll container (rollout D).
 *
 * `main` is the scroll container (the header and the composer are fixed by
 * `AppShell`), and this hook owns everything about where it is: following the
 * newest row, counting what arrived while the reader was reading something else,
 * holding the position when older rows are inserted above, and keeping the
 * bottom in view when the on-screen keyboard opens.
 *
 * The decisions live in `lib/scroll.ts`; this file only wires them to the DOM.
 * Three of those wires are deliberate and easy to get wrong:
 *
 *   - the position is restored in a *layout* effect, so it runs after React has
 *     committed the new rows but before the browser paints. Doing it when the
 *     load resolves is too early (the rows are not in the DOM yet) and only
 *     looks right on an engine that compensates by itself — Chromium's scroll
 *     anchoring. iOS WebKit has none, and the phone is the target.
 *   - the compensation is anchored on the *row the reader is looking at*
 *     (`data-item-id`), not on `scrollHeight`: whatever moved that row — a page
 *     of older rows above, a trim at the cap, a wrapped line — the same row goes
 *     back to the same place on screen.
 *   - the container disables the engine's own anchoring
 *     (`[overflow-anchor:none]` in `AppShell`), so there is exactly one
 *     mechanism and the E2E measures the code rather than the engine.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  appendedRows,
  bottomOffset,
  isNearBottom,
  prefersReducedMotion,
  unreadAfter,
  type ScrollMetrics,
  type TimelineEdges,
} from "../lib/scroll.js";

export type TimelineScroll = {
  /** Attach to the scrolling element (`AppShell`'s `main`). */
  containerRef: (element: HTMLElement | null) => void;
  /** Whether the reader is at (or near) the newest row. */
  following: boolean;
  /** Rows that arrived at the end while they were not. */
  unread: number;
  /** Jump to the newest row; animated unless the reader asked for less motion. */
  scrollToBottom: (options?: { instant?: boolean }) => void;
};

/** The row the reader is looking at, and where it sits inside the content. */
type Anchor = { id: string; contentOffset: number };

/**
 * A row's distance from the top of the content, independent of how far the
 * reader has scrolled.
 *
 * Only a change here means the content above the row changed, which is the only
 * case where the reader's position has to be corrected. Measuring the row's
 * position on screen instead would also fire when the reader scrolls, and then
 * the correction would fight the scroll they just made — including the "back to
 * latest" jump.
 */
function contentOffsetOf(node: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
}

export function useTimelineScroll(options: {
  /** Rows currently rendered, and the ids of the two ends. */
  itemCount: number;
  firstItemId: string;
  lastItemId: string;
  /** The newest row's identity and length, so a streamed row counts as growth. */
  tailKey: string;
  /** Pending approval/input cards, which must not arrive unseen. */
  attention: number;
}): TimelineScroll {
  const { itemCount, firstItemId, lastItemId, tailKey, attention } = options;
  const elementRef = useRef<HTMLElement | null>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  const followingRef = useRef(true);
  const initialisedRef = useRef(false);
  /** The row to put back after the next commit, and where it was. */
  const anchorRef = useRef<Anchor | null>(null);
  /** The same edges for the follow/unread effect, which runs later. */
  const previousContentRef = useRef<TimelineEdges & { tailKey: string }>({
    itemCount,
    firstItemId,
    lastItemId,
    tailKey,
  });
  const previousAttentionRef = useRef(attention);

  const metrics = useCallback((): ScrollMetrics => {
    const node = elementRef.current;
    if (!node) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
  }, []);

  const setFollowingBoth = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const scrollToBottom = useCallback(
    (scrollOptions: { instant?: boolean } = {}) => {
      const node = elementRef.current;
      if (!node) return;
      const reduceMotion = prefersReducedMotion(
        typeof window === "undefined" ? undefined : window.matchMedia.bind(window),
      );
      const instant = scrollOptions.instant === true || reduceMotion;
      node.scrollTo({ top: bottomOffset(metrics()), ...(instant ? {} : { behavior: "smooth" }) });
      setUnread(0);
      setFollowingBoth(true);
    },
    [metrics, setFollowingBoth],
  );

  const containerRef = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
    setElement(node);
  }, []);

  // The reader decides whether they are following: every scroll re-reads it.
  useEffect(() => {
    if (!element) return undefined;
    const onScroll = () => {
      const near = isNearBottom(metrics());
      setFollowingBoth(near);
      if (near) setUnread(0);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [element, metrics, setFollowingBoth]);

  /**
   * Put the row the reader was looking at back where it was, then remember the
   * row to look after for the next commit.
   *
   * Reading positions in a layout effect is what makes this engine-independent:
   * the DOM is updated, nothing has painted, and moving `scrollTop` here cannot
   * flicker.
   */
  useLayoutEffect(() => {
    const node = elementRef.current;
    if (!node) return;
    const previous = anchorRef.current;
    if (previous) {
      const row = node.querySelector<HTMLElement>(`[data-item-id="${previous.id}"]`);
      if (row) {
        const delta = contentOffsetOf(node, row) - previous.contentOffset;
        // Rows inserted above moved the content down by their own height; rows
        // trimmed above moved it up. Either way the reader keeps their row.
        if (delta !== 0) node.scrollTop += delta;
      }
    }
    const containerTop = node.getBoundingClientRect().top;
    const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-item-id]"));
    // The anchor is the first row still visible, or the newest row when the
    // reader is past the end of the transcript.
    const visible = rows.find((row) => row.getBoundingClientRect().bottom > containerTop + 1) ?? rows.at(-1);
    const id = visible?.getAttribute("data-item-id") ?? "";
    anchorRef.current = visible && id ? { id, contentOffset: contentOffsetOf(node, visible) } : null;
  });

  // The first rows of a conversation land at the newest row, without animation:
  // a long session must not animate through screens of history.
  useEffect(() => {
    if (initialisedRef.current || itemCount === 0) return;
    initialisedRef.current = true;
    scrollToBottom({ instant: true });
  }, [itemCount, scrollToBottom]);

  // New content: follow it when the reader is at the bottom, count it when not.
  // Rows prepended above are neither: the last row did not change, so they are
  // not "new messages" and the control keeps saying "back to latest".
  useEffect(() => {
    const before = previousContentRef.current;
    const edges = { itemCount, firstItemId, lastItemId };
    previousContentRef.current = { ...edges, tailKey };
    const appended = appendedRows(before, edges);
    const tailGrew = tailKey !== before.tailKey;
    if (appended === 0 && !tailGrew) return;
    if (followingRef.current) {
      // Instant: an animated scroll on every streamed delta would never settle.
      scrollToBottom({ instant: true });
      return;
    }
    setUnread((current) => unreadAfter(current, { following: false, appended: appended > 0 ? appended : 1 }));
  }, [itemCount, firstItemId, lastItemId, tailKey, scrollToBottom]);

  // An approval or an input request must not arrive unseen: scroll to it when
  // the reader is at the bottom, and let the button say so when they are not.
  useEffect(() => {
    if (attention === previousAttentionRef.current) return;
    const arrived = attention > previousAttentionRef.current;
    previousAttentionRef.current = attention;
    if (arrived && followingRef.current) scrollToBottom({ instant: true });
  }, [attention, scrollToBottom]);

  // The on-screen keyboard resizes the visual viewport rather than the layout
  // viewport. A reader who was at the bottom stays at the bottom, because the
  // composer they are typing into is what moved.
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return undefined;
    const viewport = window.visualViewport;
    const onResize = () => {
      if (followingRef.current) scrollToBottom({ instant: true });
    };
    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
  }, [scrollToBottom]);

  return { containerRef, following, unread, scrollToBottom };
}
