import assert from "node:assert/strict";
import test from "node:test";
import { createFrameBatcher } from "../src/lib/frame-batcher.ts";

test("frame batcher keeps the latest value for each stream target", () => {
  const batches = [];
  const batcher = createFrameBatcher((values) => {
    batches.push([...values]);
  });

  batcher.enqueue("message:a", "first");
  batcher.enqueue("message:a", "latest");
  batcher.enqueue("tool:b", "tool");
  assert.equal(batches.length, 0);

  batcher.flushNow();

  assert.deepEqual(batches, [["latest", "tool"]]);
  assert.equal(batcher.size, 0);
});

test("frame batcher flushes immediately without leaving a timer", () => {
  const batches = [];
  const batcher = createFrameBatcher((values) => batches.push([...values]));

  batcher.enqueue("message:a", 1);
  batcher.flushNow();
  batcher.flushNow();

  assert.deepEqual(batches, [[1]]);
  assert.equal(batcher.size, 0);
});

test("frame batcher can concatenate values for the same stream target", () => {
  const batches = [];
  const batcher = createFrameBatcher((values) => {
    batches.push([...values]);
  });

  batcher.enqueue("message:a", "Hel", (previous, next) => previous + next);
  batcher.enqueue("message:a", "lo", (previous, next) => previous + next);
  batcher.flushNow();

  assert.deepEqual(batches, [["Hello"]]);
});

test("frame batcher flushes through the timeout when rAF is starved", async () => {
  /*
    Headless CI (xvfb, hidden windows) never delivers a frame, so a batcher
    that only rides requestAnimationFrame strands streaming updates forever.
    Simulate the starvation: rAF exists but never fires.
  */
  const original = globalThis.requestAnimationFrame;
  const never = () => Number.MAX_SAFE_INTEGER;
  const timers = [];
  globalThis.requestAnimationFrame = never;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  try {
    const batches = [];
    const batcher = createFrameBatcher((values) => batches.push([...values]));
    batcher.enqueue("tool:a", "partial");

    assert.equal(batches.length, 0, "rAF path scheduled");
    assert.equal(timers.length, 1, "a fallback timeout was armed");
    assert.ok(timers[0].ms > 0, "fallback waits for real frames first");

    timers[0].fn();

    assert.deepEqual(batches, [["partial"]], "timeout flushes what rAF never did");
    assert.equal(batcher.size, 0);
    assert.equal(timers.length, 1, "the fallback timer is not re-armed after run");
  } finally {
    globalThis.requestAnimationFrame = original;
    globalThis.setTimeout = originalSetTimeout;
  }
});
