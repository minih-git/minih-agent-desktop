/**
 * Renaming an employee must reach the session list, not only the bot list.
 *
 * `bot.update` writes the new name into `bot_profile_json` *and* into
 * `sessions.title` (host-core `bots::update`). The renderer keeps those in two
 * stores, and the session one re-reads only on `sessionsChanged` — so an update
 * that announced `botsChanged` alone left the conversation topbar showing the
 * previous name until something unrelated refreshed the list.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
    ...Object.values(globals),
  );
  return module.exports;
}

const shared = { IPC };
const { registerBotIpc } = load("../electron/main/ipc/bot-ipc.ts", {
  "@minih-agent/shared": shared,
  "../services/task-cards-changed": load("../electron/main/services/task-cards-changed.ts", {
    "@minih-agent/shared": shared,
  }),
});

function harness(answer = async () => ({ ok: true })) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const host = {
    isAvailable: () => true,
    call: async (method, input) => {
      calls.push({ method, input });
      return answer(method, input);
    },
  };
  registerBotIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    sessionCollaboration: {},
    tasks: { announce: () => undefined, reconcileStages: async () => undefined },
  });
  return { handlers, calls, events };
}

test("renaming an employee refreshes the session list exactly once", async () => {
  const { handlers, calls, events } = harness(async () => ({ bot: { id: "steward", name: "阿福" } }));
  const handle = handlers.get(IPC.invoke.botUpdate);
  assert.equal(typeof handle, "function");

  await handle({ id: "steward", name: "阿福" });

  assert.deepEqual(calls, [{ method: "bot.update", input: { id: "steward", name: "阿福" } }]);
  assert.deepEqual(
    events.map((event) => event.channel),
    [IPC.event.botsChanged, IPC.event.sessionsChanged],
  );
  // One refresh, not one per changed field: the renderer answers this event by
  // re-reading the whole session list.
  assert.equal(events.filter((event) => event.channel === IPC.event.sessionsChanged).length, 1);
  assert.equal(events[1].payload.reason, "bot.updated");
});

test("a refused update announces nothing", async () => {
  const { handlers, events } = harness(async () => {
    throw new Error("host refused");
  });
  await assert.rejects(handlers.get(IPC.invoke.botUpdate)({ id: "steward", name: "阿福" }));
  assert.deepEqual(events, []);
});