import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  captureTranscriptReadingPosition,
  getTranscriptReadingPosition,
  sessionReadingState,
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
  );
  assert.deepEqual(atBottom, { pinned: true, offset: 0, scrollTop: 1_500, windowSize: 80 });
  const insideBand = captureTranscriptReadingPosition(
    scroller({ scrollTop: 1_500 - (TRANSCRIPT_REPIN_THRESHOLD_PX - 1) }),
    content,
    false,
    80,
  );
  assert.equal(insideBand.pinned, true);
});

test("a session actually scrolled up keeps its row and offset", () => {
  const position = captureTranscriptReadingPosition(
    scroller({ scrollTop: 400 }),
    contentWithRow("row-42", 100),
    false,
    80,
  );
  assert.deepEqual(position, {
    pinned: false,
    messageId: "row-42",
    offset: 100,
    scrollTop: 400,
    windowSize: 80,
  });
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
    captureTranscriptReadingPosition(scroller({ scrollTop: 0, clientHeight: 0 }), null, true, 80),
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
