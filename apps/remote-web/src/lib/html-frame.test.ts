import { expect, it } from "vitest";

import {
  clampFrameHeight,
  HTML_FRAME_DEFAULT_HEIGHT,
  HTML_FRAME_MIN_HEIGHT,
  readFrameHeight,
  withHeightReporting,
} from "./html-frame.js";

it("believes only a height report shaped the way the frame sends it", () => {
  expect(readFrameHeight({ type: "minih:html-height", height: 612.4 })).toBe(612);
  // A preview is untrusted content: a message that is not a measurement, or
  // claims an impossible one, must not become a style.
  expect(readFrameHeight({ type: "minih:html-height", height: -1 })).toBeNull();
  expect(readFrameHeight({ type: "minih:html-height", height: 0 })).toBeNull();
  expect(readFrameHeight({ type: "minih:html-height", height: Number.NaN })).toBeNull();
  expect(readFrameHeight({ type: "minih:html-height", height: Number.POSITIVE_INFINITY })).toBeNull();
  expect(readFrameHeight({ type: "minih:html-height", height: "612" })).toBeNull();
  expect(readFrameHeight({ type: "something-else", height: 612 })).toBeNull();
  expect(readFrameHeight("612")).toBeNull();
  expect(readFrameHeight(null)).toBeNull();
});

it("clamps a reported height between a readable minimum and 70% of the screen", () => {
  // 844px is a phone this client targets: a short page still reads as a card,
  // and a long one scrolls inside the frame instead of pushing the transcript.
  expect(clampFrameHeight(40, 844)).toBe(HTML_FRAME_MIN_HEIGHT);
  expect(clampFrameHeight(1200, 844)).toBe(Math.round(844 * 0.7));
  expect(clampFrameHeight(500, 844)).toBe(500);
  // A viewport too short for 70% still leaves the frame at its minimum.
  expect(clampFrameHeight(900, 120)).toBe(HTML_FRAME_MIN_HEIGHT);
});

it("adds the measuring script once, last in the body", () => {
  const prepared = withHeightReporting("<html><body><p>hi</p></body></html>");
  expect(prepared.indexOf('id="minih-html-height"')).toBeGreaterThan(prepared.indexOf("<p>hi</p>"));
  expect(prepared.indexOf("</body>")).toBeGreaterThan(prepared.indexOf('id="minih-html-height"'));
  expect(prepared).toContain("ResizeObserver");
  // Running it over its own output must not stack a second observer.
  expect(withHeightReporting(prepared)).toBe(prepared);
});

it("appends the script to a fragment that has no body element", () => {
  const prepared = withHeightReporting("<div>fragment</div>");
  expect(prepared.startsWith("<div>fragment</div>")).toBe(true);
  expect(prepared).toContain('id="minih-html-height"');
});

it("defaults to the height the card always had before it reports", () => {
  // The measured height replaces this; until the first report, the preview must
  // not collapse to nothing while the frame loads.
  expect(HTML_FRAME_DEFAULT_HEIGHT).toBe(420);
});
