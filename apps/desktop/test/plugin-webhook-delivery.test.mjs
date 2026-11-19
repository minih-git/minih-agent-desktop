import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

async function loadPlugin(t, source, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "webhook-plugin-"));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "example.webhook",
    name: "Webhook example",
    version: "1.0.0",
    main: "main.mjs",
    permissions: ["inbound.webhook"],
    contributes: { webhooks: [{ id: "hook", title: "Hook" }] },
    engines: { minihAgent: ">=1.0.0" },
  }));
  writeFileSync(join(root, "main.mjs"), source);
  let child;
  let ready;
  const received = new Promise((resolve) => { ready = resolve; });
  const runtime = new PluginRuntime({
    hostEntry,
    getWebhookReceivers: options.getWebhookReceivers,
    spawnProcess: ({ entry }) => {
      child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => child.send(message),
        onMessage: (handler) => child.on("message", (message) => {
          if (message?.t === "webhook-test-ready") ready(message.event);
          else handler(message);
        }),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.unload("example.webhook");
    runtime.disposeWatchers();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.loadFromPath(root, options.granted ?? ["inbound.webhook"]);
  return { runtime, received, release: () => child.send({ t: "event", event: "test.release", args: [] }) };
}

const event = { webhookId: "hook", method: "POST", headers: { "x-event": "push" }, bodyText: "hello", sourceIp: "127.0.0.1", receivedAt: 42 };

test("delivery waits for the real plugin handler to complete", async (t) => {
  const { runtime, received, release } = await loadPlugin(t, `
let release;
pi.events.on("inbound:webhook", event => {
  process.send({ t: "webhook-test-ready", event });
  return new Promise(resolve => { release = resolve; });
});
pi.events.on("test.release", () => release());
`);
  let completed = false;
  const pending = runtime.deliverWebhook("example.webhook", event).then(() => { completed = true; });
  assert.deepEqual(await received, event);
  assert.equal(completed, false);
  release();
  await pending;
  assert.equal(completed, true);
  await assert.rejects(runtime.deliverWebhook("example.webhook", { ...event, webhookId: "other" }), { code: "PERMISSION_DENIED" });
});

test("missing or failing webhook handlers never acknowledge delivery", async (t) => {
  const missing = await loadPlugin(t, "export {};\n");
  await assert.rejects(missing.runtime.deliverWebhook("example.webhook", event), { code: "NOT_FOUND" });
  const failing = await loadPlugin(t, `pi.events.on("inbound:webhook", () => { throw new Error("sensitive body"); });`);
  await assert.rejects(failing.runtime.deliverWebhook("example.webhook", event), (error) => {
    assert.equal(error.code, "PLUGIN_CALL_FAILED");
    assert.doesNotMatch(error.message, /sensitive body/);
    return true;
  });
});

test("receiver listing crosses the real plugin process and never returns tokens", async (t) => {
  const probe = `export async function onLoad() {
    try { process.send({ t: "webhook-test-ready", event: await pi.inbound.getReceivers() }); }
    catch (error) { process.send({ t: "webhook-test-ready", event: { error: error.code } }); }
  }`;
  const withPermission = await loadPlugin(t, probe, {
    getWebhookReceivers: async (pluginId) => {
      assert.equal(pluginId, "example.webhook");
      return [{ id: "hook", url: "http://127.0.0.1:37124/hooks/example.webhook/hook", enabled: true, token: "secret" }];
    },
  });
  assert.deepEqual(await withPermission.received, [{ id: "hook", url: "http://127.0.0.1:37124/hooks/example.webhook/hook", enabled: true }]);
  const withoutPermission = await loadPlugin(t, probe, { granted: [], getWebhookReceivers: async () => { throw new Error("must not be called"); } });
  assert.deepEqual(await withoutPermission.received, { error: "PERMISSION_DENIED" });
});

test("receiver service failures do not expose sensitive details to plugins", async (t) => {
  const probe = `export async function onLoad() {
    try { await pi.inbound.getReceivers(); }
    catch (error) { process.send({ t: "webhook-test-ready", event: { code: error.code, message: error.message } }); }
  }`;
  const plugin = await loadPlugin(t, probe, { getWebhookReceivers: async () => { throw new Error("secret-token"); } });
  assert.deepEqual(await plugin.received, { code: "INTERNAL", message: "Unable to list webhook receivers" });
});

test("a stuck webhook cleanup cannot prevent plugin runtime shutdown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const runtime = new PluginRuntime({ onPluginRuntimeDispose: () => { signalStarted(); return new Promise(() => {}); } });
  const shutdown = runtime.disposeAll();
  await started;
  t.mock.timers.tick(3_000);
  await shutdown;
});
