import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  captureTranscriptReadingPosition,
  isTranscriptReadingAnchorVisible,
  restoreTranscriptReadingPosition,
  type TranscriptReadingPosition,
} from "../../../../lib/transcript-reading-position";

type Hold = {
  position: TranscriptReadingPosition;
  point?: { element: HTMLElement; offset: number };
  settled: boolean;
  stableFrames: number;
  page: boolean;
  windowSize: number;
  sourceHead?: string;
  alignedHead?: string;
  height: number;
  top: number;
  viewport: number;
  scroller: HTMLDivElement;
};

const layoutChanged = (held: Hold, sourceHead: string | undefined) =>
  held.height !== held.scroller.scrollHeight || held.viewport !== held.scroller.clientHeight ||
  held.alignedHead !== sourceHead;

function messageRow(content: HTMLElement, position: TranscriptReadingPosition) {
  const id = CSS.escape(position.messageId ?? "");
  return content.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    ?? content.querySelector<HTMLElement>(`[data-minimap-id="${id}"]`);
}

function contentPoint(scroller: HTMLElement, content: HTMLElement, position: TranscriptReadingPosition) {
  const viewport = scroller.getBoundingClientRect();
  const row = messageRow(content, position);
  for (const element of row?.querySelectorAll<HTMLElement>(".prose-chat p, .prose-chat li, .prose-chat pre, .prose-chat h1, .prose-chat h2, .prose-chat h3, .message-user-text") ?? []) {
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
      return { element, offset: rect.top - viewport.top };
    }
  }
}

/** Page IO is single-flight; readable content retains the viewport after it settles. */
export function useTranscriptHistoryPaging({ scrollRef, contentRef, visible, sourceHead, tailMessageId, canRetain, onStart, onPosition, onSettled }: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  sourceHead: string | undefined;
  tailMessageId?: string;
  canRetain: (paging: boolean) => boolean;
  onStart: () => void;
  onPosition: (top: number) => void;
  onSettled: () => void;
}) {
  const holdRef = useRef<Hold | null>(null);
  const readingRef = useRef<Hold | null>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);
  const observedRowsRef = useRef(new Set<HTMLElement>());
  const inFlightRef = useRef(false);
  const frameRef = useRef(0);
  const autoBlockedRef = useRef(false);
  const latencyRef = useRef(250);
  const readLatency = useCallback(() => latencyRef.current, []);
  const sourceHeadRef = useRef(sourceHead);
  sourceHeadRef.current = sourceHead;
  const retry = useCallback(() => { autoBlockedRef.current = false; }, []);
  const [phase, setPhase] = useState<"idle" | "mount" | "page">("idle");
  const [, refresh] = useState(0);
  const callbacks = useRef({ canRetain, onStart, onPosition, onSettled });
  callbacks.current = { canRetain, onStart, onPosition, onSettled };
  const readingHold = useCallback(() => {
    if (!callbacks.current.canRetain(holdRef.current !== null)) {
      readingRef.current = null;
      return null;
    }
    return holdRef.current ?? readingRef.current;
  }, []);

  const dropHold = useCallback(() => {
    holdRef.current = null;
    readingRef.current = null;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);
  const cancel = useCallback(() => { dropHold(); setPhase("idle"); }, [dropHold]);
  const captureHold = useCallback((windowSize: number, page = false): Hold | null => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return null;
    const position = captureTranscriptReadingPosition(scroller, content, false, windowSize, tailMessageId)
      ?? { pinned: false, offset: 0, scrollTop: scroller.scrollTop, windowSize, tailMessageId };
    return { position, point: contentPoint(scroller, content, position), settled: false, stableFrames: 0, page, windowSize,
      sourceHead: sourceHeadRef.current, alignedHead: sourceHeadRef.current,
      height: scroller.scrollHeight, top: scroller.scrollTop, viewport: scroller.clientHeight, scroller };
  }, [contentRef, scrollRef, tailMessageId]);
  const isHeld = useCallback(() => holdRef.current !== null, []);
  const track = useCallback((windowSize = 0) => {
    let held = readingHold();
    if (!held && callbacks.current.canRetain(false)) {
      held = captureHold(windowSize);
      readingRef.current = held;
    }
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!held || !scroller || !content) return;
    const movement = scroller.scrollTop - held.top;
    held.position = { ...held.position, offset: held.position.offset - movement, scrollTop: scroller.scrollTop };
    if (held.point) held.point.offset -= movement;
    if (!layoutChanged(held, sourceHeadRef.current) && !isTranscriptReadingAnchorVisible(scroller, content, held.position)) {
      const position = captureTranscriptReadingPosition(scroller, content, false, held.windowSize, tailMessageId);
      if (position) { held.position = position; held.point = contentPoint(scroller, content, position); }
    }
    if (!layoutChanged(held, sourceHeadRef.current) && (!held.point?.element.isConnected ||
      held.point.offset >= scroller.clientHeight || held.point.offset + held.point.element.getBoundingClientRect().height <= 0)) {
      held.point = contentPoint(scroller, content, held.position);
    }
    held.top = scroller.scrollTop;
  }, [captureHold, contentRef, readingHold, scrollRef, tailMessageId]);
  const restore = useCallback(() => {
    const held = readingHold();
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!held || !scroller || !content) return false;
    track();
    const before = scroller.scrollTop;
    const changed = layoutChanged(held, sourceHeadRef.current);
    if (held.point?.element.isConnected) {
      const delta = held.point.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - held.point.offset;
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      const row = messageRow(content, held.position);
      if (row) held.position = { ...held.position, offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
    } else restoreTranscriptReadingPosition(scroller, content, held.position);
    held.height = scroller.scrollHeight;
    held.viewport = scroller.clientHeight;
    held.alignedHead = sourceHeadRef.current;
    held.top = scroller.scrollTop;
    if (Math.abs(scroller.scrollTop - before) > 1) held.stableFrames = 0;
    callbacks.current.onPosition(scroller.scrollTop);
    return changed || Math.abs(scroller.scrollTop - before) > 0.5;
  }, [contentRef, readingHold, scrollRef, track]);

  const run = useCallback((action: () => void | Promise<void>, windowSize: number, page = false) => {
    if (holdRef.current || inFlightRef.current || autoBlockedRef.current) return;
    const hold = captureHold(windowSize, page);
    if (!hold) return;
    holdRef.current = hold;
    inFlightRef.current = true;
    callbacks.current.onStart();
    setPhase(page ? "page" : "mount");
    const startedAt = performance.now();
    const finish = () => {
      inFlightRef.current = false;
      if (holdRef.current !== hold) return;
      if (page) latencyRef.current = Math.min(2000, Math.max(latencyRef.current * 0.75, performance.now() - startedAt));
      hold.settled = true;
      refresh(value => value + 1);
    };
    try {
      const result = action();
      void Promise.resolve(result).then(finish, (error: unknown) => {
        if (holdRef.current === hold) autoBlockedRef.current = true;
        finish();
        console.error("Transcript history page failed", error);
      });
    } catch (error) {
      if (holdRef.current === hold) autoBlockedRef.current = true;
      finish();
      console.error("Transcript history page failed", error);
    }
  }, [captureHold]);

  useLayoutEffect(() => {
    if (!visible) { cancel(); return; }
    restore();
    const hold = holdRef.current;
    if (!hold || frameRef.current) return;
    const align = () => {
      frameRef.current = 0;
      if (holdRef.current !== hold) return;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const before = scroller.scrollTop;
      restore();
      const changed = Math.abs(scroller.scrollTop - before) > 1;
      hold.stableFrames = hold.settled && !changed ? hold.stableFrames + 1 : 0;
      if (hold.stableFrames >= 3) {
        if (hold.page && hold.sourceHead === sourceHeadRef.current) autoBlockedRef.current = true;
        dropHold();
        readingRef.current = hold;
        setPhase("idle");
        callbacks.current.onSettled();
        return;
      }
      frameRef.current = requestAnimationFrame(align);
    };
    frameRef.current = requestAnimationFrame(align);
  });

  useLayoutEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller) return;
    const observer = new ResizeObserver(() => {
      const held = readingHold();
      if (!held) return;
      const before = scroller.scrollTop;
      restore();
      if (Math.abs(scroller.scrollTop - before) > 1) held.stableFrames = 0;
    });
    observer.observe(content, { box: "border-box" });
    observer.observe(scroller, { box: "border-box" });
    resizeRef.current = observer;
    return () => { observer.disconnect(); resizeRef.current = null; observedRowsRef.current.clear(); };
  }, [contentRef, readingHold, restore, scrollRef]);

  // Row boxes catch opposing changes even when total content height is stable.
  useLayoutEffect(() => {
    const observer = resizeRef.current;
    const content = contentRef.current;
    if (!observer || !content) return;
    const rows = new Set(content.querySelectorAll<HTMLElement>("[data-message-id], [data-minimap-id]"));
    for (const row of observedRowsRef.current) if (!rows.has(row)) observer.unobserve(row);
    for (const row of rows) if (!observedRowsRef.current.has(row)) observer.observe(row, { box: "border-box" });
    observedRowsRef.current = rows;
  });
  useLayoutEffect(() => () => dropHold(), [dropHold]);

  return { loadingOlder: phase === "page", pending: phase !== "idle", run, restore, isHeld, track, cancel, retry, readLatency };
}
