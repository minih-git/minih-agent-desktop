import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { scrollReviewToAnchor } = await import("../src/lib/review-focus-request.ts");

test("review navigation only adjusts its own scroller and preserves focus ownership", () => {
  const scroller = {
    scrollTop: 100,
    querySelector: selector => selector === '[data-snapshot-id="snapshot"]' ? {
      getBoundingClientRect: () => ({ top: 350 }),
      scrollIntoView: () => assert.fail("ancestor scrolling must not run"),
    } : null,
    getBoundingClientRect: () => ({ top: 80 }),
  };
  scrollReviewToAnchor(scroller, '[data-snapshot-id="snapshot"]');
  assert.equal(scroller.scrollTop, 370);
  scrollReviewToAnchor(scroller, "missing");
  assert.equal(scroller.scrollTop, 370);
  scrollReviewToAnchor(null, "missing");
});
