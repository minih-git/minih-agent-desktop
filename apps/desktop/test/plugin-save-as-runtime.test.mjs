/**
 * `pi.fs.saveAs` through the runtime: the plugin-process path and the panel
 * path are one implementation, one dialog at a time, and one audit row.
 *
 * The dialog is injected (`services.saveFile`), so no Electron window is
 * involved; the plugin process is real, so the route a mailbox plugin actually
 * takes is the one under test.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const dataDir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "save-as-runtime-"));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const ENTRY = join(here, "../electron/main/plugin-host-process.mjs");
const PLUGIN_SOURCE = "module.exports = { onLoad() {} };";

function writePlugin(id, permissions) {
  const dir = mkdtempSync(join(dataDir, "plugins-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      main: "main.js",
      permissions,
    }),
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_SOURCE);
  return dir;
}

/** A runtime whose native dialog is a function this test controls. */
async function harness(t, { permissions, dialog }) {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: ENTRY,
    audit: (row) => audits.push(row),
    saveFile: dialog,
    saveAsDataDir: join(dataDir, "app-data"),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
      return {
        postMessage: (message) => {
          if (child.connected) child.send(message);
        },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.disposeAll();
  });
  const pluginId = "test.save-as";
  await runtime.loadFromPath(writePlugin(pluginId, permissions));
  return { runtime, pluginId, audits, loaded: runtime.loaded.get(pluginId) };
}

test("the plugin process reaches the same dialog, and writes only the picked path", async (t) => {
  const target = join(dataDir, "picked.txt");
  const { runtime, pluginId, audits, loaded } = await harness(t, {
    permissions: ["fs.write"],
    dialog: async () => target,
  });

  // Exactly the route `pi.fs.saveAs` takes: HOST_API_ALLOWLIST → hostApi().fs.
  const answer = await runtime.hostApi(loaded).fs.saveAs({
    suggestedName: "../../picked.txt",
    data: new Uint8Array([104, 105]),
  });

  assert.deepEqual(answer, { path: target, name: "picked.txt" });
  assert.equal(readFileSync(target, "utf8"), "hi");
  const row = audits.find((entry) => entry.api === "fs.saveAs" && entry.ok === true);
  assert.equal(row?.pluginId, pluginId);
  assert.equal(row?.bytes, 2);
  assert.equal(row?.saved, true);
  // The path the user picked is never in the audit row.
  assert.ok(!JSON.stringify(row).includes(target), JSON.stringify(row));
});

test("a panel call drives the same implementation", async (t) => {
  const target = join(dataDir, "panel.txt");
  let calls = 0;
  const { runtime, pluginId } = await harness(t, {
    permissions: ["fs.write"],
    // The first call picks a file, the second one cancels.
    dialog: async () => {
      calls += 1;
      return calls === 1 ? target : null;
    },
  });

  const answer = await runtime.invokePanelBridge(pluginId, "fs.saveAs", {
    suggestedName: "panel.txt",
    data: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(answer, { path: target, name: "panel.txt" });

  // Cancelling writes nothing and answers null on this path too.
  const cancelled = await runtime.invokePanelBridge(pluginId, "fs.saveAs", {
    suggestedName: "panel.txt",
    data: new Uint8Array([9]),
  });
  assert.equal(cancelled, null);
});

test("without fs.write the call is refused before any dialog opens", async (t) => {
  let opened = 0;
  const { runtime, loaded } = await harness(t, {
    permissions: ["fs.read"],
    dialog: async () => {
      opened += 1;
      return null;
    },
  });
  await assert.rejects(
    runtime.hostApi(loaded).fs.saveAs({ suggestedName: "a.txt", data: new Uint8Array([1]) }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  assert.equal(opened, 0, "a refused call never asks the user");
});

test("a second dialog waits for the first one instead of stacking", async (t) => {
  const target = join(dataDir, "slow.txt");
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const { runtime, loaded } = await harness(t, {
    permissions: ["fs.write"],
    dialog: async () => {
      await slow;
      return target;
    },
  });

  const first = runtime.hostApi(loaded).fs.saveAs({ suggestedName: "slow.txt", data: new Uint8Array([1]) });
  await assert.rejects(
    runtime.hostApi(loaded).fs.saveAs({ suggestedName: "slow.txt", data: new Uint8Array([1]) }),
    (error) => error.code === "SAVE_AS_BUSY",
  );
  release();
  assert.deepEqual(await first, { path: target, name: "slow.txt" });
  // The gate is per call, not per plugin: the next save works again.
  release();
  await runtime.hostApi(loaded).fs.saveAs({ suggestedName: "slow.txt", data: new Uint8Array([1]) });
});

test.after(() => rmSync(dataDir, { recursive: true, force: true }));