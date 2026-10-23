import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const SESSION = "s1";
const TURN = "turn-1";

function fixture() {
  const activeTurns = new Map([[SESSION, TURN]]);
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  coordination.recordTurnStart(SESSION, TURN);
  const enqueued = [];
  const steeringReplies = new Set();
  const completionNoticeTurns = new Set();
  const persistence = createEventPersistence({
    runtimeState: { host: null }, steeringReplies, completionNoticeTurns, activeTurns,
    activeToolCalls: new Map(), activeToolCallKey: coordination.activeToolCallKey,
    approvedExecutionIdsBySession: new Map(), approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(), planSubmissionTurnIds: new Set(),
    planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: { observe() {}, flush: async () => {}, settleIf() {} },
    persistenceOutbox: { size: () => 0, enqueue: async (entry) => { enqueued.push(entry); }, flush: async () => {} },
    addActiveTurnUsage() {}, logger: { app() {} }, finishTurn: async () => {},
    isStaleTerminalEvent: coordination.isStaleTerminalEvent, transcriptRewrite: coordination,
    finishApprovedExecution: async () => {}, emitAgentEvent() {},
  });
  const event = (event, extra = {}) => persistence.persistAgentEvent({ sessionId: SESSION, turnId: TURN, ts: 1, event, ...extra });
  const assistant = (message, extra) => event({ type: "message_end", message: {
    id: "reply", role: "assistant", createdAt: "2026-10-23T00:00:00.000Z", content: "", status: "complete", ...message,
  } }, extra);
  return { enqueued, steeringReplies, completionNoticeTurns, coordination, event, assistant };
}

for (const status of ["complete", "error", "aborted"]) {
  test(`an empty ordinary ${status} assistant row is not persisted`, () => {
    const f = fixture(); f.assistant({ status });
    assert.equal(f.enqueued.length, 0);
  });
}
for (const [name, fields] of [
  ["tool", { toolName: "Read", toolCallId: "call-1" }],
  ["error", { status: "error", error: { code: "PROVIDER_ERROR", message: "failure" } }],
  ["text", { content: "reply" }], ["reasoning", { thinking: "reasoning" }],
]) {
  test(`a ${name} assistant row remains durable`, () => {
    const f = fixture(); f.assistant(fields);
    assert.equal(f.enqueued.length, 1);
  });
}
test("an accepted steering placeholder remains durable", () => {
  const f = fixture(); f.steeringReplies.add("reply"); f.assistant({});
  assert.equal(f.enqueued.length, 1);
});
test("a trusted completion notice permits exactly one silent completed reply", () => {
  const f = fixture(); f.completionNoticeTurns.add(TURN);
  f.assistant({}); f.assistant({ id: "second" });
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});
test("a visible or tool reply spends the completion exception", () => {
  for (const fields of [{ content: "done" }, { toolName: "Read", toolCallId: "call-1" }]) {
    const f = fixture(); f.completionNoticeTurns.add(TURN);
    f.assistant(fields); f.assistant({ id: "second" });
    assert.equal(f.enqueued.length, 1);
    assert.equal(f.completionNoticeTurns.has(TURN), false);
  }
});
test("retry failures and child replies do not spend the parent completion exception", () => {
  const f = fixture(); f.completionNoticeTurns.add(TURN);
  f.assistant({ status: "error", error: { code: "PROVIDER_ERROR", message: "retry" } });
  f.assistant({ id: "child", content: "child answer" }, { parentToolCallId: "task-1" });
  assert.equal(f.completionNoticeTurns.has(TURN), true);
  f.assistant({ id: "completed" });
  assert.equal(f.enqueued.length, 3);
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});
test("user steering revokes the silent completion exception", () => {
  const f = fixture(); f.completionNoticeTurns.add(TURN);
  f.event({ type: "message_end", message: { id: "steer", role: "user", content: "continue", steering: true } });
  f.assistant({});
  assert.equal(f.completionNoticeTurns.has(TURN), false);
  assert.equal(f.enqueued.length, 1);
});
test("terminal and stale events clear unused completion allowances", () => {
  for (const terminal of [{ type: "agent_end", messageIds: [] }, { type: "error", error: { code: "TURN_ABORTED", message: "stop" } }]) {
    const f = fixture(); f.completionNoticeTurns.add(TURN); f.event(terminal);
    assert.equal(f.completionNoticeTurns.has(TURN), false);
  }
  const f = fixture(); f.completionNoticeTurns.add(TURN);
  f.coordination.beginTranscriptRewrite(SESSION).commit(); f.assistant({});
  assert.equal(f.enqueued.length, 0);
  assert.equal(f.completionNoticeTurns.has(TURN), false);
});
