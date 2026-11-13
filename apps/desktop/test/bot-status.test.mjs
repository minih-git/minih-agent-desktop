import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

/*
 * The two rules a supervisor can observe (ADR bot-sessions-and-steward §4, and
 * the amendment in "Waiting channel and blocked card"): which dot an employee's
 * stage paints, and that a task the person has to act on is loud — a question,
 * finished work, or a task that got stuck. Plain data and pure functions, so no
 * renderer or host is involved.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { botStatusView, botStatusFromTasks, sortBots, botInitials, isStewardSession, taskStatusTone } =
  await import("../src/features/bots/bot-status.ts");

test("a task the person has to act on is the attention dot", () => {
  // `person/*` was the whole list until slice 4a. A blocked or failed task joined
  // it: "the employee's own quieter business" is exactly why a stuck task could
  // sit in the sidebar unnoticed.
  for (const stage of ["person/answer", "person/accept", "blocked", "failed"]) {
    const view = botStatusView({ kind: "stage", stage });
    assert.equal(view.tone, "attention", stage);
    assert.equal(view.labelKey, "bots.status.attention");
    assert.equal(view.attention, true);
  }
  // Nothing is wrong and nobody is waiting: these stay quiet.
  for (const stage of ["working", "queued", "waiting"]) {
    const view = botStatusView({ kind: "stage", stage });
    assert.notEqual(view.tone, "attention", stage);
    assert.equal(view.attention, false, stage);
  }
});

test("every stage maps to its own readable word", () => {
  assert.equal(botStatusView({ kind: "stage", stage: "working" }).labelKey, "bots.status.busy");
  assert.equal(botStatusView({ kind: "stage", stage: "queued" }).labelKey, "bots.status.queued");
  assert.equal(botStatusView({ kind: "stage", stage: "waiting" }).labelKey, "bots.status.queued");
  // A stuck task reads as the person's turn, because it is one.
  assert.equal(botStatusView({ kind: "stage", stage: "blocked" }).labelKey, "bots.status.attention");
  assert.equal(botStatusView({ kind: "stage", stage: "failed" }).labelKey, "bots.status.attention");
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

test("a stuck task makes its employee the one to look at first", () => {
  // The same order the host's `task_status_point` uses: whatever the person has
  // to act on wins over merely being busy, however it stopped.
  assert.deepEqual(botStatusFromTasks([{ stage: "blocked" }]), {
    kind: "stage",
    stage: "blocked",
  });
  assert.deepEqual(botStatusFromTasks([{ stage: "working" }, { stage: "failed" }]), {
    kind: "stage",
    stage: "failed",
  });
  assert.deepEqual(botStatusFromTasks([{ stage: "working" }]), {
    kind: "stage",
    stage: "working",
  });
  assert.deepEqual(botStatusFromTasks([]), { kind: "idle" });
});

test("an accepted task stops making its employee look like it is waiting", () => {
  // Slice 4b: the person already said the work is fine. Counting it kept the row
  // orange with a red dot after the one click that ended the wait.
  const accepted = { stage: "person/accept", acceptedAt: "2026-11-14T02:00:00.000Z" };
  assert.deepEqual(botStatusFromTasks([accepted]), { kind: "idle" });
  // A task that has not been accepted still is the person's.
  assert.deepEqual(botStatusFromTasks([{ stage: "person/accept" }]), {
    kind: "stage",
    stage: "person/accept",
  });
  // Accepting one task does not hide a second one that is still waiting.
  assert.deepEqual(botStatusFromTasks([accepted, { stage: "person/answer" }]), {
    kind: "stage",
    stage: "person/answer",
  });
  // And its own row is no longer painted as attention.
  assert.equal(taskStatusTone(accepted), "idle");
  assert.equal(taskStatusTone({ stage: "person/accept" }), "attention");
});
