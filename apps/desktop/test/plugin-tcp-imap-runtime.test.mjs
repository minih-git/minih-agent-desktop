/**
 * IMAP credentials over host-owned TCP, seen from a real plugin sidecar
 * (`net.tcp` + `credentials.use` + a declared `contributes.credentials` slot).
 *
 * The suite runs the path a mailbox plugin actually takes, starting where the
 * settings page ends:
 *
 *   settings → IPC `plugin/credentials/set` (real handler)
 *            → host RPC `plugins.credentials.set` (stub store)
 *   plugin   → `pi.net.tcp.connect({ endpoint, credentialRef })` (real sidecar)
 *            → runtime → `resolvePluginCredential` → host RPC
 *              `plugins.credentials.resolve` (same store, same resolver the
 *              main process wires in `plugin-services.ts`)
 *            → registry authenticates over implicit TLS before the connection
 *              opens.
 *
 * Only the host side of that chain is simulated: the Rust host-core storage
 * behind `plugins.credentials.*` (a Map here), and the React form above the IPC
 * channel (covered by `plugin-settings-credentials-user-path.test.mjs`). The
 * credential the TLS server sees is therefore the one saved through the
 * settings IPC, not a value this file handed to the runtime.
 *
 * Every sidecar frame in either direction is recorded, which is what makes the
 * central promise checkable: the user name, the password, and both encodings a
 * credential could travel in must never appear in a message the plugin process
 * can read. (The plugin's own `manifest.json` does reach it — including the
 * `password` field *declaration* — so only values are asserted here.)
 *
 * Isolation: `MINIH_AGENT_DATA_DIR` points at a scratch directory (and the
 * runner sets an isolated `HOME`), so no user plugin state or credential is
 * touched. Only the host-side trust anchor the registry tests already use is
 * injected; nothing here widens it.
 */
import assert from "node:assert/strict";
import tls from "node:tls";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC } from "@minih-agent/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// A private data directory: nothing here may touch the user's plugin state.
const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();
const dataDir = mkdtempSync(join(scratch, "tcp-imap-runtime-"));
process.env.MINIH_AGENT_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginTcpRegistry } = await import("../electron/main/plugin-tcp.ts");
const { registerPluginCredentialIpc } = await import("../electron/main/ipc/plugin-credentials-ipc.ts");
const { resolvePluginCredential: resolveStoredCredential } = await import(
  "../electron/main/plugin-credential-slots.ts"
);

const ENTRY = join(here, "../electron/main/plugin-host-process.mjs");
/** A connect that must not reach its own timer during a test. */
const SLOW_TIMEOUT = 30_000;

const USER = "alice@example.test";
const PASSWORD = "s3cret-imap-password";

// Test-only PKI: one CA and a `localhost` leaf, identical to the registry and
// IMAP login tests. Valid 2020–2049, so a machine clock anywhere in that window
// verifies.
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

/** The sidecar: a mailbox plugin that only ever names a slot. */
const PLUGIN_MAIN = `
const seen = [];
const waiters = [];
function text() {
  return seen.filter(item => item.type === 'data')
    .map(item => Buffer.from(item.event.data).toString('utf8')).join('');
}
function notify(type, event) {
  seen.push({ type, event });
  for (const waiter of [...waiters]) {
    if (waiter.type !== type) continue;
    if (waiter.match && !waiter.match(event)) continue;
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(event);
  }
}
function waitFor(type, match) {
  return new Promise(resolve => waiters.push({ type, match, resolve }));
}
function textUntil(needle) {
  if (text().includes(needle)) return Promise.resolve(text());
  return waitFor('data', () => text().includes(needle)).then(() => text());
}
module.exports = {
  onLoad() {
    for (const type of ['open', 'data', 'close', 'error']) {
      pi.events.on('net:tcp:' + type, event => notify(type, event));
    }
  },
  async onPanelInvoke(action, input) {
    if (action === 'connect') return pi.net.tcp.connect(input);
    if (action === 'select') {
      const result = await pi.net.tcp.connect(input);
      await pi.net.tcp.send({ connectionId: result.connectionId, data: 'A1 SELECT INBOX\\r\\n' });
      return Object.assign({}, result, { text: await textUntil('A1 OK') });
    }
    if (action === 'text') return text();
    if (action === 'close') return pi.net.tcp.close(input);
    throw new Error('unknown action: ' + action);
  },
};
`;

// --- helpers ---------------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** `{ tag, name, args }` for a tagged command; a continuation has no verb. */
function parseCommand(line) {
  const match = /^(\S+) ([A-Za-z][A-Za-z0-9._-]*)(?: (.*))?$/.exec(line);
  if (!match) return { tag: null, name: null, args: "", line };
  return { tag: match[1], name: match[2].toUpperCase(), args: match[3] ?? "", line };
}

/**
 * A real TLS IMAP server. It answers `CAPABILITY` itself, records every line it
 * received, and leaves the rest of the dialogue to the case that owns it.
 */
async function imapServer(t, { greeting, respond } = {}) {
  const sockets = [];
  const lines = [];
  const chunks = [];
  const advertised = /\[CAPABILITY ([^\]]*)\]/.exec(greeting ?? "");
  const capabilities = advertised ? advertised[1].split(" ") : ["IMAP4rev1"];

  const server = tls.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    if (greeting) socket.write(`${greeting}\r\n`);
    let pending = "";
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      pending += chunk.toString("utf8");
      let index = pending.indexOf("\r\n");
      while (index !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        lines.push(line);
        const command = parseCommand(line);
        const reply = (value) => socket.write(`${value}\r\n`);
        if (command.name === "CAPABILITY") {
          reply(`* CAPABILITY ${capabilities.join(" ")}`);
          reply(`${command.tag} OK CAPABILITY completed`);
        } else {
          respond?.({ command, reply });
        }
        index = pending.indexOf("\r\n");
      }
    });
  });

  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return {
    port,
    sockets,
    lines,
    text: () => Buffer.concat(chunks).toString("utf8"),
    named: (name) => lines.map(parseCommand).filter((command) => command.name === name),
  };
}

/** One declared IMAP slot; the shape the manifest schema accepts. */
function imapSlot(overrides = {}) {
  return {
    id: "imap",
    title: "Mailbox",
    kind: "imap",
    fields: [
      { key: "username", label: "User" },
      { key: "password", label: "Password", secret: true },
    ],
    scope: { domains: ["localhost"] },
    ...overrides,
  };
}

/**
 * The host side of `plugins.credentials.*`: the same four calls the main
 * process makes, answered from memory. This stands in for host-core's Rust
 * store; every value here is written through the settings IPC, never by the
 * test body.
 */
function credentialHost() {
  const declared = new Map();
  const stored = new Map();
  const calls = [];
  const key = (pluginId, slotId) => `${pluginId}\u0000${slotId}`;
  return {
    calls,
    declare(pluginId, slots) {
      declared.set(pluginId, slots);
    },
    async call(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "plugins.credentials.set":
          stored.set(key(params.pluginId, params.slotId), { ...params.fields });
          return undefined;
        case "plugins.credentials.clear":
          stored.delete(key(params.pluginId, params.slotId));
          return undefined;
        case "plugins.credentials.resolve": {
          const fields = stored.get(key(params.pluginId, params.slotId));
          if (!fields) {
            throw Object.assign(new Error("credential slot is not configured"), {
              errorCode: "CREDENTIAL_NOT_CONFIGURED",
            });
          }
          return { fields };
        }
        case "plugins.credentials.status":
          return {
            slots: (declared.get(params.pluginId) ?? []).map((slot) => ({
              ...slot,
              configured: stored.has(key(params.pluginId, slot.id)),
              lastUsedAt: null,
            })),
          };
        default:
          throw new Error(`unexpected host call: ${method}`);
      }
    },
  };
}

/** The settings page's end of the wire: the real IPC handlers, called as main. */
function credentialSettings(host) {
  const handlers = new Map();
  const registrar = {
    handleWithEvent(channel, handler) {
      handlers.set(channel, handler);
    },
    assertMainWindowSender(event) {
      if (!event?.main) throw new Error("unauthorized sender");
    },
  };
  registerPluginCredentialIpc(
    registrar,
    () => host,
    () => undefined,
    () => false,
  );
  const send = (channel, input, main = true) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ main }, input);
  };
  return {
    send,
    save: (pluginId, slotId, fields) =>
      send(IPC.invoke.pluginCredentialsSet, { pluginId, slotId, fields }),
    status: (pluginId) => send(IPC.invoke.pluginCredentialsStatus, { pluginId }),
    clear: (pluginId, slotId) => send(IPC.invoke.pluginCredentialsClear, { pluginId, slotId }),
  };
}

function writePlugin(root, spec, host) {
  const dir = join(root, spec.id);
  mkdirSync(dir, { recursive: true });
  const slots = spec.slots ?? [imapSlot()];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: spec.id,
      name: spec.id,
      version: "1.0.0",
      main: "main.js",
      permissions: ["net.tcp", "credentials.use"],
      net: { tcp: spec.endpoints },
      contributes: { credentials: slots },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_MAIN, "utf8");
  // What host-core learns from the installed manifest, so `status` can answer.
  host.declare(spec.id, slots);
  return dir;
}

/**
 * Broker + registry + real sidecars, wired the way `plugin-services.ts` wires
 * them: the runtime resolves a slot through `resolvePluginCredential`, which
 * asks the host RPC. `granted` narrows what a load may keep, exactly as a
 * recorded permission answer would.
 */
async function harness(t, specs, resolveOverride) {
  const root = mkdtempSync(join(dataDir, "plugins-"));
  const frames = [];
  const audits = [];
  const host = credentialHost();
  const settings = credentialSettings(host);
  let runtime;
  const registry = new PluginTcpRegistry({
    tlsCa: TEST_CA,
    connectTimeoutMs: SLOW_TIMEOUT,
    onEvent: (pluginId, event) => runtime.deliverTcpEvent(pluginId, event),
  });
  runtime = new PluginRuntime({
    hostEntry: ENTRY,
    pluginTcp: registry,
    audit: (entry) => audits.push(entry),
    resolvePluginCredential: resolveOverride ?? ((pluginId, slotId) => resolveStoredCredential(host.call, pluginId, slotId)),
    spawnProcess: ({ entry: childEntry }) => {
      const child = fork(childEntry, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "advanced",
      });
      const record = (message) => frames.push(JSON.parse(JSON.stringify(message)));
      return {
        postMessage: (message) => {
          record(message);
          if (child.connected) child.send(message);
        },
        onMessage: (handler) =>
          child.on("message", (message) => {
            record(message);
            handler(message);
          }),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.disposeAll();
    await registry.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  for (const spec of specs) await runtime.loadFromPath(writePlugin(root, spec, host), spec.granted);
  return {
    registry,
    runtime,
    frames,
    audits,
    host,
    settings,
    call: (pluginId, action, input) => runtime.invokePanelBridge(pluginId, action, input),
  };
}

/** The two encodings this path could put a credential into. */
function encodings() {
  return {
    plain: Buffer.from(`\u0000${USER}\u0000${PASSWORD}`, "utf8").toString("base64"),
    basic: Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64"),
  };
}

function assertNoCredentialInFrames(frames, label) {
  const wire = JSON.stringify(frames);
  const { plain, basic } = encodings();
  for (const [name, value] of [
    ["the user name", USER],
    ["the password", PASSWORD],
    ["the SASL PLAIN payload", plain],
    ["the basic credential", basic],
  ]) {
    assert.ok(!wire.includes(value), `${label}: ${name} reached a sidecar message`);
  }
}

function refusal(promise, code, pattern) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

// --- the representative user path -----------------------------------------

test("a slot saved in settings is what the sidecar plugin logs in with", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE") reply(`${command.tag} OK authenticated`);
      if (command.name === "SELECT") {
        reply("* 1 EXISTS");
        reply(`${command.tag} OK SELECT completed`);
      }
    },
  });
  const pluginId = "test.mailbox";
  const { call, frames, audits, registry, settings, host } = await harness(t, [
    {
      id: pluginId,
      endpoints: [{ host: "localhost", port: server.port, tls: true }],
    },
  ]);
  const connectInput = { endpoint: { host: "localhost", port: server.port }, credentialRef: "imap" };

  // Nothing is stored yet: the runtime reads the slot through the host, so the
  // connect is refused instead of dialing with a value the test invented.
  await refusal(call(pluginId, "connect", connectInput), "CREDENTIAL_NOT_CONFIGURED", /not configured/);
  assert.equal(server.sockets.length, 0, "an unconfigured slot must not open a socket");

  // The settings page writes the credential: real IPC channel, real handler,
  // real host RPC shape.
  await settings.save(pluginId, "imap", { username: USER, password: PASSWORD });
  const saved = host.calls.find((entry) => entry.method === "plugins.credentials.set");
  assert.deepEqual(saved?.params, {
    pluginId,
    slotId: "imap",
    fields: { username: USER, password: PASSWORD },
  });

  // Reading it back from the settings page yields state and declared metadata,
  // never the value.
  const status = await settings.status(pluginId);
  assert.equal(status.slots.length, 1);
  assert.equal(status.slots[0].id, "imap");
  assert.equal(status.slots[0].configured, true);
  assert.equal(status.slots[0].kind, "imap");
  assert.deepEqual(
    status.slots[0].fields.map((field) => [field.key, field.secret === true]),
    [["username", false], ["password", true]],
  );
  assert.ok(!JSON.stringify(status).includes(PASSWORD), "the status answer must not carry the value");
  assert.ok(!JSON.stringify(status).includes(USER), "the status answer must not carry the value");

  // The plugin opens the mailbox: it names the slot, the host logs in.
  const result = await call(pluginId, "select", connectInput);
  assert.equal(result.authenticated, true);
  assert.equal(typeof result.connectionId, "string");
  assert.ok(
    result.text.includes("* 1 EXISTS"),
    `the SELECT answer must reach the plugin: ${JSON.stringify(result.text)}`,
  );
  assert.ok(result.text.includes("A1 OK SELECT completed"), "the tagged answer must reach the plugin");

  // The credential on the wire is the one the settings IPC stored.
  const attempts = server.named("AUTHENTICATE");
  assert.equal(attempts.length, 1, `one AUTHENTICATE expected, saw ${JSON.stringify(server.lines)}`);
  assert.match(attempts[0].args, /^PLAIN /, "SASL-IR was offered, so the payload belongs on the same line");
  assert.equal(
    Buffer.from(attempts[0].args.slice("PLAIN ".length), "base64").toString("utf8"),
    `\u0000${USER}\u0000${PASSWORD}`,
  );
  assert.equal(server.named("LOGIN").length, 0, "PLAIN was available, so LOGIN must not be used");

  // The plugin's own command follows on the authenticated connection.
  const selects = server.named("SELECT");
  assert.equal(selects.length, 1, `one SELECT expected, saw ${JSON.stringify(server.lines)}`);
  assert.equal(selects[0].tag, "A1");
  assert.equal(selects[0].args, "INBOX");

  // Neither the greeting nor the auth reply is handed to the plugin.
  assert.ok(!result.text.includes("ready"), "the login greeting must be consumed by the host");
  assert.ok(!result.text.includes("authenticated"), "the auth reply must be consumed by the host");

  // The credential never crosses into the plugin process, in either direction.
  assertNoCredentialInFrames(frames, "the successful connect");

  // The runtime resolved the slot through the host RPC, not its own memory.
  assert.ok(
    host.calls.some((entry) => entry.method === "plugins.credentials.resolve"),
    "the connect must read the slot through the host",
  );

  // The audit names the slot and the scheme, never a field.
  const success = audits.find((entry) => entry.api === "net.tcp.connect" && entry.ok === true);
  assert.ok(success, "a successful connect must be audited");
  assert.equal(success.pluginId, pluginId);
  assert.equal(success.credential, "imap");
  assert.equal(success.scheme, "imaps");
  assert.equal(success.host, "localhost");
  assert.equal(success.port, server.port);
  assert.equal(success.connectionId, result.connectionId);
  assert.ok(!JSON.stringify(audits).includes(PASSWORD), "an audit record must not carry the value");

  assert.deepEqual(
    registry.list(pluginId).map((entry) => entry.state),
    ["open"],
    "the connection is open and owned by the plugin that asked for it",
  );

  // Clearing the slot in settings closes the loop: the next connect is refused.
  await settings.clear(pluginId, "imap");
  await refusal(call(pluginId, "connect", connectInput), "CREDENTIAL_NOT_CONFIGURED", /not configured/);
});

test("a plaintext or mismatched credential slot is refused before a byte is dialed", async (t) => {
  // Port 1 is never listening here: a case that reached a socket would answer
  // CONNECT_FAILED instead of the refusal asserted below.
  const deadPort = 1;
  const endpoint = (value) => [{ host: "localhost", port: deadPort, tls: value }];
  const { call, frames, audits, registry, settings } = await harness(t, [
    { id: "test.tls-off", endpoints: endpoint(false) },
    {
      id: "test.scope",
      endpoints: endpoint(true),
      slots: [imapSlot({ scope: { domains: ["mail.example.test"] } })],
    },
    { id: "test.basic", endpoints: endpoint(true), slots: [imapSlot({ kind: "basic" })] },
    { id: "test.undeclared", endpoints: endpoint(true) },
    { id: "test.unset", endpoints: endpoint(true) },
    { id: "test.noperm", endpoints: endpoint(true), granted: ["net.tcp"] },
  ]);
  const ask = (pluginId, credentialRef = "imap") =>
    call(pluginId, "connect", { endpoint: { host: "localhost", port: deadPort }, credentialRef });

  // Every slot above is filled in settings, so each refusal is about the
  // request, not about a missing value.
  for (const pluginId of ["test.tls-off", "test.scope", "test.basic", "test.undeclared", "test.unset", "test.noperm"]) {
    await settings.save(pluginId, "imap", { username: USER, password: PASSWORD });
  }

  // tls: false: an IMAP credential would travel in the clear.
  await refusal(ask("test.tls-off"), "PERMISSION_DENIED", /TLS/);
  // The slot's own scope does not admit this endpoint.
  await refusal(ask("test.scope"), "PERMISSION_DENIED", /does not admit this endpoint/);
  // A slot that cannot serve IMAP is not a login.
  await refusal(ask("test.basic"), "INVALID_ARGUMENT", /IMAP credential slot/);
  // A ref that names nothing the manifest declares.
  await refusal(ask("test.undeclared", "elsewhere"), "INVALID_ARGUMENT", /not declared/);
  // Without the grant, naming a slot is refused before it is even read.
  await refusal(ask("test.noperm"), "PERMISSION_DENIED", /credentials\.use/);

  assert.deepEqual(
    audits.filter((entry) => entry.api === "net.tcp.connect" && entry.ok === true),
    [],
    "no refused call may be audited as a connection",
  );
  for (const pluginId of ["test.tls-off", "test.scope", "test.basic", "test.undeclared", "test.unset", "test.noperm"]) {
    assert.deepEqual(registry.list(pluginId), [], `${pluginId} must own no connection`);
  }
  assertNoCredentialInFrames(frames, "the refused connects");
});

test("a slot the settings page never filled is refused with a canned message", async (t) => {
  const pluginId = "test.empty";
  const { call, frames } = await harness(t, [
    { id: pluginId, endpoints: [{ host: "localhost", port: 1, tls: true }] },
  ]);

  // The store's own failure text would name the slot; the runtime replaces it.
  await refusal(
    call(pluginId, "connect", { endpoint: { host: "localhost", port: 1 }, credentialRef: "imap" }),
    "CREDENTIAL_NOT_CONFIGURED",
    /^the credential slot is not configured$/,
  );
  assertNoCredentialInFrames(frames, "the unconfigured slot");
});

test("unloading while the credential is being resolved cannot create a late socket", async (t) => {
  const server = await imapServer(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const pluginId = "test.mailbox-race";
  const { runtime, registry, call } = await harness(t, [{
    id: pluginId, endpoints: [{ host: "localhost", port: server.port, tls: true }],
  }], async () => {
    entered.resolve();
    await release.promise;
    return { username: USER, password: PASSWORD };
  });
  const connecting = call(pluginId, "connect", { endpoint: { host: "localhost", port: server.port }, credentialRef: "imap" }).catch(() => undefined);
  await entered.promise;
  await runtime.unload(pluginId);
  release.resolve();
  await connecting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registry.list(pluginId), []);
  assert.equal(server.sockets.length, 0);
});