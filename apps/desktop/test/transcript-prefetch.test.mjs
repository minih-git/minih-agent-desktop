import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { isHistoryPrefetchPosition } = await import("../src/lib/transcript-scroll.ts");

test("prefetch leads a fast upward gesture using observed latency but stays bounded", () => {
  const geometry = { scrollTop: 5000, scrollHeight: 50000, clientHeight: 600 };
  assert.equal(isHistoryPrefetchPosition(geometry), false);
  assert.equal(isHistoryPrefetchPosition(geometry, false, { upwardSpeed: 20, latencyMs: 250 }), true);
  assert.equal(isHistoryPrefetchPosition({ ...geometry, scrollTop: 8000 }, false, { upwardSpeed: 500, latencyMs: 2000 }), false);
  assert.equal(isHistoryPrefetchPosition(geometry, true, { upwardSpeed: 20, latencyMs: 250 }), false);
  assert.equal(isHistoryPrefetchPosition({ ...geometry, clientHeight: 0 }, false, { upwardSpeed: 20, latencyMs: 250 }), false);
});
