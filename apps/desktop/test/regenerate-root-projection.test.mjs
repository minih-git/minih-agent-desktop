import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createEventsSlice } = await import("../src/stores/slices/events-slice.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { api } = await import("../src/lib/api.ts");
const sessionId = "regenerated-session";
const turnId = "latest-turn";
const root = { id: "rewritten-user", role: "user", content: "Older prompt", createdAt: "2026-10-20T06:14:11Z", status: "complete", revisionRootId: "original-user", revisionCount: 2, activeRevision: 2 };
const tail = [
  { id: "latest-user", role: "user", content: "Continue", createdAt: "2026-10-25T15:00:00Z", status: "complete" },
  { id: "latest-answer", role: "assistant", content: "Latest reply", createdAt: "2026-10-25T15:04:05Z", status: "complete" },
];
function fixture({ active = true, includeRoot = false, hostCall } = {}) {
  const messages = includeRoot ? [{ ...root, revisionCount: 1, activeRevision: 1 }, ...tail] : tail;
  let state = { activeSessionId: active ? sessionId : "other", messages: active ? messages : [], retainedSessionIds: [sessionId], retainedTranscripts: { [sessionId]: messages }, runningSessions: {}, sessionHistory: {} };
  let runtime;
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      runtime?.syncTranscriptProjection(state, previous);
    },
  };
  runtime = createSessionRuntime(access);
  runtime.cacheSessionTranscript(sessionId, messages);
  Object.assign(state, createEventsSlice({ ...access, runtime }));
  const activeTurns = new Map([[sessionId, turnId]]);
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  coordination.recordTurnStart(sessionId, turnId);
  const warnings = [];
  const persistence = createEventPersistence({
    runtimeState: { host: { async call(method) {
      assert.equal(method, "session.saveActiveRevision");
      return hostCall ? hostCall() : { saved: { root } };
    } } },
    steeringReplies: new Set(), completionNoticeTurns: new Set(), activeTurns,
    activeToolCalls: new Map(), activeToolCallKey: coordination.activeToolCallKey,
    approvedExecutionIdsBySession: new Map(), approvedExecutionTurns: new Map(),
    pendingExecutionFinishes: new Map(), planSubmissionTurnIds: new Set(), planSubmissionTurnKey: coordination.planSubmissionTurnKey,
    inflightCheckpointer: { observe() {}, flush: async () => {}, settleIf() {} },
    persistenceOutbox: { size: () => 0, flush: async () => {} }, transcriptRewrite: coordination,
    addActiveTurnUsage() {}, logger: { app: (...args) => warnings.push(args) },
    finishTurn: async () => activeTurns.delete(sessionId), isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    finishApprovedExecution: async () => {}, emitAgentEvent: (event) => state.handleAgentEvent(event),
  });
  const complete = async () => {
    persistence.persistAgentEvent({ sessionId, turnId, ts: 1, event: { type: "agent_end", messageIds: [tail.at(-1).id] } });
    await persistence.flush();
    assert.deepEqual(warnings, []);
  };
  return { ...access, runtime, complete, messages };
}
for (const active of [true, false]) {
  for (const includeRoot of [false, true]) {
    test(`revision acknowledgement preserves ${active ? "active" : "retained"} window; root loaded=${includeRoot}`, async () => {
      const f = fixture({ active, includeRoot });
      await f.complete();
      for (const rows of [f.runtime.sessionTranscriptCache.get(sessionId), f.get().retainedTranscripts[sessionId], ...(active ? [f.get().messages] : [])]) {
        assert.deepEqual(rows.map((row) => row.id), f.messages.map((row) => row.id));
        if (includeRoot) assert.deepEqual(rows[0], root);
      }
    });
  }
}
test("late archive acknowledgement cannot resurrect a deleted root", async () => {
  const started = Promise.withResolvers(); const response = Promise.withResolvers();
  const f = fixture({ includeRoot: true, hostCall: () => { started.resolve(); return response.promise; } });
  const completion = f.complete(); await started.promise;
  f.set({ messages: tail }); response.resolve({ saved: { root } }); await completion;
  assert.deepEqual(f.get().messages, tail);
  assert.deepEqual(f.runtime.sessionTranscriptCache.get(sessionId), tail);
});
test("unloaded background acknowledgement does not prevent a later prefetch", async () => {
  const f = fixture({ active: false });
  f.runtime.sessionTranscriptCache.delete(sessionId); f.set({ retainedTranscripts: {} });
  const original = api.getSession; const reads = [];
  api.getSession = async (id) => { reads.push(id); return { session: { id, messages: tail, messageCount: tail.length } }; };
  try {
    await f.complete();
    assert.equal(f.runtime.sessionTranscriptCache.has(sessionId), false);
    assert.equal(f.runtime.liveSessionTranscripts.has(sessionId), false);
    await createSessionSlice({ get: f.get, set: f.set, runtime: f.runtime }).prefetchSession(sessionId);
    assert.deepEqual(reads, [sessionId]);
    assert.deepEqual(f.runtime.sessionTranscriptCache.get(sessionId), tail);
  } finally { api.getSession = original; }
});
test("ordinary user message_end still appends accepted new prompts", () => {
  const f = fixture(); const message = { ...root, id: "new-user" };
  f.get().handleAgentEvent({ sessionId, ts: 2, event: { type: "message_end", message } });
  assert.deepEqual(f.get().messages, [...tail, message]);
});
