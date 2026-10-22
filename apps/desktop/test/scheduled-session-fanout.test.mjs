import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@minih-agent/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerScheduledIpc } = await import("../electron/main/ipc/scheduled-ipc.ts");

function wire(host) {
  const handlers = new Map();
  const events = [];
  const runs = new Map();
  const invokes = [];
  registerScheduledIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    scheduledRunsBySession: runs,
    invoke: async (channel, args) => {
      invokes.push([channel, args]);
    },
    isQuitting: () => false,
    sendToRenderer: (channel, value) => events.push([channel, value]),
  });
  return { handlers, events, runs, invokes };
}

test("an admitted run announces the session it created", async () => {
  const { handlers, events, runs, invokes } = wire({
    async call(method) {
      assert.equal(method, "scheduled.run");
      return { sessionId: "session-1", runId: "run-1", prompt: "Inspect project" };
    },
  });

  const launch = await handlers.get(IPC.invoke.scheduledExecute)("task-1", true);

  assert.deepEqual(launch, {
    sessionId: "session-1",
    runId: "run-1",
    prompt: "Inspect project",
  });
  assert.deepEqual(invokes, [
    [IPC.invoke.agentPrompt, [{ sessionId: "session-1", content: "Inspect project" }]],
  ]);
  assert.equal(runs.get("session-1"), "run-1");
  // The Activity feed only lists a run while it executes, so the sidebar has to
  // read the session the host just created before the row can appear.
  assert.deepEqual(events, [[IPC.event.sessionsChanged, { reason: "scheduled.run" }]]);
});

test("a refused dispatch announces no session", async () => {
  const { handlers, events, invokes } = wire({
    async call() {
      throw new Error("task is already running");
    },
  });

  await assert.rejects(
    handlers.get(IPC.invoke.scheduledExecute)("task-1", true),
    /already running/,
  );
  assert.deepEqual(invokes, []);
  assert.deepEqual(events, []);
});
