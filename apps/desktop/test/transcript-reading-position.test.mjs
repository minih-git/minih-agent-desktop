import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  captureTranscriptReadingPosition,
  getTranscriptReadingPosition,
  readingBookmarkTail,
  sessionReadingState,
  transcriptReadingPositionIsStale,
} = await import("../src/lib/transcript-reading-position.ts");
const { TRANSCRIPT_REPIN_THRESHOLD_PX } = await import(
  "../src/lib/transcript-scroll.ts"
);

/** A scroller with a layout box; `content` is only read when unpinned. */
function scroller({ scrollTop, scrollHeight = 2_000, clientHeight = 500 }) {
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => ({ top: 0, bottom: clientHeight, height: clientHeight }),
  };
}

function contentWithRow(id, top) {
  return {
    querySelectorAll: () => [
      { dataset: { messageId: id }, getBoundingClientRect: () => ({ top, bottom: top + 40, height: 40 }) },
    ],
  };
}

test("a session left at the bottom keeps a pinned bookmark even after follow was released", () => {
  const content = contentWithRow("old-row", 100);
  // Follow mode was released by a disclosure interaction, but the viewport is
  // still at the tail: the bookmark must stay pinned, or the next visit restores
  // a mid-history page instead of the newest turn.
  const atBottom = captureTranscriptReadingPosition(
    scroller({ scrollTop: 1_500 }),
    content,
    false,
    80,
    "tail-1",
  );
  assert.deepEqual(atBottom, { pinned: true, offset: 0, scrollTop: 1_500, windowSize: 80, tailMessageId: "tail-1" });
  const insideBand = captureTranscriptReadingPosition(
    scroller({ scrollTop: 1_500 - (TRANSCRIPT_REPIN_THRESHOLD_PX - 1) }),
    content,
    false,
    80,
    "tail-1",
  );
  assert.equal(insideBand.pinned, true);
});

test("a session actually scrolled up keeps its row and offset", () => {
  const position = captureTranscriptReadingPosition(
    scroller({ scrollTop: 400 }),
    contentWithRow("row-42", 100),
    false,
    80,
    "tail-1",
  );
  assert.deepEqual(position, {
    pinned: false,
    messageId: "row-42",
    offset: 100,
    scrollTop: 400,
    windowSize: 80,
    tailMessageId: "tail-1",
  });
});

test("#A100 a bookmark captured before the session grew is stale at reveal", () => {
  const taken = captureTranscriptReadingPosition(
    scroller({ scrollTop: 400 }),
    contentWithRow("row-42", 100),
    false,
    80,
    "m-old-tail",
  );
  assert.ok(taken, "an unpinned viewport must capture a bookmark");
  assert.equal(taken.tailMessageId, "m-old-tail");
  // The session kept running while the pane was hidden: its tail moved on.
  assert.equal(transcriptReadingPositionIsStale(taken, "m-new-tail"), true);
  // Reading a session that has not moved restores normally.
  assert.equal(transcriptReadingPositionIsStale(taken, "m-old-tail"), false);
  // A pinned bookmark is always current: the bottom is the newest turn.
  const atBottom = captureTranscriptReadingPosition(
    scroller({ scrollTop: 1_500 }),
    contentWithRow("row-42", 100),
    false,
    80,
    "m-old-tail",
  );
  assert.equal(atBottom?.pinned, true);
  assert.equal(atBottom && transcriptReadingPositionIsStale(atBottom, "m-new-tail"), false);
  // Bookmarks without a tail anchor (older in-memory state, tests) and
  // transcripts without rows keep the previous restore behavior.
  assert.equal(
    transcriptReadingPositionIsStale({ ...taken, tailMessageId: undefined }, "m-new-tail"),
    false,
  );
  assert.equal(transcriptReadingPositionIsStale(taken, undefined), false);
});

test("an unpinned bookmark owns reveal even when follow still reads pinned", async () => {
  const { transcriptRevealOwnership } = await import("../src/lib/transcript-reading-position.ts");
  const bookmark = { pinned: false, messageId: "kept", offset: 24, scrollTop: 480, windowSize: 80 };
  assert.equal(transcriptRevealOwnership(bookmark, false, true), "reading-position");
  assert.equal(transcriptRevealOwnership(undefined, true, true), "reading-position");
  assert.equal(transcriptRevealOwnership(undefined, false, true), "pinned");
  assert.equal(transcriptRevealOwnership(undefined, false, false), "retained");
});

test("a hidden or unmetered scroller never replaces a bookmark", () => {
  assert.equal(
    captureTranscriptReadingPosition(scroller({ scrollTop: 0, clientHeight: 0 }), null, true, 80, "tail-1"),
    undefined,
  );
  sessionReadingState("s").position = {
    pinned: false,
    messageId: "kept",
    offset: 10,
    scrollTop: 400,
    windowSize: 80,
  };
  assert.equal(getTranscriptReadingPosition("s").messageId, "kept");
});

test("a layout sample keeps the tail of the reader's own reading operation", () => {
  // A pinned bookmark always records the live tail: the bottom is the newest turn.
  assert.equal(readingBookmarkTail({
    pinned: true, readingTailMessageId: "m-read", previousTailMessageId: "m-older", liveTailMessageId: "m-live",
  }), "m-live");
  // The reader's own operation re-anchors the bookmark to the tail it saw.
  assert.equal(readingBookmarkTail({
    pinned: false, readingTailMessageId: "m-read", previousTailMessageId: "m-older", liveTailMessageId: "m-live",
  }), "m-read");
  // Pure layout re-sampling (a ResizeObserver frame, a gesture-less scroll
  // event, a follow correction) keeps the anchor the bookmark already has.
  assert.equal(readingBookmarkTail({
    pinned: false, readingTailMessageId: undefined, previousTailMessageId: "m-kept", liveTailMessageId: "m-live",
  }), "m-kept");
  // The first unpinned sample of a session has no anchor to keep.
  assert.equal(readingBookmarkTail({
    pinned: false, readingTailMessageId: undefined, previousTailMessageId: undefined, liveTailMessageId: "m-live",
  }), "m-live");
});

test("a released follow stays stale while the reply it was released in keeps growing", () => {
  // Expanding a tool row mid-reply anchors the bookmark to the tail in view.
  const released = captureTranscriptReadingPosition(
    scroller({ scrollTop: 400 }),
    contentWithRow("m-prompt", 100),
    false,
    80,
    readingBookmarkTail({
      pinned: false, readingTailMessageId: "m-tool", previousTailMessageId: "m-tool", liveTailMessageId: "m-tool",
    }),
  );
  assert.equal(released.tailMessageId, "m-tool");
  // The reply finished below the reader. Every later layout sample must keep the
  // original anchor, or the bookmark claims the finished reply as current and
  // reopening the session restores the page around the prompt instead.
  const resampled = {
    ...released,
    scrollTop: 400,
    tailMessageId: readingBookmarkTail({
      pinned: false, readingTailMessageId: undefined, previousTailMessageId: released.tailMessageId,
      liveTailMessageId: "m-answer",
    }),
  };
  assert.equal(resampled.tailMessageId, "m-tool");
  assert.equal(transcriptReadingPositionIsStale(resampled, "m-answer"), true);
  // A reply that ended before the bookmarked reading still restores.
  assert.equal(transcriptReadingPositionIsStale(resampled, "m-tool"), false);
});
