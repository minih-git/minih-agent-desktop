import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@minih-agent/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerMemoryIpc } = await import("../electron/main/memory/memory-ipc.ts");

// ADR agent-long-term-memory: the memory manager and the per-session learning
// switch cross into the host through one allowlisted channel each. The renderer
// never names a host method, and a malformed value fails before the pipe.
function harness({ host = true } = {}) {
  const handlers = new Map();
  const calls = [];
  registerMemoryIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () =>
      host
        ? {
            async call(method, params) {
              calls.push([method, params]);
              if (method === "memory.list") return { entries: [], scope: params.scope };
              if (method === "memory.update") return { entry: { id: params.id } };
              return { ok: true };
            },
          }
        : null,
  });
  return { handlers, calls };
}

test("each memory channel forwards exactly one host method", async () => {
  const { handlers, calls } = harness();
  const list = await handlers.get(IPC.invoke.memoryList)({ scope: "project", path: "/tmp/app" });
  assert.deepEqual(list, { entries: [], scope: "project" });
  assert.deepEqual(calls.at(-1), ["memory.list", { scope: "project", path: "/tmp/app" }]);

  // The user scope needs no project.
  await handlers.get(IPC.invoke.memoryList)({ scope: "user", status: "active", kind: "preference" });
  assert.deepEqual(calls.at(-1), [
    "memory.list",
    { scope: "user", status: "active", kind: "preference" },
  ]);

  await handlers.get(IPC.invoke.memoryUpdate)({
    id: "entry-1",
    revision: 3,
    content: "Prefers terse replies.",
  });
  assert.deepEqual(calls.at(-1), [
    "memory.update",
    { id: "entry-1", revision: 3, content: "Prefers terse replies." },
  ]);

  for (const [channel, method] of [
    [IPC.invoke.memoryArchive, "memory.archive"],
    [IPC.invoke.memoryRestore, "memory.restore"],
    [IPC.invoke.memoryDelete, "memory.delete"],
  ]) {
    await handlers.get(channel)({ id: "entry-1" });
    assert.deepEqual(calls.at(-1), [method, { id: "entry-1" }]);
  }

  await handlers.get(IPC.invoke.memorySessionGet)({ sessionId: "session-1" });
  assert.deepEqual(calls.at(-1), ["memory.session.get", { sessionId: "session-1" }]);

  await handlers.get(IPC.invoke.memorySessionSetExcluded)({
    sessionId: "session-1",
    excluded: true,
  });
  assert.deepEqual(calls.at(-1), [
    "memory.session.setExcluded",
    { sessionId: "session-1", excluded: true },
  ]);
});

test("a malformed renderer value never reaches the host", async () => {
  const { handlers, calls } = harness();
  // A project scope with no identity cannot be resolved by the host either.
  await assert.rejects(
    handlers.get(IPC.invoke.memoryList)({ scope: "project" }),
    /project scope needs a path or a session/,
  );
  await assert.rejects(
    handlers.get(IPC.invoke.memoryList)({ scope: "everything" }),
    /invalid memory scope/,
  );
  // An edit without the revision it read could overwrite someone else's write.
  await assert.rejects(
    handlers.get(IPC.invoke.memoryUpdate)({ id: "entry-1", content: "x" }),
    /invalid memory revision/,
  );
  await assert.rejects(
    handlers.get(IPC.invoke.memoryUpdate)({ id: "entry-1", revision: 2 }),
    /an edit changes something/,
  );
  await assert.rejects(handlers.get(IPC.invoke.memoryDelete)({}), /invalid memory id/);
  await assert.rejects(
    handlers.get(IPC.invoke.memorySessionSetExcluded)({ sessionId: "session-1" }),
    /invalid excluded/,
  );
  assert.deepEqual(calls, []);
});

test("a missing host is an error, not a silent success", async () => {
  const { handlers } = harness({ host: false });
  await assert.rejects(
    handlers.get(IPC.invoke.memorySessionGet)({ sessionId: "session-1" }),
    /host unavailable/,
  );
});
