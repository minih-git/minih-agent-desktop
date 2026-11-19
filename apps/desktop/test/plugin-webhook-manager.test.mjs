import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginWebhookManager } = await import("../electron/main/plugin-webhook-manager.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

function hostFixture(getPlugins) {
  const secrets = new Map();
  const rows = [];
  let acknowledge;
  const acknowledged = new Promise((resolve) => { acknowledge = resolve; });
  return {
    rows, secrets, acknowledged,
    async call(method, params = {}) {
      switch (method) {
        case "plugins.list": return { plugins: getPlugins().map((plugin) => ({ id: plugin.manifest.id })) };
        case "secrets.getForRuntime": return { value: secrets.get(params.secretRef) ?? null };
        case "secrets.set": secrets.set(params.secretRef, params.value); return {};
        case "secrets.delete": secrets.delete(params.secretRef); return {};
        case "plugin.webhook.list": return { events: rows.filter((row) => (!params.pluginId || row.pluginId === params.pluginId) && (params.beforeMs === undefined || row.receivedAt < params.beforeMs)), nextCursor: null };
        case "plugin.webhook.deleteByIds": for (const id of params.eventIds) { const index = rows.findIndex((row) => row.eventId === id); if (index >= 0) rows.splice(index, 1); } return {};
        case "plugin.webhook.recordEvent": rows.push({ ...params, deliveredAt: null }); return {};
        case "plugin.webhook.pending": return { events: rows.filter((row) => row.pluginId === params.pluginId && row.deliveredAt === null) };
        case "plugin.webhook.markDelivered": rows.find((row) => row.eventId === params.eventId).deliveredAt = Date.now(); acknowledge(); return {};
        default: throw new Error(`unexpected method ${method}`);
      }
    },
  };
}

function post(port, token, body = "event", host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path: "/hooks/example.plugin/hook", method: "POST", headers: { "x-minih-webhook-token": token, "x-event": "push" } }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t, deliverOverride) {
  const root = await mkdtemp(join(tmpdir(), "webhook-manager-"));
  const blocker = createServer();
  await new Promise((resolve, reject) => blocker.once("error", reject).listen(0, "127.0.0.1", resolve));
  await writeFile(join(root, "webhook.port"), String(blocker.address().port));
  const plugins = [];
  const host = hostFixture(() => plugins);
  const delivered = [];
  const errors = [];
  let reportFailure;
  const failure = new Promise((resolve) => { reportFailure = resolve; });
  const manager = new PluginWebhookManager({ dataDir: root, getHost: () => host, plugins: () => plugins, deliver: deliverOverride ?? (async (pluginId, event) => delivered.push({ pluginId, event })), onError: (error) => { errors.push(error); reportFailure(error); } });
  t.after(async () => {
    await manager.dispose();
    await new Promise((resolve) => blocker.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, host, plugins, manager, delivered, errors, failure };
}

function enabledPlugin() {
  return { manifest: { id: "example.plugin", contributes: { webhooks: [{ id: "hook" }] } }, permissions: new Set(["inbound.webhook"]), runtimeId: "one", disposing: false, child: {} };
}

test("listener follows plugin lifecycle; POST is persisted, delivered and acknowledged", async (t) => {
  const { manager, plugins, host, delivered, errors, failure } = await fixture(t);
  await manager.reconcile();
  assert.equal(manager.server.server, null);
  plugins.push(enabledPlugin());
  const info = await manager.list("example.plugin");
  assert.equal(info.loopbackOnly, false);
  assert.equal(manager.server.server.address().address, "0.0.0.0");
  assert.deepEqual(Object.keys(info.receivers[0]).sort(), ["enabled", "id", "url"]);
  const port = Number(new URL(info.receivers[0].url).port);
  const token = await manager.reveal("example.plugin", "hook");
  assert.equal(await post(port, token), 202);
  assert.equal(await Promise.race([host.acknowledged.then(() => null), failure]), null);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.bodyText, "event");
  assert.equal(delivered[0].event.headers["x-minih-webhook-token"], undefined);
  assert.equal(delivered[0].event.headers["x-event"], "push");
  assert.deepEqual(errors, []);
  plugins.length = 0;
  await manager.reconcile();
  assert.equal(manager.server.server, null);
});

test("rotation invalidates the old token; loopback setting changes and persists the bind", async (t) => {
  const { manager, plugins, root, host } = await fixture(t);
  plugins.push(enabledPlugin());
  const first = await manager.reveal("example.plugin", "hook");
  const second = await manager.rotate("example.plugin", "hook");
  assert.ok(first !== second);
  await manager.setLoopbackOnly(true);
  const info = await manager.list("example.plugin");
  assert.equal(info.loopbackOnly, true);
  assert.equal(manager.server.server.address().address, "127.0.0.1");
  assert.equal(JSON.parse(await readFile(join(root, "webhook-preferences.json"), "utf8")).loopbackOnly, true);
  const port = Number(new URL(info.receivers[0].url).port);
  assert.equal(await post(port, first), 401);
  assert.equal(await post(port, second), 202);
  await host.acknowledged;
});

test("external POST reaches the real plugin and its crash closes the listener", async (t) => {
  let runtime;
  let childHandle;
  let resolveCrash;
  let rejectCrash;
  const crashHandled = new Promise((resolve, reject) => { resolveCrash = resolve; rejectCrash = reject; });
  const { root, host, plugins, manager } = await fixture(t, (pluginId, event) => runtime.deliverWebhook(pluginId, event));
  const pluginDir = join(root, "plugin");
  await mkdir(pluginDir);
  await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "example.plugin", name: "Webhook plugin", version: "1.0.0", main: "main.mjs", permissions: ["inbound.webhook"], contributes: { webhooks: [{ id: "hook", title: "Hook" }] }, engines: { minihAgent: ">=1.0.0" } }));
  await writeFile(join(pluginDir, "main.mjs"), `pi.events.on("inbound:webhook", event => process.send({ t: "probe", event }));`);
  let received;
  const eventReceived = new Promise((resolve) => { received = resolve; });
  runtime = new PluginRuntime({ hostEntry, onPluginCrash: () => { plugins.length = 0; void manager.reconcile().then(resolveCrash, rejectCrash); }, spawnProcess: ({ entry }) => {
    const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    childHandle = child;
    return {
      postMessage: (message) => child.send(message),
      onMessage: (handler) => child.on("message", (message) => message?.t === "probe" ? received(message.event) : handler(message)),
      onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
      kill: () => child.kill(),
    };
  } });
  t.after(async () => { await runtime.unload("example.plugin"); runtime.disposeWatchers(); });
  await runtime.loadFromPath(pluginDir, ["inbound.webhook"]);
  plugins.push(...runtime.listLoaded());
  const status = await manager.list("example.plugin");
  const token = await manager.reveal("example.plugin", "hook");
  assert.equal(await post(Number(new URL(status.receivers[0].url).port), token), 202);
  const delivered = await eventReceived;
  assert.equal(delivered.bodyText, "event");
  assert.equal(delivered.headers["x-event"], "push");
  assert.equal(delivered.headers["x-minih-webhook-token"], undefined);
  await host.acknowledged;
  const stored = join(root, "plugin-webhooks", "example.plugin", host.rows[0].bodyRef);
  assert.ok(await stat(stored));
  childHandle.kill("SIGKILL");
  await crashHandled;
  assert.equal(manager.server.server, null);
  await runtime.unload("example.plugin");
  await manager.uninstall("example.plugin", ["hook"]);
  await assert.rejects(stat(stored), { code: "ENOENT" });
  assert.equal(host.rows.length, 0);
});

test("LAN mode also accepts IPv6 loopback when IPv6 is available", async (t) => {
  const { manager, plugins, host } = await fixture(t);
  plugins.push(enabledPlugin());
  const status = await manager.list("example.plugin");
  if (!manager.server.ipv6Server) return t.skip("IPv6 is unavailable on this host");
  assert.equal(manager.server.ipv6Server.address().address, "::");
  const token = await manager.reveal("example.plugin", "hook");
  assert.equal(await post(Number(new URL(status.receivers[0].url).port), token, "event", "::1"), 202);
  await host.acknowledged;
  await manager.setLoopbackOnly(true);
  assert.equal(manager.server.ipv6Server, null);
});

test("uninstall removes tokens for receivers removed by a plugin update", async (t) => {
  const { manager, plugins, host, root } = await fixture(t);
  const plugin = enabledPlugin();
  plugins.push(plugin);
  await manager.list("example.plugin");
  assert.equal(host.secrets.size, 1);
  plugin.manifest.contributes.webhooks = [];
  await manager.reconcile();
  plugins.length = 0;
  await manager.uninstall("example.plugin", []);
  assert.equal(host.secrets.size, 0);
  await assert.rejects(stat(join(root, "plugin-webhooks", "example.plugin", "receivers.json")), { code: "ENOENT" });
});

test("startup finishes cleanup for a plugin already uninstalled before a crash", async (t) => {
  const { manager, plugins, host, root } = await fixture(t);
  plugins.push(enabledPlugin());
  await manager.list("example.plugin");
  await manager.dispose();
  plugins.length = 0;
  const restarted = new PluginWebhookManager({ dataDir: root, getHost: () => host, plugins: () => plugins, deliver: async () => {}, onError: () => {} });
  t.after(() => restarted.dispose());
  await restarted.reconcile();
  assert.equal(host.secrets.size, 0);
  await assert.rejects(stat(join(root, "plugin-webhooks", "example.plugin", "receivers.json")), { code: "ENOENT" });
});
