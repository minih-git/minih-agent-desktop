import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "../../../scripts/e2e/host.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginWebhookManager } = await import("../electron/main/plugin-webhook-manager.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
let binary;
try { binary = resolveHostBinary(); } catch { binary = null; }

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/hooks/example.replay/hook", method: "POST", headers: { "x-minih-webhook-token": token } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("real host restart replays only the unacknowledged plugin event", { timeout: 60_000, skip: binary ? false : "Host binary unavailable" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "webhook-replay-"));
  const pluginDir = join(root, "plugin");
  const dataDir = join(root, "data");
  const releaseFlag = join(root, "release");
  await mkdir(pluginDir);
  await mkdir(dataDir);
  await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "example.replay", name: "Replay", version: "1.0.0", main: "main.mjs", permissions: ["inbound.webhook"], contributes: { webhooks: [{ id: "hook", title: "Hook" }] }, engines: { minihAgent: ">=1.0.0" } }));
  await writeFile(join(pluginDir, "main.mjs"), `
import { existsSync } from "node:fs";
pi.events.on("inbound:webhook", (event) => {
  process.send({ t: "test-event", body: event.bodyText, hasToken: Object.hasOwn(event.headers, "x-minih-webhook-token") });
  if (event.bodyText === "pending" && !existsSync(${JSON.stringify(releaseFlag)})) return new Promise(() => {});
});`);
  const seen = [];
  const waiters = [];
  const observe = (message) => {
    seen.push(message);
    for (const waiter of waiters.splice(0)) waiter();
  };
  const waitFor = async (predicate) => {
    while (!predicate()) await new Promise((resolve) => waiters.push(resolve));
  };
  let host;
  let runtime;
  let manager;
  const stop = async () => {
    if (runtime) { await runtime.unload("example.replay"); runtime.disposeWatchers(); runtime = null; }
    if (manager) { await manager.dispose(); manager = null; }
    if (host) { await host.stop(); host = null; }
  };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const start = async () => {
    host = new Host(binary, dataDir, { quiet: true });
    await host.start();
    await host.call("plugins.loadDev", { path: pluginDir });
    runtime = new PluginRuntime({ hostEntry, spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => child.send(message),
        onMessage: (handler) => child.on("message", (message) => message?.t === "test-event" ? observe(message) : handler(message)),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    } });
    await runtime.loadFromPath(pluginDir, ["inbound.webhook"]);
    manager = new PluginWebhookManager({ dataDir, getHost: () => host, plugins: () => runtime.listLoaded(), deliver: (pluginId, event) => runtime.deliverWebhook(pluginId, event), onError: () => {} });
    await manager.pluginLoaded("example.replay");
    return { port: Number(new URL((await manager.list("example.replay")).receivers[0].url).port), token: await manager.reveal("example.replay", "hook") };
  };
  const first = await start();
  assert.equal(await post(first.port, first.token, "done"), 202);
  await waitFor(() => seen.some((message) => message.body === "done"));
  assert.equal(await post(first.port, first.token, "pending"), 202);
  await waitFor(() => seen.some((message) => message.body === "pending"));
  assert.equal((await host.call("plugin.webhook.pending", { pluginId: "example.replay" })).events.length, 1);
  await stop();
  await writeFile(releaseFlag, "ready");
  await start();
  assert.equal((await host.call("plugin.webhook.pending", { pluginId: "example.replay" })).events.length, 0);
  assert.equal(seen.filter((message) => message.body === "done").length, 1);
  assert.equal(seen.filter((message) => message.body === "pending").length, 2);
  assert.ok(seen.every((message) => message.hasToken === false));
  await access(releaseFlag);
});
