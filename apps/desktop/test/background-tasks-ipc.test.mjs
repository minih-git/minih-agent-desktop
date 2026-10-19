import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@minih-agent/shared");
const { registerBackgroundTasksIpc } = await import("../electron/main/ipc/background-tasks-ipc.ts");

function fixture(host) {
  const handlers = new Map();
  registerBackgroundTasksIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
  });
  return (channel, payload) => handlers.get(channel)(payload);
}

test("background controls use the existing Host list/output/stop contracts", async () => {
  const calls = [];
  const result = { tasks: [{ id: "task-1", state: "running" }], version: 7 };
  const invoke = fixture({ call: async (...args) => { calls.push(args); return result; } });
  assert.deepEqual(await invoke(IPC.invoke.backgroundTasksList), result);
  assert.deepEqual(await invoke(IPC.invoke.backgroundTasksOutput, { id: "task-1" }), result);
  assert.deepEqual(await invoke(IPC.invoke.backgroundTasksStop, "task-1"), result);
  assert.deepEqual(calls, [
    ["backgroundTasks.list"],
    ["backgroundTasks.output", { id: "task-1" }],
    ["backgroundTasks.stop", { id: "task-1" }],
  ]);
});

test("background controls reject malformed identifiers before reaching the Host", () => {
  let calls = 0;
  const invoke = fixture({ call: () => { calls += 1; } });
  for (const channel of [IPC.invoke.backgroundTasksOutput, IPC.invoke.backgroundTasksStop]) {
    for (const payload of [undefined, null, {}, { id: "" }, { id: 2 }, { id: [] }, ""]) {
      assert.throws(() => invoke(channel, payload), /background task id required/);
    }
  }
  assert.equal(calls, 0);
});

test("missing Host and Host failures remain observable", async () => {
  const missing = fixture(null);
  assert.throws(() => missing(IPC.invoke.backgroundTasksList), /host unavailable/);
  const failed = fixture({ call: async () => { throw new Error("task not found"); } });
  await assert.rejects(failed(IPC.invoke.backgroundTasksOutput, { id: "missing" }), /task not found/);
});
