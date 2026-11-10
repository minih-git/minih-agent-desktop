import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptLatestNavigation } = await import("../src/lib/transcript-latest-navigation.ts");

function fixture(reduced = false) {
  const box = { scrollTop: 80, scrollHeight: 8000, clientHeight: 600 };
  const moves = [];
  const listeners = new Set();
  let arrivals = 0;
  let stops = 0;
  const navigation = createTranscriptLatestNavigation({
    geometry: () => box,
    move: (top, behavior) => { moves.push({ top, behavior }); if (behavior !== "smooth") box.scrollTop = top; },
    onScrollEnd: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    stop: () => stops++,
    reducedMotion: () => reduced,
  });
  const finish = (top = moves.at(-1)?.top) => {
    box.scrollTop = top;
    for (const listener of [...listeners]) listener();
  };
  return { box, navigation, moves, listeners, finish, stops: () => stops,
    start: () => navigation.start(() => arrivals++), arrivals: () => arrivals };
}

test("latest requests one native smooth trip and commits only at scrollend", () => {
  const f = fixture();
  f.start();
  assert.deepEqual(f.moves, [{ top: 7400, behavior: "smooth" }]);
  assert.equal(f.box.scrollTop, 80);
  assert.equal(f.arrivals(), 0);
  f.finish();
  assert.equal(f.arrivals(), 1);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.navigation.isActive(), false);
});

test("late layout growth retargets at native settlement before committing", () => {
  const f = fixture(); f.start();
  f.box.scrollHeight += 800;
  f.finish(7400);
  assert.equal(f.arrivals(), 0);
  assert.deepEqual(f.moves.at(-1), { top: 8200, behavior: "smooth" });
  f.finish();
  assert.equal(f.arrivals(), 1);
});

test("reader interruption stops travel and retires old scrollend listeners", () => {
  const f = fixture(); f.start();
  const stale = [...f.listeners][0];
  f.box.scrollTop = 400;
  f.navigation.cancel(); stale();
  assert.equal(f.box.scrollTop, 400);
  assert.equal(f.arrivals(), 0);
  assert.equal(f.stops(), 1);
  assert.equal(f.listeners.size, 0);
});

test("pane hide commits accepted latest intent exactly once", () => {
  const f = fixture(); f.start(); f.navigation.cancel(true); f.navigation.cancel(true);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.listeners.size, 0);
});

test("repeated navigation cannot commit an obsolete trip", () => {
  const f = fixture(); f.start(); const stale = [...f.listeners][0];
  f.start(); stale(); assert.equal(f.arrivals(), 0);
  f.finish(); assert.equal(f.arrivals(), 1);
});

test("reduced motion reaches the measured bottom synchronously", () => {
  const f = fixture(true); f.start();
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.listeners.size, 0);
});
