import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const data = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "plugin-settings-runtime-"));
process.env.MINIH_AGENT_DATA_DIR = data;
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function spawnProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => { if (child.connected) child.send(message); },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

async function setup(t, { fail = false } = {}) {
  const id = `fixture.settings-${fail ? "failure" : "save"}`;
  const path = join(data, id);
  const settingsPath = join(data, "plugins/data", id, "settings.json");
  mkdirSync(join(data, "plugins/data", id), { recursive: true });
  mkdirSync(path);
  writeFileSync(settingsPath, JSON.stringify({ value: "before", __themeVariables: { keep: true }, privateField: 7 }));
  writeFileSync(join(path, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: id, version: "1.0.0", main: "main.cjs", permissions: [], contributes: { settings: [{ key: "value", title: "Value", type: "string", default: "default" }] } }));
  writeFileSync(join(path, "main.cjs"), "exports.onLoad = () => {};\n");
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess,
    updatePluginSettings: async (pluginId, patch) => {
      calls.push({ pluginId, patch });
      if (fail) throw new Error("host persistence failed");
      const current = JSON.parse(readFileSync(settingsPath, "utf8"));
      writeFileSync(settingsPath, JSON.stringify({ ...current, ...patch }));
    },
  });
  t.after(async () => { await runtime.unload(id); rmSync(path, { recursive: true, force: true }); });
  await runtime.loadFromPath(path, []);
  return { id, runtime, calls, settingsPath };
}

test("plugin setting saves route the bound identity and patch through host persistence", async (t) => {
  const { id, runtime, calls, settingsPath } = await setup(t);
  const view = await runtime.setPluginSettings(id, { value: "after" });
  assert.deepEqual(calls, [{ pluginId: id, patch: { value: "after" } }]);
  assert.equal(view.find((setting) => setting.key === "value").value, "after");
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { value: "after", __themeVariables: { keep: true }, privateField: 7 });
});

test("failed host persistence is observable and leaves previous values intact", async (t) => {
  const { id, runtime, settingsPath } = await setup(t, { fail: true });
  await assert.rejects(runtime.setPluginSettings(id, { value: "lost" }), /host persistence failed/);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).value, "before");
});

test.after(() => rmSync(data, { recursive: true, force: true }));
