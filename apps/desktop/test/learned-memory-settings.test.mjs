import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  DEFAULT_DAILY_TOKEN_BUDGET,
  MAX_DAILY_TOKEN_BUDGET,
  dailyTokenBudget,
  extractionEnabled,
  extractionModelOptions,
  extractionPaused,
  localDay,
} = await import("../src/lib/learned-memory-extraction.ts");

// ADR agent-long-term-memory §4 and D668 item 1: learning is off by default,
// cannot be on without a model, and its settings are device-local. These are
// the decisions the Settings rows make, tested without rendering them.

test("learning is off unless the switch is on and a model is chosen", () => {
  assert.equal(extractionEnabled({ learnedMemory: { model: "p1/m1" } }), false);
  assert.equal(extractionEnabled({ learnedMemory: { learn: true } }), false);
  assert.equal(extractionEnabled({ learnedMemory: { learn: true, model: "   " } }), false);
  assert.equal(extractionEnabled({ learnedMemory: { learn: true, model: "p1/m1" } }), true);
  assert.equal(extractionEnabled({}), false);
});

test("an unusable ceiling falls back to the documented default", () => {
  assert.equal(dailyTokenBudget({}), DEFAULT_DAILY_TOKEN_BUDGET);
  assert.equal(
    dailyTokenBudget({ learnedMemory: { dailyTokenBudget: Number.NaN } }),
    DEFAULT_DAILY_TOKEN_BUDGET,
  );
  // Zero would silently disable the feature rather than budget it.
  assert.equal(dailyTokenBudget({ learnedMemory: { dailyTokenBudget: 0 } }), DEFAULT_DAILY_TOKEN_BUDGET);
  assert.equal(dailyTokenBudget({ learnedMemory: { dailyTokenBudget: 1 } }), DEFAULT_DAILY_TOKEN_BUDGET);
  assert.equal(dailyTokenBudget({ learnedMemory: { dailyTokenBudget: 50_000 } }), 50_000);
  assert.equal(
    dailyTokenBudget({ learnedMemory: { dailyTokenBudget: 99_999_999 } }),
    MAX_DAILY_TOKEN_BUDGET,
  );
});

test("only a provider this machine can actually call is offered", () => {
  const options = extractionModelOptions([
    {
      id: "ready",
      name: "Ready provider",
      enabled: true,
      hasSecret: true,
      models: [{ id: "m1", alias: "Fast" }],
    },
    { id: "oauth", name: "OAuth", enabled: true, hasOauth: true, models: [{ id: "m2" }] },
    { id: "open", name: "Open", enabled: true, authKind: "none", models: [{ id: "m3" }] },
    { id: "nokey", name: "No key", enabled: true, models: [{ id: "m4" }] },
    { id: "off", name: "Off", enabled: false, hasSecret: true, models: [{ id: "m5" }] },
  ]);
  assert.deepEqual(
    options.map((option) => option.id),
    ["ready/m1", "oauth/m2", "open/m3"],
  );
  assert.equal(options[0].label, "Fast (Ready provider)");
});

test("the counter is keyed by the user's own local day", () => {
  // Local, not UTC: the budget has to reset at the user's midnight, which is
  // the only midnight the Settings line can explain.
  assert.equal(localDay(new Date(2026, 9, 20, 23, 30)), "2026-10-20");
  assert.equal(localDay(new Date(2026, 0, 5, 0, 1)), "2026-01-05");
});

test("a spent budget pauses today and clears itself tomorrow", () => {
  const settings = { learnedMemory: { learn: true, model: "p1/m1", dailyTokenBudget: 1_000_000 } };
  // A full day pauses the feature...
  assert.equal(
    extractionPaused({ day: "2026-10-20", tokens: 1_000_000 }, settings, "2026-10-20"),
    true,
  );
  assert.equal(
    extractionPaused({ day: "2026-10-20", tokens: 999_999 }, settings, "2026-10-20"),
    false,
  );
  // ...and the next local day starts unspent, so no reset job is needed.
  assert.equal(
    extractionPaused({ day: "2026-10-20", tokens: 1_000_000 }, settings, "2026-10-21"),
    false,
  );
  assert.equal(extractionPaused(null, settings, "2026-10-20"), false);
});
