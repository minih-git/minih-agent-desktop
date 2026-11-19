/**
 * Credential injection on `pi.net.websocket.connect` (`credentials.use`).
 *
 * The real plugin process opens the socket through the real registry; only the
 * socket factory and the host store are fakes, so no server is involved. The
 * assertions are about the three things the boundary must guarantee:
 *
 *   - the handshake carries the header the user configured,
 *   - a refusal happens before a socket is created,
 *   - a peer's echo never comes back through an error event or a close reason,
 *     while message frames are forwarded untouched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginWebSocketRegistry } = await import("../electron/main/plugin-websocket.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));
const socketSource = readFileSync(
  new URL("../electron/main/plugin-websocket.ts", import.meta.url),
  "utf8",
);

const SECRET = "s3cr3t-ws-token";

const SLOTS = [
  { id: "api", kind: "bearer", fields: [{ key: "token", label: "Token", secret: true }] },
  { id: "mail", kind: "imap", fields: [{ key: "username", label: "User" }] },
  { id: "empty", kind: "bearer", fields: [{ key: "token", label: "Token", secret: true }] },
];

/** A transport that opens on the next tick and records what it was handed. */
function fakeTransport() {
  const opened = [];
  const factory = (init, handlers) => {
    const socket = {
      init,
      handlers,
      send: () => {},
      close: () => {},
      terminate: () => {},
      bufferedAmount: () => 0,
    };
    opened.push(socket);
    setTimeout(() => handlers.onOpen({ protocol: "" }), 0);
    return socket;
  };
  return { factory, opened };
}

const MAIN = `


const events = [];
globalThis.pi.events.on("net:websocket:error", (event) => events.push({ kind: "error", ...event }));
globalThis.pi.events.on("net:websocket:close", (event) => events.push({ kind: "close", ...event }));
globalThis.pi.events.on("net:websocket:message", (event) => events.push({ kind: "message", ...event }));

module.exports = {
  async onPanelInvoke(channel, payload) {
    if (channel === "connect") {
      try {
        return { ok: true, value: await globalThis.pi.net.websocket.connect(payload.input) };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    }
    if (channel === "events") return { events };
    throw new Error("unknown channel: " + channel);
  },
};
`;

async function fixture(t) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-credential-ws-"));

  const audits = [];
  const frames = [];
  const transport = fakeTransport();

  const writePlugin = (id, permissions) => {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      id,
      name: id,
      version: "1.0.0",
      main: "main.js",
      permissions: [...new Set([...permissions, "credentials.use"])],
      net: { domains: ["api.example.com", "other.example.net"] },
      contributes: {
        credentials: SLOTS.map((slot) => ({
          ...slot,
          title: slot.id,
          scope: { domains: ["api.example.com"] },
        })),
      },
    };
    return { dir, manifest };
  };

  const sockets = new PluginWebSocketRegistry({
    createSocket: transport.factory,
    onEvent: (pluginId, event) => runtime.deliverSocketEvent(pluginId, event),
  });

  const runtime = new PluginRuntime({
    hostEntry,
    pluginSockets: sockets,
    audit: (entry) => audits.push(entry),
    resolvePluginCredential: async (_pluginId, slotId) => {
      if (slotId === "empty") {
        throw Object.assign(new Error(`unset (${SECRET})`), {
          errorCode: "CREDENTIAL_NOT_CONFIGURED",
        });
      }
      return { token: SECRET };
    },
    listPluginCredentialSlots: async () => [],
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => {
          frames.push(JSON.parse(JSON.stringify(message)));
          if (child.connected) child.send(message);
        },
        onMessage: (handler) => child.on("message", (message) => {
          frames.push(JSON.parse(JSON.stringify(message)));
          handler(message);
        }),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    runtime.disposeWatchers();
    rmSync(root, { recursive: true, force: true });
  });

  for (const [id, permissions] of [
    ["test.ws", ["net.websocket", "credentials.use"]],
    ["test.ws-noperm", ["net.websocket"]],
  ]) {
    const { dir, manifest } = writePlugin(id, permissions);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
    writeFileSync(join(dir, "main.js"), MAIN, "utf8");
    await runtime.loadFromPath(dir, permissions);
  }

  const connect = (pluginId, input) =>
    runtime.invokePanelBridge(pluginId, "connect", { input });
  const events = (pluginId) => runtime.invokePanelBridge(pluginId, "events", {});

  return { runtime, transport, audits, frames, connect, events };
}

test("the handshake carries the slot's header and the answer keeps the code", async (t) => {
  const { transport, audits, frames, connect } = await fixture(t);
  const answer = await connect("test.ws", {
    url: "wss://api.example.com/live",
    headers: { "x-trace": "t1" },
    credentialRef: "api",
  });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.ok(answer.value.socketId);
  assert.equal(transport.opened.length, 1);
  assert.equal(transport.opened[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(transport.opened[0].init.headers["x-trace"], "t1");

  const entry = audits.find((item) => item.credential === "api");
  assert.equal(entry.ok, true);
  assert.equal(entry.socketId, answer.value.socketId);
  assert.equal(entry.scheme, "wss");
  assert.ok(!JSON.stringify(audits).includes(SECRET), "no audit record carries the value");
  assert.ok(!JSON.stringify(frames).includes(SECRET), "no sidecar message carries the credential");
});

test("plaintext WebSocket credential use records its scheme without the secret", async (t) => {
  const { transport, audits, connect } = await fixture(t);
  const answer = await connect("test.ws", { url: "ws://api.example.com/live", credentialRef: "api" });
  assert.equal(answer.ok, true);
  assert.equal(transport.opened[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(audits.find((entry) => entry.credential === "api")?.scheme, "ws");
  assert.ok(!JSON.stringify(audits).includes(SECRET));
});

test("an out-of-scope host, an imap slot, a missing permission and an unconfigured slot never open a socket", async (t) => {
  const { transport, connect } = await fixture(t);

  const scoped = await connect("test.ws", {
    url: "wss://other.example.net/live",
    credentialRef: "api",
  });
  assert.equal(scoped.ok, false);
  assert.equal(scoped.code, "PERMISSION_DENIED");

  const imap = await connect("test.ws", {
    url: "wss://api.example.com/live",
    credentialRef: "mail",
  });
  assert.equal(imap.ok, false);
  assert.equal(imap.code, "INVALID_ARGUMENT");

  const noperm = await connect("test.ws-noperm", {
    url: "wss://api.example.com/live",
    credentialRef: "api",
  });
  assert.equal(noperm.ok, false);
  assert.equal(noperm.code, "PERMISSION_DENIED");

  const unconfigured = await connect("test.ws", {
    url: "wss://api.example.com/live",
    credentialRef: "empty",
  });
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.code, "CREDENTIAL_NOT_CONFIGURED");
  assert.equal(unconfigured.message, "the credential slot is not configured");

  for (const credentialRef of [null, ["api"], 42]) {
    const invalid = await connect("test.ws", { url: "wss://api.example.com/live", credentialRef });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "INVALID_ARGUMENT");
  }

  assert.equal(transport.opened.length, 0, "no refusal reached the transport");
});

test("a failed handshake reports a constant message, never the transport's", async (t) => {
  const { runtime, connect } = await fixture(t);
  // A transport that fails with a message quoting the header it was given.
  const failing = new PluginWebSocketRegistry({
    createSocket: (_init, handlers) => {
      setTimeout(() => handlers.onError({ code: "SOCKET_ERROR", message: `boom ${SECRET}` }), 0);
      return { send: () => {}, close: () => {}, terminate: () => {}, bufferedAmount: () => 0 };
    },
    onEvent: (pluginId, event) => runtime.deliverSocketEvent(pluginId, event),
  });
  runtime.setServices({ pluginSockets: failing });

  const answer = await connect("test.ws", {
    url: "wss://api.example.com/live",
    credentialRef: "api",
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "CONNECT_FAILED");
  assert.equal(answer.message, "the connection failed");
  assert.ok(!JSON.stringify(answer).includes(SECRET));
});

test("error and close events are redacted while message frames are forwarded as sent", async (t) => {
  const { transport, frames, connect, events } = await fixture(t);
  const answer = await connect("test.ws", {
    url: "wss://api.example.com/live",
    credentialRef: "api",
  });
  assert.equal(answer.ok, true);

  const socket = transport.opened[0];
  socket.handlers.onMessage("frame-as-sent");
  socket.handlers.onError({ code: "SOCKET_ERROR", message: `echoed ${SECRET}` });
  socket.handlers.onClose({ code: 1008, reason: `policy ${SECRET}`, wasClean: false });

  // Frames between the broker and the sidecar are ordered, so the panel call
  // below is answered after the three events above were handled.
  const { events: received } = await events("test.ws");
  const kinds = received.map((event) => event.kind);
  assert.deepEqual(kinds, ["message", "error", "close"]);

  const message = received.find((event) => event.kind === "message");
  assert.equal(message.data, "frame-as-sent", "a frame is the plugin's own data");
  const error = received.find((event) => event.kind === "error");
  assert.equal(error.message, "the connection failed");
  const close = received.find((event) => event.kind === "close");
  assert.equal(close.code, 1008, "the code is preserved");
  assert.equal(close.reason, "", "the peer's reason text is dropped");
  assert.ok(!JSON.stringify(received).includes(SECRET), "no event carries the value");
  assert.ok(!JSON.stringify(frames).includes(SECRET), "no sidecar message carries the credential");
});

test("the default ws factory never follows a redirect", () => {
  // `ws` replays its handshake headers on a redirect, so the option is stated
  // rather than inherited from a library default.
  assert.match(socketSource, /followRedirects: false,/);
});