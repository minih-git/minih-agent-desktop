#!/usr/bin/env node
// Isolated real host, plugin sidecar and loopback HTTP server; no user data.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../apps/desktop/electron/main/plugin-runtime.ts");
const { resolvePluginCredential, listPluginCredentialSlots } = await import("../apps/desktop/electron/main/plugin-credential-slots.ts");
const binary = resolveHostBinary();
const temp = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "credential-e2e-"));
const dataDir = join(temp, "data");
const pluginDir = join(temp, "plugin");
mkdirSync(pluginDir);
const pluginId = "test.credential-journey";
const token = "synthetic-local-credential";
const host = new Host(binary, dataDir, { quiet: true });
const frames = [];
let runtime;
const received = [];
const server = createServer((request, response) => {
  received.push(request.headers.authorization);
  response.writeHead(200, { authorization: `Bearer ${token}`, "content-type": "text/plain" });
  response.end("ok");
});
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: pluginId, name: "Credential journey", version: "1.0.0", main: "main.js",
    permissions: ["net.fetch", "credentials.use"], net: { domains: ["127.0.0.1"] },
    contributes: { credentials: [{ id: "service", title: "Service", kind: "bearer",
      fields: [{ key: "token", label: "Token", secret: true }], scope: { domains: ["127.0.0.1"] } }] },
  }));
  writeFileSync(join(pluginDir, "main.js"), `module.exports = { async onPanelInvoke(_channel, payload) { return globalThis.pi.net.fetch({ url: payload.url, credentialRef: "service" }); } };`);
  await host.start();
  await host.call("plugins.loadDev", { path: pluginDir });
  const statusBefore = await host.call("plugins.credentials.status", { pluginId });
  assert.equal(statusBefore.slots[0].configured, false);
  // Same host RPC used by the settings IPC after user input.
  await host.call("plugins.credentials.set", { pluginId, slotId: "service", fields: { token } });
  const statusAfter = await host.call("plugins.credentials.status", { pluginId });
  assert.equal(statusAfter.slots[0].configured, true);
  assert.equal(JSON.stringify(statusAfter).includes(token), false);
  const hostCall = (method, params) => host.call(method, params);
  runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../apps/desktop/electron/main/plugin-host-process.mjs", import.meta.url)),
    resolvePluginCredential: (id, slot) => resolvePluginCredential(hostCall, id, slot),
    listPluginCredentialSlots: (id) => listPluginCredentialSlots(hostCall, id),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const record = (message) => frames.push(JSON.parse(JSON.stringify(message)));
      return {
        postMessage(message) { record(message); if (child.connected) child.send(message); },
        onMessage(handler) { child.on("message", (message) => { record(message); handler(message); }); },
        onExit(handler) { child.on("exit", (code) => handler(code ?? 0)); },
        kill() { child.kill(); },
      };
    },
  });
  await runtime.loadFromPath(pluginDir);
  const result = await runtime.invokePanelBridge(pluginId, "fetch", { url });
  assert.deepEqual(received, [`Bearer ${token}`]);
  assert.equal(result.status, 200);
  assert.equal(result.bodyText, "ok");
  assert.equal(result.headers.authorization, undefined);
  assert.equal(JSON.stringify(frames).includes(token), false);
  await runtime.unload(pluginId);
  runtime.disposeWatchers();
  runtime = undefined;
  await host.call("plugins.disable", { id: pluginId });
  assert.equal((await host.call("plugins.credentials.status", { pluginId })).slots[0].configured, true);
  await host.call("plugins.uninstall", { id: pluginId });
  assert.deepEqual(readdirSync(join(dataDir, "secrets")).filter((name) => name.endsWith(".bin")), []);
  console.log("PASS isolated host credential save → plugin fetch → disable/uninstall");
} finally {
  if (runtime) { await runtime.unload(pluginId); runtime.disposeWatchers(); }
  await host.stop();
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
