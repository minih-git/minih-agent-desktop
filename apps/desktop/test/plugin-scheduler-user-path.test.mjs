import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/plugin-scheduler-hooks.mjs", import.meta.url));
const { IPC, PROTOCOL_VERSION } = await import("@minih-agent/shared");
const { HostProcess } = await import("@minih-agent/host-runtime");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { createPluginSchedulerService } = await import("../electron/main/plugin-scheduler-service.ts");
const { registerPluginSchedulerIpc } = await import("../electron/main/ipc/plugin-scheduler-ipc.ts");
const { powerMonitor } = await import("electron");

const binary = process.env.MINIH_AGENT_HOST_BIN;

test("plugin declaration fires through the real host and appears in the settings IPC", { skip: !binary || !existsSync(binary) ? "set MINIH_AGENT_HOST_BIN to the built host-core" : false }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugin-scheduler-user-path-"));
  const dataDir = join(root, "data");
  const eventFile = join(root, "event.json");
  const manifest = { schemaVersion: 1, id: "test.scheduled", name: "Test scheduler", version: "1.0.0", main: "main.mjs", engines: { minihAgent: ">=1.0.0" }, permissions: ["scheduler"], contributes: { schedules: [{ id: "tick", title: "Tick", every: "1h" }] } };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "main.mjs"), `import {writeFileSync} from "node:fs"; export function onLoad() { pi.events.on("schedule:fire", async (event) => writeFileSync(${JSON.stringify(eventFile)}, JSON.stringify(event))); }`);
  const host = new HostProcess({ binaryPath: binary, dataDir, onStderr: () => {} });
  const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
  let service;
  const runtime = new PluginRuntime({ hostEntry, spawnProcess: ({ entry }) => {
    const child = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return { postMessage: (message) => child.send(message), onMessage: (handler) => child.on("message", handler), onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)), kill: () => child.kill() };
  }, onPluginLoaded: (id) => service.loaded(id), onPluginUnload: (id) => service.unloaded(id) });
  t.after(async () => { service?.dispose(); await runtime.disposeAll(); await host.dispose(); rmSync(root, { recursive: true, force: true }); });
  await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
  await host.call("plugins.loadDev", { path: root });
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  let now = 1_000;
  const timers = new Map(); let next = 0;
  service = createPluginSchedulerService({
    plugins: runtime, getHost: () => host,
    clock: { now: () => now, setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id) },
    idleSeconds: () => 120,
    onChange: () => { if (service?.scheduler.getState(manifest.id, "tick").lastOk === true) finish(); },
    onError: (error) => { throw error; },
  });
  await runtime.loadFromPath(root, ["scheduler"]);
  await completed;
  assert.deepEqual(JSON.parse(readFileSync(eventFile, "utf8")), { scheduleId: "tick", firedAt: 1_000, missed: 0 });
  const handlers = new Map();
  registerPluginSchedulerIpc({ registrar: { handle: (channel, fn) => handlers.set(channel, fn) }, plugins: runtime, getHost: () => host, locale: () => "en" });
  const rows = await handlers.get(IPC.invoke.pluginSchedulesList)();
  assert.deepEqual(rows.map(({ pluginId, scheduleId, lastRunAt, lastOk, nextRunAt }) => ({ pluginId, scheduleId, lastRunAt, lastOk, nextRunAt })), [{ pluginId: manifest.id, scheduleId: "tick", lastRunAt: 1_000, lastOk: true, nextRunAt: 3_601_000 }]);
  const resumed = new Promise((resolve) => { finish = resolve; });
  now += 4 * 3_600_000;
  powerMonitor.emit("resume");
  await resumed;
  assert.deepEqual(JSON.parse(readFileSync(eventFile, "utf8")), { scheduleId: "tick", firedAt: now, missed: 3 });
  const afterResume = await handlers.get(IPC.invoke.pluginSchedulesList)();
  assert.equal(afterResume[0].nextRunAt, now + 3_600_000);
  await handlers.get(IPC.invoke.pluginSchedulesPause)({ pluginId: manifest.id, scheduleId: "tick", paused: true });
  assert.equal((await handlers.get(IPC.invoke.pluginSchedulesList)())[0].paused, true);
  await assert.rejects(handlers.get(IPC.invoke.pluginSchedulesRun)({ pluginId: manifest.id, scheduleId: "tick" }), /paused/);
  await handlers.get(IPC.invoke.pluginSchedulesPause)({ pluginId: manifest.id, scheduleId: "tick", paused: false });
  await host.call("plugins.disable", { id: manifest.id });
  await assert.rejects(service.scheduler.runNow(manifest.id, "tick"), /disabled/);
  await host.call("plugins.enable", { id: manifest.id });
  await host.call("plugins.uninstall", { id: manifest.id });
  assert.deepEqual((await host.call("plugins.schedules.list", {})).schedules, []);
  await assert.rejects(service.scheduler.runNow(manifest.id, "tick"), /not installed/);
  assert.deepEqual(JSON.parse(readFileSync(eventFile, "utf8")), { scheduleId: "tick", firedAt: now, missed: 3 });
  await runtime.unload(manifest.id);
  await service.removePlugin(manifest.id);
  service.dispose();
  assert.equal(powerMonitor.listenerCount("resume"), 0);
  assert.equal(timers.size, 0);
});
