import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { IPC } from "@minih-agent/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerSideNotesIpc } = await import("../electron/main/ipc/side-notes-ipc.ts");

function fixture() {
  const calls = [];
  const handlers = new Map();
  let active = true;
  let answer;
  const notes = [];
  const host = { async call(method, params) {
    calls.push(method);
    if (method === "session.sideNotes.list") return { notes };
    if (method === "session.sideNotes.append") { notes.push(params.note); return { note: params.note }; }
    assert.fail(method);
  } };
  const sidecar = { async call(method, params) { calls.push(method); assert.equal(method, "agent.sideNote"); return await answer(params); } };
  registerSideNotesIpc({ registrar: { handle(channel, fn) { handlers.set(channel, fn); } }, getHost: () => host, getSidecar: () => sidecar, isTurnDispatchable: () => active });
  return { calls, notes, ask: handlers.get(IPC.invoke.agentSideNote), list: handlers.get(IPC.invoke.agentSideNotesList), setAnswer(fn) { answer = fn; }, end() { active = false; } };
}
const request = { sessionId: "session-a", expectedTurnId: "turn-a", content: "Question" };

test("independent answer stays outside steering/events and persists after main completion", async () => {
  const f = fixture();
  f.setAnswer(async params => { assert.equal(params.expectedTurnId, "turn-a"); f.end(); return { text: "Side answer" }; });
  const result = await f.ask(request);
  assert.equal(result.note.question, "Question");
  assert.equal(result.note.answer, "Side answer");
  assert.deepEqual(f.calls, ["session.sideNotes.list", "agent.sideNote", "session.sideNotes.append"]);
  assert.deepEqual((await f.list({ sessionId: "session-a" })).notes, [result.note]);
  await assert.rejects(f.ask(request), { errorCode: "TURN_NOT_FOUND" });
});

test("duplicate side questions are refused and failure releases admission without persistence", async () => {
  const f = fixture();
  let reject;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.setAnswer(() => { entered(); return new Promise((_, fail) => { reject = fail; }); });
  const pending = f.ask(request);
  await ready;
  await assert.rejects(f.ask(request), { errorCode: "AGENT_BUSY" });
  reject(new Error("provider unavailable"));
  await assert.rejects(pending, /provider unavailable/);
  assert.equal(f.notes.length, 0);
  f.setAnswer(async () => ({ text: "Retry answer" }));
  assert.equal((await f.ask(request)).note.answer, "Retry answer");
});

test("invalid, remote and native targets cannot start model requests", async () => {
  const f = fixture();
  for (const invalid of [null, {}, { ...request, content: "  " }, { ...request, sessionId: "remote:abc" }, { ...request, sessionId: "native-pi:abc" }]) {
    await assert.rejects(f.ask(invalid), { errorCode: "INVALID_ARGUMENT" });
  }
  assert.deepEqual(f.calls, []);
});
