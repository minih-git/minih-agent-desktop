import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { createServer } from "node:net";
import { once } from "node:events";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();
const dataDir = mkdtempSync(join(scratch, "tcp-runtime-"));
process.env.MINIH_AGENT_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginTcpRegistry } = await import("../electron/main/plugin-tcp.ts");
const entry = join(here, "../electron/main/plugin-host-process.mjs");

const pluginSource = `
const seen = [];
const waiters = [];
module.exports = {
  onLoad() {
    for (const type of ['open', 'data', 'close', 'error']) {
      pi.events.on('net:tcp:' + type, event => {
        seen.push({type, event});
        for (const waiter of [...waiters]) if (waiter.type === type) {
          waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event);
        }
      });
    }
  },
  async onPanelInvoke(action, input) {
    if (action === 'connect') return pi.net.tcp.connect(input);
    if (action === 'send') return pi.net.tcp.send({connectionId: input.connectionId, data: new Uint8Array([0, 1, 255])});
    if (action === 'close') return pi.net.tcp.close(input);
    if (action === 'crash') process.exit(7);
    if (action === 'seen') return seen.map(item => item.type);
    if (action === 'wait') {
      const found = seen.find(item => item.type === input.type);
      if (found) return found.event;
      return new Promise(resolve => waiters.push({type: input.type, resolve}));
    }
  },
};
`;

function writePlugin(id, port) {
  const dir = mkdtempSync(join(dataDir, "plugin-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name: id, version: "1.0.0", main: "main.js",
    permissions: ["net.tcp"], net: { tcp: [{ host: "127.0.0.1", port, tls: false }] },
  }));
  writeFileSync(join(dir, "main.js"), pluginSource);
  return dir;
}

function spawnProcess({ entry: childEntry }) {
  const child = fork(childEntry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
  return {
    postMessage: (message) => { if (child.connected) child.send(message); },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

test("plugin process connects, sends binary data, receives its own events and closes", async (t) => {
  const server = createServer((socket) => socket.on("data", (data) => socket.write(data)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  let runtime;
  const audits = [];
  const registry = new PluginTcpRegistry({ onEvent: (id, event) => runtime.deliverTcpEvent(id, event) });
  runtime = new PluginRuntime({ hostEntry: entry, spawnProcess, pluginTcp: registry, audit: (event) => audits.push(event) });
  t.after(async () => { await runtime.disposeAll(); await registry.dispose(); });
  const a = "com.example.tcp-alpha";
  const b = "com.example.tcp-beta";
  await runtime.loadFromPath(writePlugin(a, port));
  await runtime.loadFromPath(writePlugin(b, port));
  const call = (id, action, input = {}) => runtime.invokePanelBridge(id, action, input);
  const deniedPort = port === 65535 ? 65534 : port + 1;
  await assert.rejects(call(a, "connect", { endpoint: { host: "127.0.0.1", port: deniedPort } }), { code: "PERMISSION_DENIED" });
  const refusal = audits.find((event) => event.api === "net.tcp.connect" && event.errorCode === "PERMISSION_DENIED");
  assert.equal(refusal?.host, "127.0.0.1");
  assert.equal(refusal?.port, deniedPort);
  await assert.rejects(call(a, "connect", { endpoint: { host: "127.0.0.1", port }, credentialRef: "mail" }), { code: "INVALID_ARGUMENT" });
  const { connectionId } = await call(a, "connect", { endpoint: { host: "127.0.0.1", port } });
  assert.equal((await call(a, "wait", { type: "open" })).connectionId, connectionId);
  await call(a, "send", { connectionId });
  const received = await call(a, "wait", { type: "data" });
  assert.deepEqual([...received.data], [0, 1, 255]);
  assert.deepEqual(await call(b, "seen"), []);
  await assert.rejects(call(b, "close", { connectionId }), { code: "NOT_FOUND" });
  await call(a, "close", { connectionId });
  assert.equal((await call(a, "wait", { type: "close" })).connectionId, connectionId);
  await assert.rejects(call(a, "close", { connectionId }), { code: "NOT_FOUND" });
  const unloadPeer = once(server, "connection");
  await call(b, "connect", { endpoint: { host: "127.0.0.1", port } });
  const [unloadedSocket] = await unloadPeer;
  const unloadedClosed = once(unloadedSocket, "close");
  await runtime.unload(b);
  await unloadedClosed;

  const crashPeer = once(server, "connection");
  await call(a, "connect", { endpoint: { host: "127.0.0.1", port } });
  const [crashedSocket] = await crashPeer;
  const crashedClosed = once(crashedSocket, "close");
  const crashed = call(a, "crash").catch(() => undefined);
  await crashedClosed;
  await crashed;
});

test("quit remains bounded if TCP traffic persistence does not answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const release = Promise.withResolvers();
  const audits = [];
  const runtime = new PluginRuntime({
    pluginTcp: { dispose: () => release.promise },
    audit: (entry) => audits.push(entry),
  });
  let finished = false;
  const stopped = runtime.disposeAll().then(() => { finished = true; });
  t.after(async () => { release.resolve(); await stopped; });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, true, "an unavailable usage store must not hold quit indefinitely");
  assert.ok(audits.some((entry) => entry.api === "net.tcp.flush" && entry.errorCode === "USAGE_WRITE_FAILED"));
});
