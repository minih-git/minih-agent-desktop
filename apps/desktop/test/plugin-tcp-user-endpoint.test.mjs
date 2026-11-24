/**
 * A mail server the user typed in, seen from a real plugin sidecar.
 *
 * The suite runs the path a mailbox plugin with `userEndpoint` actually takes:
 *
 *   settings → IPC `plugin/credentials/set` (real handler)
 *            → host RPC `plugins.credentials.set` (stub store)
 *   plugin   → `pi.net.tcp.connect({ credentialRef })` — no endpoint (real sidecar)
 *            → runtime → `resolveTcpCredential` → host RPC
 *              `plugins.credentials.resolve` (same store, same resolver Main wires)
 *            → registry dials the stored server and performs the login itself.
 *
 * What is proved here is not "a login works" but the boundary around it:
 *
 * - the password only ever travels after TLS is up, in either protocol and with
 *   either transport;
 * - a server that does not offer STARTTLS fails instead of falling back;
 * - a byte pushed after the upgrade agreement aborts the connection;
 * - a plugin that names a different endpoint than the one stored is refused,
 *   and a connection without a credential cannot reach a user-typed server;
 * - a slot whose instance stores no server keeps the released preset path.
 *
 * Isolation: `MINIH_AGENT_DATA_DIR` points at a scratch directory, and the only
 * trust anchor injected is the test CA this file generates locally.
 */
import assert from "node:assert/strict";
import net from "node:net";
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
const dataDir = mkdtempSync(join(scratch, "tcp-user-endpoint-"));
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
const PASSWORD = "s3cret-mail-password";
const PLAIN = Buffer.from(`\u0000${USER}\u0000${PASSWORD}`, "utf8").toString("base64");

// Test-only PKI: one CA and a `localhost` leaf, identical to the registry and
// IMAP login tests, so a machine clock anywhere in 2020–2049 verifies.
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
    if (action === 'command') {
      const result = await pi.net.tcp.connect(input);
      await pi.net.tcp.send({ connectionId: result.connectionId, data: input.command });
      return Object.assign({}, result, { text: await textUntil(input.expect) });
    }
    if (action === 'text') return text();
    if (action === 'close') return pi.net.tcp.close(input);
    throw new Error('unknown action: ' + action);
  },
}
`;

// --- helpers ---------------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * One mail server that speaks IMAP or POP3, optionally upgrading with STARTTLS
 * when the client asks for it.
 */
async function mailServer(t, options) {
  const { greeting, mode = "starttls", respond } = options;
  const state = { lines: [], chunks: [], plain: [], sockets: [], upgraded: 0 };
  const secureContext = tls.createSecureContext({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY });

  const attach = (socket, overTls) => {
    let pending = "";
    socket.on("data", (chunk) => {
      state.chunks.push(chunk);
      if (!overTls) state.plain.push(chunk);
      pending += chunk.toString("utf8");
      let index = pending.indexOf("\r\n");
      while (index !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        state.lines.push(line);
        const reply = (value) => socket.write(`${value}\r\n`);
        respond?.({ line, reply, socket, overTls, upgrade: () => upgrade(socket) });
        index = pending.indexOf("\r\n");
      }
    });
    socket.on("error", () => {});
  };

  const upgrade = (socket) => {
    socket.removeAllListeners("data");
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
    state.upgraded += 1;
    state.sockets.push(secure);
    attach(secure, true);
    return secure;
  };

  const server =
    mode === "tls"
      ? tls.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (socket) => {
          state.sockets.push(socket);
          socket.on("error", () => {});
          if (greeting) socket.write(`${greeting}\r\n`);
          attach(socket, true);
        })
      : net.createServer((socket) => {
          state.sockets.push(socket);
          socket.on("error", () => {});
          if (greeting) socket.write(`${greeting}\r\n`);
          attach(socket, false);
        });

  const port = await listen(server);
  t.after(() => {
    for (const socket of state.sockets) socket.destroy();
    server.close();
  });
  return {
    port,
    lines: state.lines,
    plain: state.plain,
    upgraded: () => state.upgraded,
    /** A credential that reached the server before TLS started, or undefined. */
    plainCredential: () => {
      const text = Buffer.concat(state.plain).toString("utf8");
      return text.includes(PASSWORD) || text.includes(PLAIN) ? text : undefined;
    },
    sawCredential: () => {
      const text = Buffer.concat(state.chunks).toString("utf8");
      return text.includes(PASSWORD) || text.includes(PLAIN);
    },
    named: (name) =>
      state.lines.filter((line) => new RegExp(`^\\S* ?${name}( |$)`, "i").test(line)),
  };
}

/** A real IMAP server: greeting, capabilities, STARTTLS, then authentication. */
function imapResponder({ offerStarttls = true } = {}) {
  return ({ line, reply, upgrade }) => {
    const tagged = /^(\S+) (CAPABILITY|STARTTLS|AUTHENTICATE|LOGIN|SELECT)(?: (.*))?$/i.exec(line);
    const bare = /^(CAPABILITY|STARTTLS|AUTHENTICATE)(?: (.*))?$/i.exec(line);
    const command = tagged ?? bare;
    if (!command) return;
    const tag = tagged ? tagged[1] : null;
    const name = (tagged ? tagged[2] : bare[1]).toUpperCase();
    if (name === "CAPABILITY") {
      if (tag) {
        reply(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR${offerStarttls ? " STARTTLS" : ""}`);
        reply(`${tag} OK CAPABILITY completed`);
      } else {
        reply(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR${offerStarttls ? " STARTTLS" : ""}`);
      }
      return;
    }
    if (name === "STARTTLS") {
      if (!offerStarttls) {
        reply(`${tag} NO STARTTLS is not available`);
        return;
      }
      reply(`${tag} OK beginning TLS`);
      upgrade();
      return;
    }
    if (name === "AUTHENTICATE") {
      reply(`${tag} OK authenticated`);
      return;
    }
    if (name === "SELECT") {
      reply("* 1 EXISTS");
      reply(`${tag} OK SELECT completed`);
      return;
    }
    if (name === "LOGIN") {
      reply(`${tag} BAD unexpected LOGIN`);
    }
  };
}

/** A declared IMAP slot that lets the user name their own server. */
function customSlot() {
  return {
    id: "mailbox",
    title: "Mailbox",
    kind: "imap",
    fields: [
      { key: "username", label: "User" },
      { key: "password", label: "Password", secret: true },
    ],
    multiple: { max: 5 },
    labelField: "username",
    userEndpoint: { protocols: ["imap", "pop3"] },
  };
}

/**
 * The host side of `plugins.credentials.*`: the same four calls Main makes,
 * answered from memory. This stands in for host-core's encrypted store; every
 * value here is written through the settings IPC, never by the test body.
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
        case "plugins.credentials.set": {
          // Mirrors host-core: a multi-instance slot answers the id it created.
          const id = `acc_${String(stored.size + 1).padStart(8, "0")}`;
          stored.set(key(params.pluginId, `${params.slotId}#${id}`), { ...params.fields });
          return { instanceId: id };
        }
        case "plugins.credentials.resolve": {
          const fields = stored.get(key(params.pluginId, params.slotId));
          if (!fields) {
            throw Object.assign(new Error("credential slot is not configured"), {
              errorCode: "CREDENTIAL_NOT_CONFIGURED",
            });
          }
          return { fields };
        }
        case "plugins.credentials.status": {
          const prefix = `${params.pluginId}\u0000`;
          return {
            slots: (declared.get(params.pluginId) ?? []).map((slot) => {
              const instances = [...stored.entries()]
                .filter(([entryKey]) => entryKey.startsWith(`${prefix}${slot.id}#`))
                .map(([entryKey, fields]) => ({
                  instanceId: entryKey.slice(entryKey.indexOf("#") + 1),
                  label: fields.username ?? "",
                  publicFields: {
                    username: fields.username ?? "",
                    ...(fields.server ? { server: fields.server } : {}),
                  },
                  configured: true,
                }));
              return { ...slot, configured: instances.length > 0, lastUsedAt: null, instances };
            }),
          };
        }
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
  return {
    save: (pluginId, slotId, fields) => {
      const handler = handlers.get(IPC.invoke.pluginCredentialsSet);
      if (!handler) throw new Error("no handler for pluginCredentialsSet");
      return handler({ main: true }, { pluginId, slotId, fields });
    },
  };
}

function writePlugin(root, spec, host) {
  const dir = join(root, spec.id);
  mkdirSync(dir, { recursive: true });
  const slots = spec.slots ?? [customSlot()];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: spec.id,
      name: spec.id,
      version: "1.0.0",
      main: "main.js",
      permissions: ["net.tcp", "credentials.use"],
      net: { tcp: spec.endpoints ?? [] },
      contributes: { credentials: slots },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_MAIN, "utf8");
  host.declare(spec.id, slots);
  return dir;
}

/** Broker + registry + real sidecars, wired the way `plugin-services.ts` does. */
async function harness(t, specs) {
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
    resolvePluginCredential: (pluginId, slotId) =>
      resolveStoredCredential(host.call, pluginId, slotId),
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

/** A credential as the settings page saves it for a user-typed server. */
function saved(server, port, protocol, security) {
  return { username: USER, password: PASSWORD, server, port, protocol, security };
}

function refusal(promise, code, pattern) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

/** Nothing a plugin can read may carry the credential. */
function assertNoCredentialInFrames(frames, label) {
  const wire = JSON.stringify(frames);
  assert.ok(!wire.includes(PASSWORD), `${label}: the password reached a sidecar message`);
  assert.ok(!wire.includes(PLAIN), `${label}: the SASL payload reached a sidecar message`);
}

// --- IMAP over STARTTLS ----------------------------------------------------

test("IMAP over STARTTLS logs in only after the upgrade, and the plugin never sees the login", async (t) => {
  const server = await mailServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 STARTTLS] ready",
    respond: imapResponder(),
  });
  const pluginId = "test.custom-imap";
  const { call, settings, frames, audits, host } = await harness(t, [{ id: pluginId }]);

  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "imap", "starttls"));
  const instance = host.calls.at(-1)?.params;
  assert.equal(instance?.slotId, "mailbox");

  const result = await call(pluginId, "command", {
    credentialRef: `mailbox#${await lastInstance(host, pluginId)}`,
    command: "A1 SELECT INBOX\r\n",
    expect: "A1 OK",
  });

  assert.equal(result.authenticated, true);
  assert.equal(result.protocol, "imap");
  assert.ok(result.text.includes("* 1 EXISTS"), result.text);
  assert.equal(server.upgraded(), 1, "the connection was upgraded exactly once");
  assert.equal(server.plainCredential(), undefined, "no credential byte before TLS");
  assert.ok(server.named("STARTTLS").length === 1, JSON.stringify(server.lines));
  // The pre-TLS capabilities were discarded: the CAPABILITY that decides the
  // login is asked again over TLS, after the upgrade.
  const capabilityAt = server.lines.findIndex((line) => /CAPABILITY/.test(line));
  const starttlsAt = server.lines.findIndex((line) => /STARTTLS/.test(line));
  assert.equal(capabilityAt, starttlsAt + 1, JSON.stringify(server.lines));
  const authenticate = server.lines.find((line) => /AUTHENTICATE PLAIN/.test(line));
  assert.ok(authenticate, JSON.stringify(server.lines));
  assert.equal(
    Buffer.from(authenticate.split("PLAIN ")[1], "base64").toString("utf8"),
    `\u0000${USER}\u0000${PASSWORD}`,
  );
  assertNoCredentialInFrames(frames, "the STARTTLS connect");
  const success = audits.find((entry) => entry.api === "net.tcp.connect" && entry.ok === true);
  assert.equal(success?.scheme, "imap+starttls");
});

/** The id the settings save just produced. */
async function lastInstance(host, pluginId) {
  const answer = await host.call("plugins.credentials.status", { pluginId });
  return answer.slots[0].instances.at(-1).instanceId;
}

test("a server without STARTTLS fails instead of falling back to plaintext", async (t) => {
  const server = await mailServer(t, {
    greeting: "* OK ready",
    respond: imapResponder({ offerStarttls: false }),
  });
  const pluginId = "test.no-starttls";
  const { call, settings, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "imap", "starttls"));

  await refusal(
    call(pluginId, "connect", { credentialRef: `mailbox#${await lastInstance(host, pluginId)}` }),
    "STARTTLS_UNAVAILABLE",
    /STARTTLS/,
  );
  assert.equal(server.upgraded(), 0, "nothing was upgraded");
  assert.equal(server.plainCredential(), undefined, "the password never left in the clear");
  assert.ok(!server.sawCredential(), "no credential byte reached the server at all");
});

test("a server that advertises STARTTLS and then refuses it is still unavailable", async (t) => {
  // The command refused after the capability promised it is a protocol lie, and
  // it has to land on the same code as "never advertised": either way the user
  // needs a different port or server, not another handshake attempt.
  const server = await mailServer(t, {
    greeting: "* OK ready",
    respond: ({ line, reply }) => {
      const tagged = /^(\S+) (CAPABILITY|STARTTLS)(?:\s|$)/i.exec(line);
      if (!tagged) return;
      if (/CAPABILITY/i.test(tagged[2])) {
        reply("* CAPABILITY IMAP4rev1 STARTTLS");
        reply(`${tagged[1]} OK CAPABILITY completed`);
        return;
      }
      reply(`${tagged[1]} NO STARTTLS is disabled`);
    },
  });
  const pluginId = "test.starttls-refused";
  const { call, settings, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "imap", "starttls"));

  await refusal(
    call(pluginId, "connect", { credentialRef: `mailbox#${await lastInstance(host, pluginId)}` }),
    "STARTTLS_UNAVAILABLE",
    /STARTTLS/,
  );
  assert.equal(server.upgraded(), 0, "nothing was upgraded");
  assert.ok(!server.sawCredential(), "no credential byte reached the server at all");
});

test("a byte pushed right after the upgrade agreement aborts the connection", async (t) => {
  const server = await mailServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 STARTTLS] ready",
    respond: ({ line, reply, socket, upgrade }) => {
      if (/STARTTLS/i.test(line)) {
        // The classic STARTTLS injection: the injected plaintext arrives in the
        // same read as the agreement, so it must be refused rather than parsed.
        socket.write("MHA0 OK begin TLS\r\n* OK injected\r\n");
        return;
      }
      imapResponder()({ line, reply, upgrade });
    },
  });
  const pluginId = "test.injection";
  const { call, settings, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "imap", "starttls"));

  await refusal(
    call(pluginId, "connect", { credentialRef: `mailbox#${await lastInstance(host, pluginId)}` }),
    "TLS_FAILED",
    /before the TLS handshake/,
  );
  assert.equal(server.plainCredential(), undefined, "the password never left in the clear");
  assert.ok(!server.sawCredential(), "no credential byte reached the server");
});

// --- POP3 ------------------------------------------------------------------

test("POP3 over implicit TLS authenticates with SASL PLAIN when the server offers it", async (t) => {
  const server = await mailServer(t, {
    mode: "tls",
    greeting: "+OK ready",
    respond: pop3Responder({ saslPlain: true }),
  });
  const pluginId = "test.pop3-tls";
  const { call, settings, frames, audits, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "pop3", "tls"));

  const result = await call(pluginId, "command", {
    credentialRef: `mailbox#${await lastInstance(host, pluginId)}`,
    command: "STAT\r\n",
    expect: "+OK",
  });
  assert.equal(result.authenticated, true);
  assert.equal(result.protocol, "pop3");
  assert.ok(server.named("AUTH").length === 1, JSON.stringify(server.lines));
  assert.equal(server.named("USER").length, 0, "SASL PLAIN was offered, so USER must not be used");
  assertNoCredentialInFrames(frames, "the POP3 connect");
  assert.equal(
    audits.find((entry) => entry.api === "net.tcp.connect" && entry.ok === true)?.scheme,
    "pop3s",
  );
});

test("POP3 over STARTTLS re-reads the capabilities after the upgrade and then logs in", async (t) => {
  const server = await mailServer(t, {
    greeting: "+OK ready",
    respond: pop3Responder({ saslPlain: false, stls: true }),
  });
  const pluginId = "test.pop3-starttls";
  const { call, settings, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(
    pluginId,
    "mailbox",
    saved("localhost", String(server.port), "pop3", "starttls"),
  );

  const result = await call(pluginId, "connect", {
    credentialRef: `mailbox#${await lastInstance(host, pluginId)}`,
  });
  assert.equal(result.authenticated, true);
  assert.equal(result.protocol, "pop3");
  assert.equal(server.upgraded(), 1);
  assert.equal(server.plainCredential(), undefined, "no credential byte before TLS");
  assert.ok(server.named("STLS").length === 1, JSON.stringify(server.lines));
  // Once before the upgrade to find STLS, once after it to decide the login.
  assert.equal(server.named("CAPA").length, 2, JSON.stringify(server.lines));
  assert.equal(server.named("USER").length, 1, JSON.stringify(server.lines));
});

test("a refused POP3 password is reported as a rejected credential", async (t) => {
  const server = await mailServer(t, {
    mode: "tls",
    greeting: "+OK ready",
    respond: pop3Responder({ saslPlain: false, rejectPass: true }),
  });
  const pluginId = "test.pop3-rejected";
  const { call, settings, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "pop3", "tls"));

  await refusal(
    call(pluginId, "connect", { credentialRef: `mailbox#${await lastInstance(host, pluginId)}` }),
    "CREDENTIAL_REJECTED",
    /authentication failed/,
  );
});

/** A POP3 server that records what it was told and answers the login. */
function pop3Responder({ saslPlain = false, stls = false, rejectPass = false } = {}) {
  return ({ line, reply, upgrade }) => {
    const command = line.trim().toUpperCase();
    if (command.startsWith("CAPA")) {
      reply("+OK capability list follows");
      if (stls) reply("STLS");
      if (saslPlain) reply("SASL PLAIN");
      reply(".");
      return;
    }
    if (command.startsWith("STLS")) {
      reply("+OK begin TLS");
      upgrade();
      return;
    }
    if (command.startsWith("AUTH PLAIN")) {
      reply("+OK authenticated");
      return;
    }
    if (command.startsWith("USER")) {
      reply("+OK send PASS");
      return;
    }
    if (command.startsWith("PASS")) {
      reply(rejectPass ? "-ERR invalid credentials" : "+OK mailbox ready");
      return;
    }
    if (command.startsWith("STAT")) {
      reply("+OK 3 320");
      return;
    }
  };
}

// --- the boundary around a user-typed server -------------------------------

test("a plugin cannot redirect a stored password to another server", async (t) => {
  const server = await mailServer(t, {
    mode: "tls",
    greeting: "+OK ready",
    respond: pop3Responder({ saslPlain: true }),
  });
  const pluginId = "test.redirect";
  const { call, settings, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "pop3", "tls"));
  const instance = await lastInstance(host, pluginId);

  await refusal(
    call(pluginId, "connect", {
      credentialRef: `mailbox#${instance}`,
      endpoint: { host: "evil.example.test", port: server.port },
    }),
    "PERMISSION_DENIED",
    /not the one stored/,
  );
  await refusal(
    call(pluginId, "connect", {
      credentialRef: `mailbox#${instance}`,
      endpoint: { host: "localhost", port: 1 },
    }),
    "PERMISSION_DENIED",
    /not the one stored/,
  );
  assert.equal(server.sawCredential(), false, "no credential was sent anywhere");
});

test("a connection without a credential cannot reach a user-typed server", async (t) => {
  const server = await mailServer(t, {
    mode: "tls",
    greeting: "+OK ready",
    respond: pop3Responder({ saslPlain: true }),
  });
  const pluginId = "test.no-credential";
  const { call, settings, host } = await harness(t, [{ id: pluginId }]);
  await settings.save(pluginId, "mailbox", saved("localhost", String(server.port), "pop3", "tls"));

  // No `credentialRef`: the endpoint has to be declared in the manifest, and it
  // is not, so the user's server stays unreachable on this path.
  await refusal(
    call(pluginId, "connect", { endpoint: { host: "localhost", port: server.port } }),
    "PERMISSION_DENIED",
    /manifest\.net\.tcp/,
  );
  assert.equal(server.sawCredential(), false);
});

test("an instance that names no server keeps the released preset path", async (t) => {
  const server = await mailServer(t, {
    mode: "tls",
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
    respond: imapResponder(),
  });
  const pluginId = "test.preset";
  const { call, settings, frames, audits, host } = await harness(t, [
    { id: pluginId, endpoints: [{ host: "localhost", port: server.port, tls: true }], slots: [{ ...customSlot(), scope: { domains: ["localhost"] } }] },
  ]);
  // The form may prefill the other keys; a blank server means "no custom one".
  await settings.save(pluginId, "mailbox", {
    ...saved("", "993", "imap", "tls"),
  });

  const result = await call(pluginId, "connect", {
    credentialRef: `mailbox#${await lastInstance(host, pluginId)}`,
    endpoint: { host: "localhost", port: server.port },
  });
  assert.equal(result.authenticated, true);
  assert.equal(result.protocol, undefined, "the released path answers as before");
  assert.equal(server.upgraded(), 0);
  assert.equal(server.named("STARTTLS").length, 0);
  assertNoCredentialInFrames(frames, "the preset connect");
  assert.equal(
    audits.find((entry) => entry.api === "net.tcp.connect" && entry.ok === true)?.scheme,
    "imaps",
  );
});