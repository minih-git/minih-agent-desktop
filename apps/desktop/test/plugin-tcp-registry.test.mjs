/**
 * Host-owned raw TCP/TLS connections (permission `net.tcp`).
 *
 * Every case here drives real `node:net` / `node:tls` sockets: a loopback echo
 * server for the byte paths, a server that never answers a handshake for the
 * connects that stay in flight, and a CA the test owns for the TLS rules. The
 * trust anchor is injected through the registry's dependencies; the
 * plugin-facing surface has no way to reach it, which is what the untrusted and
 * mismatched cases below prove.
 */
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  DEFAULT_CONNECT_TIMEOUT_MS,
  MAX_CONNECT_TIMEOUT_MS,
  MAX_CONNECTIONS_PER_PLUGIN,
  MAX_USAGE_RECORDS_PER_CALL,
  MAX_WRITE_BUFFER_BYTES,
  PluginTcpRegistry,
} = await import("../electron/main/plugin-tcp.ts");
// The TCP registry answers with the error type the WebSocket surface already
// uses, so one refusal code set reaches the plugin side.
const { PluginSocketError } = await import("../electron/main/plugin-websocket.ts");

const PLUGIN_ID = "com.example.mail";
const OTHER_PLUGIN = "com.example.other";
/** A connect that must not reach its own timer during a test. */
const SLOW_TIMEOUT = 30_000;

// Test-only PKI: one CA, a leaf for `localhost` and a leaf for `example.test`.
// Both leaves are valid from 2020 to 2049, so a machine clock anywhere in that
// window verifies them.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBTDCB86ADAgECAgIQADAKBggqhkjOPQQDAjAdMRswGQYDVQQDDBJwbHVnaW4t
dGNwIHRlc3QgQ0EwHhcNMjAwMTAxMDAwMDAwWhcNNDkxMjMxMDAwMDAwWjAdMRsw
GQYDVQQDDBJwbHVnaW4tdGNwIHRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAAQ9gDPjJSs35q8+fhMiWbcQGw9tiDl5OuLP1RtR4cQp/Cmhw9gCX3FLNiI9
LxJ0NZkrO5x920ogkerXL8J2vxoKoyMwITAPBgNVHRMBAf8EBTADAQH/MA4GA1Ud
DwEB/wQEAwIBBjAKBggqhkjOPQQDAgNIADBFAiArK1Fd78YK7MG7+6b0LCwfIoSp
K6hwAc0KbRDzFG+4GgIhAJUYz72c4QxhQuL6iBpYfhCXWnn14J+oFsEJ0ZQOFxbb
-----END CERTIFICATE-----`;

const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBcTCCARigAwIBAgICEAEwCgYIKoZIzj0EAwIwHTEbMBkGA1UEAwwScGx1Z2lu
LXRjcCB0ZXN0IENBMB4XDTIwMDEwMTAwMDAwMFoXDTQ5MTIzMTAwMDAwMFowFDES
MBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr6mv
eRoT56WuTylMyvLSg1JdsvWhm/w+Y6OrURZdsy6yqvGRKUYg9R9S0q//IyesevCe
2pI9zcHwDaIb69q1S6NRME8wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4Aw
EwYDVR0lBAwwCgYIKwYBBQUHAwEwGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAAB
MAoGCCqGSM49BAMCA0cAMEQCIAVPVrjhtp/+pPKabuGpHlLYaXMCnVKHQETLEyCS
we2XAiAbq4EYB05ZIoIpTLJ77mT/OeXh+p61nOz2gzUku2yZEQ==
-----END CERTIFICATE-----`;

const LOCALHOST_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIE+6JrEC49MJ13LM8ReLgfWfFn/qh6kVAw8HXEx8U0tuoAoGCCqGSM49
AwEHoUQDQgAEr6mveRoT56WuTylMyvLSg1JdsvWhm/w+Y6OrURZdsy6yqvGRKUYg
9R9S0q//IyesevCe2pI9zcHwDaIb69q1Sw==
-----END EC PRIVATE KEY-----`;

const OTHER_HOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBczCCARigAwIBAgICEAIwCgYIKoZIzj0EAwIwHTEbMBkGA1UEAwwScGx1Z2lu
LXRjcCB0ZXN0IENBMB4XDTIwMDEwMTAwMDAwMFoXDTQ5MTIzMTAwMDAwMFowFzEV
MBMGA1UEAwwMZXhhbXBsZS50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
2odzVp7WdsZpOqHJ3r1OOaE9fdYyxXD/NPC4FcgJUCZfAlKnKfAZEjZkZ9SXu6Sk
IHPIh7i0EggtkMo5T44NnKNOMEwwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMC
B4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwFwYDVR0RBBAwDoIMZXhhbXBsZS50ZXN0
MAoGCCqGSM49BAMCA0kAMEYCIQDwSqwrd2uhGWMNaEHGtJF/eLDZwJRlJe99plbh
z/yv/QIhALAUFDKga27SbfiLRSczS32R4ylwXOsDTaK2djtn4Pif
-----END CERTIFICATE-----`;

const OTHER_HOST_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIGS5akB5fknJTlEkWRY5NPkKwEPkCWCMqS3MWfoDV4oJoAoGCCqGSM49
AwEHoUQDQgAE2odzVp7WdsZpOqHJ3r1OOaE9fdYyxXD/NPC4FcgJUCZfAlKnKfAZ
EjZkZ9SXu6SkIHPIh7i0EggtkMo5T44NnA==
-----END EC PRIVATE KEY-----`;

// --- helpers ---------------------------------------------------------------

/** Start listening on a loopback port and hand back that port. */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** A real TCP server that records what it received and echoes it back. */
async function echoServer(t) {
  const sockets = [];
  const received = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write(chunk);
    });
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { server, sockets, received, port };
}

/** A real TLS server that echoes bytes and records the SNI it was given. */
async function tlsEchoServer(t, { cert, key }) {
  const sockets = [];
  const servernames = [];
  const received = [];
  const server = tls.createServer({ cert, key }, (socket) => {
    sockets.push(socket);
    servernames.push(socket.servername ?? null);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write(chunk);
    });
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { server, sockets, servernames, received, port };
}

/**
 * A server that accepts and then says nothing, so a TLS handshake never
 * completes: the only way to hold a connect in flight with a real socket.
 */
async function silentServer(t) {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    // Reading, not answering: a FIN is still noticed, so teardown is visible
    // on this side while the TLS handshake stays incomplete.
    socket.resume();
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { server, sockets, port };
}

/**
 * A peer that accepts, reads, and never finishes the close: `allowHalfOpen`
 * keeps its side open after our FIN, which is the only way to observe a
 * connection the plugin has closed but the socket has not torn down.
 */
async function halfClosedPeer(t) {
  const sockets = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.resume();
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { server, sockets, port };
}

function recorder() {
  const events = [];
  return { events, onEvent: (pluginId, event) => events.push({ pluginId, event }) };
}

/** Dispose in cleanup; a failure here was already asserted by the test body. */
function registryOf(t, dependencies) {
  const registry = new PluginTcpRegistry(dependencies);
  t.after(async () => {
    await registry.dispose().catch(() => {});
  });
  return registry;
}

function refusal(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof PluginSocketError, `expected PluginSocketError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** Poll until `check` holds; the sockets here settle in microseconds. */
async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the timeout");
}

function endpointOf(port, { host = "127.0.0.1", tls: secure = false } = {}) {
  return { host, port, tls: secure };
}

/** The day bucket the registry must produce: the local calendar day. */
function localDayKey(ms) {
  const date = new Date(ms);
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ].join("-");
}

// --- the published bounds --------------------------------------------------

test("the bounds are the ones the spec promises", () => {
  assert.equal(MAX_CONNECTIONS_PER_PLUGIN, 8);
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 15_000);
  assert.equal(MAX_CONNECT_TIMEOUT_MS, 60_000);
  assert.equal(MAX_WRITE_BUFFER_BYTES, 1024 * 1024);
});

// --- the byte path ---------------------------------------------------------

test("bytes travel over a real socket and the owner sees open, data and close", async (t) => {
  const server = await echoServer(t);
  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, connectTimeoutMs: SLOW_TIMEOUT });

  const { connectionId } = await registry.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(server.port),
  });
  assert.equal(events[0].event.type, "open");
  assert.deepEqual(registry.list(PLUGIN_ID), [
    { connectionId, host: "127.0.0.1", port: server.port, tls: false, state: "open" },
  ]);

  registry.send({ pluginId: PLUGIN_ID, connectionId, data: new Uint8Array([1, 2, 3]) });
  registry.send({ pluginId: PLUGIN_ID, connectionId, data: "ping" });

  // TCP is a stream: the two echoes may arrive in one read, so the assertion is
  // on the bytes rather than on the number of events.
  const frames = () => events.filter((entry) => entry.event.type === "data").map((entry) => entry.event.data);
  await waitFor(() => frames().reduce((total, chunk) => total + chunk.byteLength, 0) >= 7);
  assert.ok(frames().every((chunk) => chunk instanceof Uint8Array));
  const echoed = Buffer.concat(frames().map((chunk) => Buffer.from(chunk)));
  assert.deepEqual([...echoed.subarray(0, 3)], [1, 2, 3]);
  assert.equal(echoed.subarray(3).toString(), "ping");
  // Every event names the owner, not just the connection.
  assert.ok(events.every((entry) => entry.pluginId === PLUGIN_ID));

  registry.close({ pluginId: PLUGIN_ID, connectionId });
  // The handle is spent at the request, but the socket stays owned until it
  // really closes — a peer that stalls cannot hide a leaked descriptor.
  assert.deepEqual(
    registry.list(PLUGIN_ID).map((entry) => entry.state),
    ["closing"],
  );
  refusal(() => registry.send({ pluginId: PLUGIN_ID, connectionId, data: "late" }), "NOT_FOUND");
  refusal(() => registry.close({ pluginId: PLUGIN_ID, connectionId }), "NOT_FOUND");

  await waitFor(() => events.some((entry) => entry.event.type === "close"));
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  assert.deepEqual(events.find((entry) => entry.event.type === "close").event, {
    type: "close",
    connectionId,
    hadError: false,
  });
  await waitFor(() => server.sockets.every((socket) => socket.destroyed));
});

test("a peer that hangs up ends the connection for its owner", async (t) => {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.once("data", () => socket.end());
  });
  const port = await listen(server);
  t.after(() => server.close());

  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, connectTimeoutMs: SLOW_TIMEOUT });
  const { connectionId } = await registry.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(port),
  });

  registry.send({ pluginId: PLUGIN_ID, connectionId, data: "bye" });
  await waitFor(() => events.some((entry) => entry.event.type === "close"));
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  refusal(() => registry.send({ pluginId: PLUGIN_ID, connectionId, data: "late" }), "NOT_FOUND");
});

// --- TLS -------------------------------------------------------------------

test("TLS verifies the peer and sends the endpoint host as SNI", async (t) => {
  const server = await tlsEchoServer(t, { cert: LOCALHOST_CERT, key: LOCALHOST_KEY });
  const { events, onEvent } = recorder();
  // The anchor is a dependency of the host side; a plugin call cannot reach it.
  const registry = registryOf(t, { onEvent, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const { connectionId } = await registry.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(server.port, { host: "localhost", tls: true }),
  });
  registry.send({ pluginId: PLUGIN_ID, connectionId, data: "secure" });

  await waitFor(() => events.some((entry) => entry.event.type === "data"));
  assert.equal(
    Buffer.from(events.find((entry) => entry.event.type === "data").event.data).toString(),
    "secure",
  );
  assert.deepEqual(server.servernames, ["localhost"]);
});

test("a plugin process connects, exchanges bytes, and closes over verified TLS", async (t) => {
  const server = await tlsEchoServer(t, { cert: LOCALHOST_CERT, key: LOCALHOST_KEY });
  const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "tcp-tls-plugin-"));
  const previousDataDir = process.env.MINIH_AGENT_DATA_DIR;
  process.env.MINIH_AGENT_DATA_DIR = dir;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: PLUGIN_ID, name: "TLS fixture", version: "1.0.0", main: "main.js",
    permissions: ["net.tcp"], net: { tcp: [{ host: "localhost", port: server.port, tls: true }] },
  }));
  writeFileSync(join(dir, "main.js"), `
    const events = [];
    const waiters = [];
    module.exports = {
      onLoad() {
        for (const type of ['data', 'close']) pi.events.on('net:tcp:' + type, event => {
          events.push({type, event});
          for (const waiter of [...waiters]) if (waiter.type === type) {
            waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event);
          }
        });
      },
      async onPanelInvoke(action, input) {
        if (action === 'connect') return pi.net.tcp.connect(input);
        if (action === 'send') return pi.net.tcp.send({connectionId:input.connectionId, data:new Uint8Array([0, 1, 255])});
        if (action === 'close') return pi.net.tcp.close(input);
        if (action === 'wait') {
          const found = events.find(item => item.type === input.type);
          return found ? found.event : new Promise(resolve => waiters.push({type:input.type, resolve}));
        }
      },
    };
  `);
  const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
  let runtime;
  const registry = new PluginTcpRegistry({ tlsCa: TEST_CA, onEvent: (id, event) => runtime.deliverTcpEvent(id, event) });
  const spawnProcess = ({ entry }) => {
    const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
    return {
      postMessage: (message) => { if (child.connected) child.send(message); },
      onMessage: (handler) => child.on("message", handler),
      onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
      kill: () => child.kill(),
    };
  };
  runtime = new PluginRuntime({ hostEntry: join(here, "../electron/main/plugin-host-process.mjs"), spawnProcess, pluginTcp: registry });
  t.after(async () => {
    await runtime.disposeAll();
    if (previousDataDir === undefined) delete process.env.MINIH_AGENT_DATA_DIR;
    else process.env.MINIH_AGENT_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  });
  await runtime.loadFromPath(dir);
  const call = (action, input) => runtime.invokePanelBridge(PLUGIN_ID, action, input);
  const { connectionId } = await call("connect", { endpoint: { host: "localhost", port: server.port } });
  await call("send", { connectionId });
  const received = await call("wait", { type: "data" });
  assert.deepEqual([...received.data], [0, 1, 255]);
  await call("close", { connectionId });
  assert.equal((await call("wait", { type: "close" })).connectionId, connectionId);
  assert.deepEqual(server.servernames, ["localhost"]);
});

test("a certificate chain the host does not trust is refused", async (t) => {
  const server = await tlsEchoServer(t, { cert: LOCALHOST_CERT, key: LOCALHOST_KEY });
  const registry = registryOf(t, { onEvent: () => {}, connectTimeoutMs: SLOW_TIMEOUT });

  await assert.rejects(
    registry.connect({
      pluginId: PLUGIN_ID,
      endpoint: endpointOf(server.port, { host: "localhost", tls: true }),
    }),
    (error) => {
      assert.ok(error instanceof PluginSocketError);
      assert.equal(error.code, "CONNECT_FAILED");
      assert.match(error.message, /self-signed|certificate/i);
      return true;
    },
  );
  // A refused connect leaves no slot and no live socket behind.
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  await waitFor(() => server.sockets.every((socket) => socket.destroyed));
});

test("a certificate for another host does not open a connection to this one", async (t) => {
  const server = await tlsEchoServer(t, { cert: OTHER_HOST_CERT, key: OTHER_HOST_KEY });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  await assert.rejects(
    registry.connect({
      pluginId: PLUGIN_ID,
      endpoint: endpointOf(server.port, { host: "localhost", tls: true }),
    }),
    (error) => {
      assert.equal(error.code, "CONNECT_FAILED");
      assert.match(error.message, /does not match|altnames/i);
      return true;
    },
  );
  assert.deepEqual(registry.list(PLUGIN_ID), []);
});

// --- bounds ----------------------------------------------------------------

test("an endpoint the registry cannot dial is refused before a socket exists", async (t) => {
  const registry = registryOf(t, { onEvent: () => {} });
  const shapes = [
    { host: "", port: 25, tls: false },
    { host: "localhost", port: 0, tls: false },
    { host: "localhost", port: 70_000, tls: false },
    { host: "localhost", port: 25.5, tls: true },
    { host: "localhost", port: 25 },
    "localhost:25",
  ];
  for (const endpoint of shapes) {
    await assert.rejects(
      registry.connect({ pluginId: PLUGIN_ID, endpoint }),
      (error) => error.code === "INVALID_ARGUMENT",
      `endpoint ${JSON.stringify(endpoint)} should be refused`,
    );
  }
  await assert.rejects(
    registry.connect({ pluginId: PLUGIN_ID, endpoint: endpointOf(25), timeoutMs: 0 }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    registry.connect({ pluginId: "", endpoint: endpointOf(25) }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  assert.deepEqual(registry.list(PLUGIN_ID), []);
});

test("one budget per plugin, and a connect in flight spends one", async (t) => {
  const silent = await silentServer(t);
  const { onEvent } = recorder();
  const registry = registryOf(t, { onEvent, connectTimeoutMs: SLOW_TIMEOUT });

  const attempts = [];
  for (let index = 0; index < MAX_CONNECTIONS_PER_PLUGIN; index += 1) {
    attempts.push(
      registry
        .connect({
          pluginId: PLUGIN_ID,
          endpoint: endpointOf(silent.port, { tls: true }),
        })
        .catch((error) => error),
    );
  }
  await waitFor(
    () =>
      registry.list(PLUGIN_ID).filter((entry) => entry.state === "connecting").length ===
      MAX_CONNECTIONS_PER_PLUGIN,
  );
  await assert.rejects(
    registry.connect({ pluginId: PLUGIN_ID, endpoint: endpointOf(silent.port, { tls: true }) }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  // The budget is per plugin, not global.
  const other = registry
    .connect({ pluginId: OTHER_PLUGIN, endpoint: endpointOf(silent.port, { tls: true }) })
    .catch((error) => error);
  assert.equal(registry.list(OTHER_PLUGIN).length, 1);

  // Releasing the plugin answers every connect still waiting on it.
  registry.releasePlugin(PLUGIN_ID);
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  for (const attempt of attempts) {
    const error = await attempt;
    assert.ok(error instanceof PluginSocketError, `expected a refusal, got ${error}`);
    assert.equal(error.code, "CONNECT_FAILED");
  }
  await waitFor(() => silent.sockets.filter((socket) => !socket.destroyed).length <= 1);

  registry.releasePlugin("com.example.never-loaded");
  // The other plugin's connect is only answered by its own release.
  registry.releasePlugin(OTHER_PLUGIN);
  const answer = await other;
  assert.equal(answer.code, "CONNECT_FAILED");
  await waitFor(() => silent.sockets.every((socket) => socket.destroyed));
});

test("a connect that never completes times out and frees its slot", async (t) => {
  const silent = await silentServer(t);
  const registry = registryOf(t, { onEvent: () => {} });

  await assert.rejects(
    registry.connect({
      pluginId: PLUGIN_ID,
      endpoint: endpointOf(silent.port, { tls: true }),
      timeoutMs: 60,
    }),
    (error) => error.code === "TIMEOUT",
  );
  // The slot is free as soon as the answer is given, not when the socket dies.
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  await waitFor(() => silent.sockets.every((socket) => socket.destroyed));
});

test("the write buffer is bounded and a refused send writes nothing", async (t) => {
  const server = await echoServer(t);
  const strict = registryOf(t, {
    onEvent: () => {},
    maxWriteBufferBytes: 8,
    connectTimeoutMs: SLOW_TIMEOUT,
  });
  const { connectionId } = await strict.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(server.port),
  });

  refusal(
    () => strict.send({ pluginId: PLUGIN_ID, connectionId, data: new Uint8Array(9) }),
    "LIMIT_EXCEEDED",
  );
  strict.send({ pluginId: PLUGIN_ID, connectionId, data: new Uint8Array(8) });
  await waitFor(() => server.received.length === 1);
  assert.equal(server.received[0].length, 8);

  // The default ceiling refuses one write above a mebibyte.
  const normal = registryOf(t, { onEvent: () => {}, connectTimeoutMs: SLOW_TIMEOUT });
  const open = await normal.connect({ pluginId: PLUGIN_ID, endpoint: endpointOf(server.port) });
  refusal(
    () =>
      normal.send({
        pluginId: PLUGIN_ID,
        connectionId: open.connectionId,
        data: new Uint8Array(MAX_WRITE_BUFFER_BYTES + 1),
      }),
    "LIMIT_EXCEEDED",
  );
  refusal(
    () =>
      normal.send({
        pluginId: PLUGIN_ID,
        connectionId: open.connectionId,
        data: { not: "bytes" },
      }),
    "INVALID_ARGUMENT",
  );
});

// --- ownership -------------------------------------------------------------

test("a handle belongs to one plugin; anyone else's guess is NOT_FOUND", async (t) => {
  const server = await echoServer(t);
  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, connectTimeoutMs: SLOW_TIMEOUT });

  const mine = await registry.connect({ pluginId: PLUGIN_ID, endpoint: endpointOf(server.port) });
  const theirs = await registry.connect({
    pluginId: OTHER_PLUGIN,
    endpoint: endpointOf(server.port),
  });

  refusal(
    () =>
      registry.send({ pluginId: OTHER_PLUGIN, connectionId: mine.connectionId, data: "x" }),
    "NOT_FOUND",
  );
  refusal(
    () => registry.close({ pluginId: OTHER_PLUGIN, connectionId: mine.connectionId }),
    "NOT_FOUND",
  );
  refusal(() => registry.send({ pluginId: PLUGIN_ID, connectionId: "tcp-9001", data: "x" }), "NOT_FOUND");
  refusal(() => registry.close({ pluginId: PLUGIN_ID, connectionId: "tcp-9001" }), "NOT_FOUND");

  registry.send({ pluginId: OTHER_PLUGIN, connectionId: theirs.connectionId, data: "theirs" });
  await waitFor(() => events.some((entry) => entry.pluginId === OTHER_PLUGIN && entry.event.type === "data"));
  assert.equal(events.filter((entry) => entry.pluginId === PLUGIN_ID && entry.event.type === "data").length, 0);

  registry.close({ pluginId: PLUGIN_ID, connectionId: mine.connectionId });
  refusal(() => registry.close({ pluginId: PLUGIN_ID, connectionId: mine.connectionId }), "NOT_FOUND");
  refusal(
    () => registry.send({ pluginId: PLUGIN_ID, connectionId: mine.connectionId, data: "x" }),
    "NOT_FOUND",
  );
});

// --- usage -----------------------------------------------------------------

test("traffic is totalled per local day and peer, and a live connection crosses midnight", async (t) => {
  const server = await echoServer(t);
  const { events, onEvent } = recorder();
  const batches = [];
  // Evening of 15 January in the machine's own zone: the local day, not UTC.
  let clock = new Date(2026, 0, 15, 23, 58, 0).getTime();
  const registry = registryOf(t, {
    onEvent,
    onUsage: (usage) => batches.push(usage),
    now: () => clock,
    connectTimeoutMs: SLOW_TIMEOUT,
  });

  const { connectionId } = await registry.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(server.port),
  });
  registry.send({ pluginId: PLUGIN_ID, connectionId, data: new Uint8Array([1, 2, 3, 4, 5]) });
  await waitFor(() => events.some((entry) => entry.event.type === "data"));
  await registry.flush();
  assert.deepEqual(batches.flat(), [
    {
      day: localDayKey(new Date(2026, 0, 15, 23, 58, 0).getTime()),
      pluginId: PLUGIN_ID,
      host: "127.0.0.1",
      port: server.port,
      bytesIn: 5,
      bytesOut: 5,
    },
  ]);

  // The same connection keeps counting after local midnight, into the next row.
  clock = new Date(2026, 0, 16, 0, 2, 0).getTime();
  registry.send({ pluginId: PLUGIN_ID, connectionId, data: new Uint8Array(2) });
  await waitFor(() => events.filter((entry) => entry.event.type === "data").length >= 2);
  await registry.flush();
  assert.deepEqual(batches.at(-1), [
    {
      day: localDayKey(new Date(2026, 0, 16, 0, 2, 0).getTime()),
      pluginId: PLUGIN_ID,
      host: "127.0.0.1",
      port: server.port,
      bytesIn: 2,
      bytesOut: 2,
    },
  ]);
});

test("a failing usage store keeps the totals instead of dropping them", async (t) => {
  const server = await echoServer(t);
  const { events, onEvent } = recorder();
  const written = [];
  const failures = [];
  let storeDown = true;
  const registry = registryOf(t, {
    onEvent,
    onUsage: async (usage) => {
      if (storeDown) throw new Error("store is down");
      written.push(...usage);
    },
    onUsageError: (error) => failures.push(error),
    connectTimeoutMs: SLOW_TIMEOUT,
  });

  const { connectionId } = await registry.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(server.port),
  });
  registry.send({ pluginId: PLUGIN_ID, connectionId, data: new Uint8Array([1, 2, 3]) });
  await waitFor(() => events.some((entry) => entry.event.type === "data"));

  await assert.rejects(registry.flush(), /store is down/);
  assert.deepEqual(written, []);
  // The close path flushes in the background and reports the same failure.
  registry.close({ pluginId: PLUGIN_ID, connectionId });
  await waitFor(() => failures.length > 0);

  storeDown = false;
  await registry.flush();
  assert.deepEqual(
    written.map((record) => [record.bytesIn, record.bytesOut]),
    [[3, 3]],
    "the batch that failed is written unchanged on the retry",
  );
});

test("usage is written on a timer as well as on close, and dispose stops the timer", async (t) => {
  const server = await echoServer(t);
  const written = [];
  const { events, onEvent } = recorder();
  const registry = new PluginTcpRegistry({
    onEvent,
    onUsage: (usage) => written.push(...usage),
    usageFlushIntervalMs: 20,
    connectTimeoutMs: SLOW_TIMEOUT,
  });

  const { connectionId } = await registry.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(server.port),
  });
  registry.send({ pluginId: PLUGIN_ID, connectionId, data: "timer" });
  await waitFor(() => written.length === 1);
  assert.equal(written[0].bytesOut, 5);

  // Consume the echo first, so the last row is written by dispose itself and no
  // tick can add one after the snapshot below.
  await waitFor(() => events.some((entry) => entry.event.type === "data"));
  await registry.dispose();
  const afterDispose = written.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(written.length, afterDispose, "the batch timer is gone after dispose");
});

// --- teardown --------------------------------------------------------------

test("dispose settles a connect still waiting and closes live connections", async (t) => {
  const silent = await silentServer(t);
  const registry = new PluginTcpRegistry({ onEvent: () => {}, connectTimeoutMs: SLOW_TIMEOUT });
  const pending = registry
    .connect({ pluginId: PLUGIN_ID, endpoint: endpointOf(silent.port, { tls: true }) })
    .catch((error) => error);
  // Registered before the first await, so the budget sees it.
  assert.equal(registry.list(PLUGIN_ID).length, 1);

  await registry.dispose();
  const error = await pending;
  assert.ok(error instanceof PluginSocketError, `expected a refusal, got ${error}`);
  assert.equal(error.code, "CONNECT_FAILED");
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  await waitFor(() => silent.sockets.every((socket) => socket.destroyed));
});

// --- closing keeps the descriptor ------------------------------------------

test("a half-closed connection is still owned, still counted, and destroyed on release", async (t) => {
  const peer = await halfClosedPeer(t);
  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, connectTimeoutMs: SLOW_TIMEOUT });

  const closed = [];
  for (let index = 0; index < MAX_CONNECTIONS_PER_PLUGIN; index += 1) {
    const { connectionId } = await registry.connect({
      pluginId: PLUGIN_ID,
      endpoint: endpointOf(peer.port),
    });
    registry.close({ pluginId: PLUGIN_ID, connectionId });
    closed.push(connectionId);
  }

  // The peer never finishes, so every socket is still open and still ours.
  assert.deepEqual(
    registry.list(PLUGIN_ID).map((entry) => entry.state),
    Array.from({ length: MAX_CONNECTIONS_PER_PLUGIN }, () => "closing"),
  );
  await assert.rejects(
    registry.connect({ pluginId: PLUGIN_ID, endpoint: endpointOf(peer.port) }),
    (error) => error.code === "LIMIT_EXCEEDED",
    "every half-closed socket still counts against the limit",
  );
  refusal(
    () => registry.send({ pluginId: PLUGIN_ID, connectionId: closed[0], data: "x" }),
    "NOT_FOUND",
  );
  assert.equal(events.filter((entry) => entry.event.type === "close").length, 0);

  // Unload can still destroy them right now, and reports the end to the owner.
  // (The peer, still holding its side open, sees nothing: the point is that the
  // host no longer holds the descriptor and says so once per connection.)
  registry.releasePlugin(PLUGIN_ID);
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  await waitFor(
    () => events.filter((entry) => entry.event.type === "close").length === MAX_CONNECTIONS_PER_PLUGIN,
  );
});

// --- one usage call, one plugin, one day -----------------------------------

test("each usage call is one plugin and one day, and only the failed group is retried", async (t) => {
  const server = await echoServer(t);
  const { events, onEvent } = recorder();
  const calls = [];
  const written = [];
  let refuseMine = true;
  const registry = registryOf(t, {
    onEvent,
    onUsage: async (usage) => {
      calls.push(usage.map((record) => `${record.pluginId}|${record.day}`));
      if (refuseMine && usage[0].pluginId === PLUGIN_ID) throw new Error("this plugin's row is refused");
      written.push(...usage);
    },
    connectTimeoutMs: SLOW_TIMEOUT,
  });

  for (const pluginId of [PLUGIN_ID, OTHER_PLUGIN]) {
    const { connectionId } = await registry.connect({
      pluginId,
      endpoint: endpointOf(server.port),
    });
    registry.send({ pluginId, connectionId, data: new Uint8Array(4) });
  }
  await waitFor(() => events.filter((entry) => entry.event.type === "data").length >= 2);

  await assert.rejects(registry.flush(), /refused/);
  // Every call carried exactly one plugin and one day, inside the row ceiling.
  assert.ok(
    calls.every((call) => new Set(call).size === 1),
    `a call mixed groups: ${JSON.stringify(calls)}`,
  );
  assert.ok(calls.every((call) => call.length <= MAX_USAGE_RECORDS_PER_CALL));
  // The group that committed is not in the queue any more; the refused one is.
  assert.deepEqual(written.map((record) => record.pluginId), [OTHER_PLUGIN]);

  refuseMine = false;
  await registry.flush();
  assert.deepEqual(
    written.map((record) => [record.pluginId, record.bytesIn, record.bytesOut]),
    [
      [OTHER_PLUGIN, 4, 4],
      [PLUGIN_ID, 4, 4],
    ],
    "a group that already committed is never written twice",
  );
});

// --- no proxy ---------------------------------------------------------------

test("no HTTP proxy is consulted for a raw socket", async (t) => {
  const server = await echoServer(t);
  const saved = {};
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    saved[name] = process.env[name];
    // A dead port: anything that honoured the proxy would fail here.
    process.env[name] = "http://127.0.0.1:1";
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, connectTimeoutMs: SLOW_TIMEOUT });
  const { connectionId } = await registry.connect({
    pluginId: PLUGIN_ID,
    endpoint: endpointOf(server.port),
  });
  registry.send({ pluginId: PLUGIN_ID, connectionId, data: "direct" });
  await waitFor(() => events.some((entry) => entry.event.type === "data"));
  assert.equal(
    Buffer.from(events.find((entry) => entry.event.type === "data").event.data).toString(),
    "direct",
  );
});