import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function registerFunction(scheduleCleanup) {
  const file = new URL("../electron/main/ipc/plugin-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  const dependencies = {
    electron: { dialog: {} },
    "@minih-agent/shared": { IPC },
    "@minih-agent/plugin-devkit": {},
    "@minih-agent/plugin-sdk": { resolvePluginLocalizedString: () => "" },
    "../browser-host": { BROWSER_PLUGIN_ID: "pi.browser" },
    "../plugin-runtime": { readDevPluginDeclaration: () => ({ manifest: { contributes: { webhooks: [{ id: "hook" }] } } }), widenedFsScope: () => [] },
    "../plugin-view-host": { PluginViewHost: class {} },
    "../plugin-renderer-extension": { rendererCallError: (error) => error },
    "../plugin-scheduler-service": { pluginSchedulerFor: () => ({ removePlugin: scheduleCleanup }) },
    "./plugin-scheduler-ipc": { registerPluginSchedulerIpc: () => {} },
  };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(dependencies, id), `Unexpected import: ${id}`);
    return dependencies[id];
  }, module.exports, module);
  return module.exports.registerPluginIpc;
}

function fixture({ uninstallOk = true, failCleanup = false, failFlush = false, failSchedule = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const pluginId = "example.plugin";
  const host = { async call(method) {
    calls.push(method);
    if (method === "plugins.uninstall") return { ok: uninstallOk };
    throw new Error("Unexpected host call");
  } };
  registerFunction(async (id) => { calls.push(["schedule", id]); if (failSchedule) throw new Error("fixture-secret"); })({
    registrar: { handle: (channel, fn) => handlers.set(channel, fn), handleWithEvent: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => host,
    plugins: { listLoaded: () => [{ manifest: { id: pluginId, contributes: { webhooks: [{ id: "hook" }] } } }], unload: async () => calls.push("unload"), flushTcpUsage: async () => { calls.push("flushTcpUsage"); if (failFlush) throw new Error("traffic store unavailable"); } },
    webhooks: { uninstall: async (id, ids) => { calls.push(["cleanup", id, ids]); if (failCleanup) throw new Error("fixture-secret"); } },
    agentExtensions: {}, browserHost: { disposeGuest() {} }, pluginViews: { closePlugin: () => calls.push("close") },
    pluginScopes: new Map(), rememberPluginScopes() {}, sendToRenderer() {}, logger: { app() {} }, getUpdaterLocale: () => "en", confirmInterruption: async () => true,
  });
  return { uninstall: () => handlers.get(IPC.invoke.pluginUninstall)(pluginId), calls };
}

test("uninstall waits for host removal before clearing webhook files and token references", async () => {
  const { uninstall, calls } = fixture();
  assert.deepEqual(await uninstall(), { ok: true });
  assert.deepEqual(calls, ["close", "unload", "flushTcpUsage", "plugins.uninstall", ["schedule", "example.plugin"], ["cleanup", "example.plugin", ["hook"]]]);
});

test("failed uninstall leaves webhooks intact; cleanup failure reports partial removal without leaking details", async () => {
  const failed = fixture({ uninstallOk: false });
  assert.deepEqual(await failed.uninstall(), { ok: false });
  assert.equal(failed.calls.some(Array.isArray), false);
  const partial = fixture({ failCleanup: true });
  await assert.rejects(partial.uninstall(), (error) => {
    assert.equal(error.message, "Plugin was uninstalled, but webhook data cleanup failed");
    return true;
  });
  assert.equal(partial.calls.some((call) => Array.isArray(call) && call[0] === "schedule"), true);
  const scheduleFailure = fixture({ failSchedule: true });
  await assert.rejects(scheduleFailure.uninstall(), /schedule data cleanup failed/);
  assert.equal(scheduleFailure.calls.some((call) => Array.isArray(call) && call[0] === "cleanup"), true);
  const both = fixture({ failSchedule: true, failCleanup: true });
  await assert.rejects(both.uninstall(), /schedule and webhook data cleanup failed/);
});

test("a failed TCP flush prevents uninstall and webhook removal", async () => {
  const failed = fixture({ failFlush: true });
  await assert.rejects(failed.uninstall(), /traffic store unavailable/);
  assert.deepEqual(failed.calls, ["close", "unload", "flushTcpUsage"]);
});
