import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approveAll, rpc } from "./config-sync-journey.mjs";

const id = "fixture.portable-settings";
const sync = (host) => rpc(host, "configSync.syncNow");
const file = (host) => join(host.dataDir, "plugins/data", id, "settings.json");
const read = async (host) => JSON.parse(await readFile(file(host), "utf8"));

export async function runPluginSettingsJourney({ a, b, step }) {
  step("plugin-settings-save-and-local-approval");
  for (const host of [a, b]) {
    const path = join(host.dataDir, "fixture-plugin");
    await mkdir(path);
    await writeFile(join(path, "main.js"), "export function onLoad() {}\n");
    await writeFile(join(path, "manifest.json"), JSON.stringify({
      schemaVersion: 1, id, name: "Portable settings fixture", version: "1.0.0",
      main: "main.js", permissions: [], contributes: { settings: [
        { key: "enabled", title: "Enabled", type: "boolean", default: false },
        { key: "label", title: "Label", type: "string" },
        { key: "folder", title: "Local folder", type: "string" },
      ] },
    }));
    await rpc(host, "plugins.loadDev", { path });
  }
  await rpc(b, "plugins.disable", { id });
  assert.deepEqual(await rpc(a, "plugins.settings.update", {
    pluginId: id, patch: { enabled: true, label: "portable-settings-marker", folder: "/device-a/private", privateValue: "not-declared" },
  }), { updated: true });
  await sync(a);
  let state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.domain === "pluginSettings"));
  await assert.rejects(access(file(b)), { code: "ENOENT" }, "settings must wait for local approval");
  await approveAll(b, state);
  assert.equal((await read(b)).enabled, true);
  assert.equal((await read(b)).label, "portable-settings-marker");
  assert.equal((await read(b)).folder, undefined, "another device's absolute path must not arrive");
  assert.equal((await read(b)).privateValue, undefined);
  assert.equal((await rpc(b, "plugins.list")).plugins.find((item) => item.id === id).enabled, false, "restoring settings must not enable a plugin");
  await sync(b);
  await sync(a);

  step("plugin-settings-edits-preserve-local-fields");
  await rpc(b, "plugins.settings.update", { pluginId: id, patch: { folder: "/device-b/private", privateValue: "keep-local" } });
  await rpc(a, "plugins.settings.update", { pluginId: id, patch: { enabled: false, label: "updated-settings-marker" } });
  await sync(a);
  await approveAll(b, await sync(b));
  assert.equal((await read(b)).enabled, false);
  assert.equal((await read(b)).label, "updated-settings-marker");
  assert.equal((await read(b)).folder, "/device-b/private");
  assert.equal((await read(b)).privateValue, "keep-local");
  await sync(b);
  await sync(a);

  step("plugin-settings-repeated-sync-and-reset");
  const before = (await rpc(b, "configSync.getState")).lastRevisionId;
  assert.equal((await sync(b)).lastRevisionId, before, "unchanged settings must not publish another revision");
  // A reset removes the saved override; the declaration's default is not a
  // copied device setting. Exercise the existing file format at that boundary.
  const reset = await read(a);
  delete reset.label;
  await writeFile(file(a), JSON.stringify(reset));
  await sync(a);
  state = await sync(b);
  await approveAll(b, state);
  assert.equal((await read(b)).label, undefined);
  assert.equal((await read(b)).privateValue, "keep-local");
  await sync(b);
  await sync(a);
}
