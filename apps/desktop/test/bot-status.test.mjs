import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The two rules a supervisor can observe (ADR bot-sessions-and-steward §4):
 * which dot an employee's stage paints, and that only `person/*` is loud.
 * Plain data and pure functions, so no renderer or host is involved.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { botStatusView, sortBots, botInitials, isStewardSession } = await import(
  "../src/features/bots/bot-status.ts"
);

test("person stages are the only attention dot", () => {
  for (const stage of ["person/answer", "person/accept"]) {
    const view = botStatusView({ kind: "stage", stage });
    assert.equal(view.tone, "attention", stage);
    assert.equal(view.labelKey, "bots.status.attention");
    assert.equal(view.attention, true);
  }
  for (const stage of ["working", "queued", "waiting", "blocked", "failed"]) {
    const view = botStatusView({ kind: "stage", stage });
    assert.notEqual(view.tone, "attention", stage);
    assert.equal(view.attention, false, stage);
  }
});

test("every stage maps to its own readable word", () => {
  assert.equal(botStatusView({ kind: "stage", stage: "working" }).labelKey, "bots.status.busy");
  assert.equal(botStatusView({ kind: "stage", stage: "queued" }).labelKey, "bots.status.queued");
  assert.equal(botStatusView({ kind: "stage", stage: "waiting" }).labelKey, "bots.status.queued");
  assert.equal(botStatusView({ kind: "stage", stage: "blocked" }).labelKey, "bots.status.blocked");
  assert.equal(botStatusView({ kind: "stage", stage: "failed" }).labelKey, "bots.status.blocked");
});

test("idle, offline and a missing status each render", () => {
  assert.deepEqual(botStatusView({ kind: "idle" }), {
    tone: "idle",
    labelKey: "bots.status.idle",
    attention: false,
  });
  assert.deepEqual(botStatusView({ kind: "offline" }), {
    tone: "offline",
    labelKey: "bots.status.offline",
    attention: false,
  });
  // An older host that omits `status` must not blank the row.
  assert.equal(botStatusView(undefined).tone, "idle");
});

test("the roster puts whoever is waiting on the person first", () => {
  const bot = (sessionId, status) => ({ sessionId, status });
  const sorted = sortBots([
    bot("idle", { kind: "idle" }),
    bot("working", { kind: "stage", stage: "working" }),
    bot("waiting", { kind: "stage", stage: "person/accept" }),
    bot("offline", { kind: "offline" }),
    bot("blocked", { kind: "stage", stage: "blocked" }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.sessionId),
    ["waiting", "blocked", "working", "idle", "offline"],
  );
});

test("equal tones keep the host's order", () => {
  const bot = (sessionId) => ({ sessionId, status: { kind: "stage", stage: "working" } });
  const sorted = sortBots([bot("a"), bot("b"), bot("c")]);
  assert.deepEqual(sorted.map((item) => item.sessionId), ["a", "b", "c"]);
});

test("the avatar falls back to the first character of the name", () => {
  assert.equal(botInitials("阿福"), "阿");
  assert.equal(botInitials("  fixer "), "F");
  assert.equal(botInitials(""), "?");
});

test("only a steward bot offers the task-card dock", () => {
  assert.equal(isStewardSession({ role: "bot", botProfile: { definition: "steward" } }), true);
  assert.equal(isStewardSession({ role: "bot", botProfile: { definition: "fixer" } }), false);
  assert.equal(isStewardSession({ role: "bot" }), false);
  assert.equal(isStewardSession({ role: "bot", botProfile: { definition: "steward" } }), true);
  assert.equal(isStewardSession({ botProfile: { definition: "steward" } }), false);
  assert.equal(isStewardSession(undefined), false);
});
