import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerMarketIpc } = await import("../electron/main/ipc/market-ipc.ts");
const { IPC } = await import("@minih-agent/shared");

test("notification command execution checks the owner at execution time", async () => {
  const handlers = new Map();
  const calls = [];
  let owner = "plugin.a";
  const plugins = {
    getCommands: () => [{ id: "refresh", pluginId: owner, run: async () => calls.push(owner) }],
    drainToasts: () => [],
  };
  registerMarketIpc({
    registrar: { handle: (name, handler) => handlers.set(name, handler) },
    getHost: () => null,
    plugins,
    agentExtensions: { allCommands: () => [] },
    optionalWorkspaceRoot: async () => null,
    pluginActiveInProject: () => true,
    sendToRenderer: () => {},
    confirmInterruption: async () => true,
  });
  const execute = handlers.get(IPC.invoke.commandPaletteExecute);
  assert.ok(execute);
  await execute({ pluginId: "plugin.a", commandId: "refresh" });
  assert.deepEqual(calls, ["plugin.a"]);
  owner = "plugin.b";
  await assert.rejects(execute({ pluginId: "plugin.a", commandId: "refresh" }), /not found/);
  assert.deepEqual(calls, ["plugin.a"]);
  assert.deepEqual(await execute("builtin.test"), { ok: true, commandId: "builtin.test" });
});
