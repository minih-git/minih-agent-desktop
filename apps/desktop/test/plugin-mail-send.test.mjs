/**
 * `mail.send`, from both ends.
 *
 * The first half drives the module with fake ports: every refusal that has to
 * happen before anything is dialed — the endpoint allowlist, the account's own
 * server, the sender's identity, the envelope and message bounds, the hourly
 * count — and the audit row, which must carry counts and never an address.
 *
 * The second half runs the real thing: a real registry, a real sidecar plugin, a
 * real SMTP server, and an HTTP CONNECT proxy in front of one of them. What it
 * proves is that the plugin gets an outcome and nothing else — the password, the
 * server's text and the socket stay in the host — and that a plugin which goes
 * away mid-session takes the session with it.
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

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();
const dataDir = mkdtempSync(join(scratch, "mail-send-"));
process.env.MINIH_AGENT_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { sendPluginMail, MailSendLimiter } = await import("../electron/main/plugin-mail-send.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { PluginTcpRegistry } = await import("../electron/main/plugin-tcp.ts");

const ENTRY = join(here, "../electron/main/plugin-host-process.mjs");
const USER = "alice@example.test";
const PASSWORD = "s3cret-smtp-password";
const PLAIN = Buffer.from(`\u0000${USER}\u0000${PASSWORD}`, "utf8").toString("base64");

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

const MESSAGE = Buffer.from(
  "From: Alice <alice@example.test>\r\n" +
    "To: bob@example.test\r\n" +
    "Subject: hello\r\n" +
    "\r\n" +
    "body\r\n",
  "latin1",
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** A declared imap slot, with or without an own outgoing server. */
function mailSlot(overrides = {}) {
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
    scope: { domains: ["localhost"] },
    ...overrides,
  };
}

// --- the module, with fake ports -------------------------------------------

/** Ports that record what the module asked for and never open a socket. */
function fakePorts({ fields, audit = [], acquire } = {}) {
  const calls = [];
  return {
    calls,
    ports: {
      resolve: async () => {
        calls.push("resolve");
        if (!fields) throw Object.assign(new Error("not configured"), { errorCode: "CREDENTIAL_NOT_CONFIGURED" });
        return fields;
      },
      acquire: async (request) => {
        calls.push({ acquire: request });
        if (acquire) return acquire(request);
        throw new Error("no connection may be opened for this refusal");
      },
      audit: (entry) => audit.push(entry),
    },
  };
}

function send(ports, overrides = {}) {
  return sendPluginMail(ports, {
    pluginId: "test.mail",
    slots: [mailSlot()],
    manifestTcp: [{ host: "localhost", port: 587, tls: false }],
    input: {
      credential: { slot: "mailbox", instanceId: "acc_1" },
      envelope: { from: USER, to: ["bob@example.test"] },
      mime: MESSAGE,
      ...overrides,
    },
    limiter: new MailSendLimiter(30, () => 1_000),
  });
}

function refusal(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    return true;
  });
}

test("an account the user has not filled in cannot send", async () => {
  const { ports } = fakePorts({});
  await refusal(
    send(ports, { endpoint: { host: "localhost", port: 587 } }),
    "CREDENTIAL_NOT_CONFIGURED",
  );
});

test("an endpoint outside the manifest declaration is refused", async () => {
  const { ports, calls } = fakePorts({ fields: { username: USER, password: PASSWORD } });
  await refusal(
    send(ports, { endpoint: { host: "smtp.elsewhere.test", port: 587 } }),
    "PERMISSION_DENIED",
  );
  assert.ok(!calls.includes("acquire"), "nothing was dialed");
});

test("an endpoint outside the slot scope is refused", async () => {
  const { ports } = fakePorts({ fields: { username: USER, password: PASSWORD } });
  const scoped = [mailSlot({ scope: { domains: ["other.test"] } })];
  await refusal(
    sendPluginMail(ports, {
      pluginId: "test.mail",
      slots: scoped,
      manifestTcp: [{ host: "localhost", port: 587, tls: false }],
      input: {
        credential: { slot: "mailbox", instanceId: "acc_1" },
        endpoint: { host: "localhost", port: 587 },
        envelope: { from: USER, to: ["bob@example.test"] },
        mime: MESSAGE,
      },
    }),
    "PERMISSION_DENIED",
  );
});

test("an account with neither a stored nor a declared server cannot send", async () => {
  const { ports } = fakePorts({ fields: { username: USER, password: PASSWORD } });
  await refusal(send(ports), "MAIL_SEND_NOT_CONFIGURED");
});

test("an account with its own outgoing server refuses a plugin-named endpoint", async () => {
  const slots = [mailSlot({ userSend: { security: ["tls", "starttls"] } })];
  const fields = {
    username: USER,
    password: PASSWORD,
    sendServer: "smtp.example.test",
    sendPort: "465",
    sendSecurity: "tls",
  };
  const { ports, calls } = fakePorts({ fields });
  await refusal(
    sendPluginMail(ports, {
      pluginId: "test.mail",
      slots,
      manifestTcp: [],
      input: {
        credential: { slot: "mailbox", instanceId: "acc_1" },
        endpoint: { host: "smtp.example.test", port: 465 },
        envelope: { from: USER, to: ["bob@example.test"] },
        mime: MESSAGE,
      },
    }),
    "INVALID_ARGUMENT",
  );
  assert.ok(!calls.includes("acquire"), "nothing was dialed");
});

test("a message from another address is refused before the dial", async () => {
  const { ports, calls } = fakePorts({ fields: { username: USER, password: PASSWORD } });
  await refusal(
    send(ports, {
      endpoint: { host: "localhost", port: 587 },
      envelope: { from: "someone-else@example.test", to: ["bob@example.test"] },
    }),
    "MAIL_FROM_MISMATCH",
  );
  assert.ok(!calls.includes("acquire"), "nothing was dialed");
});

test("a message whose From or Sender header is another address is refused", async () => {
  const { ports } = fakePorts({ fields: { username: USER, password: PASSWORD } });
  const forged = Buffer.from(
    "From: Mallory <mallory@example.test>\r\n\r\nbody\r\n",
    "latin1",
  );
  await refusal(
    send(ports, { endpoint: { host: "localhost", port: 587 }, mime: forged }),
    "MAIL_FROM_MISMATCH",
  );
  const senderHeader = Buffer.from(
    "From: alice@example.test\r\nSender: mallory@example.test\r\n\r\nbody\r\n",
    "latin1",
  );
  await refusal(
    send(ports, { endpoint: { host: "localhost", port: 587 }, mime: senderHeader }),
    "MAIL_FROM_MISMATCH",
  );
});

test("a Bcc header is refused; blind recipients belong in the envelope", async () => {
  const { ports } = fakePorts({ fields: { username: USER, password: PASSWORD } });
  const withBcc = Buffer.from(
    "From: alice@example.test\r\nBcc: carol@example.test\r\n\r\nbody\r\n",
    "latin1",
  );
  await refusal(
    send(ports, { endpoint: { host: "localhost", port: 587 }, mime: withBcc }),
    "MAIL_BCC_HEADER",
  );
});

test("the envelope and the message are bounded", async () => {
  const { ports } = fakePorts({ fields: { username: USER, password: PASSWORD } });
  const many = Array.from({ length: 51 }, (_, index) => `peer${index}@example.test`);
  await refusal(
    send(ports, {
      endpoint: { host: "localhost", port: 587 },
      envelope: { from: USER, to: many },
    }),
    "LIMIT_EXCEEDED",
  );
  // Two spellings of one mailbox are one delivery: 30 duplicates are one
  // recipient, so the envelope passes the cap and fails later, at the dial.
  const duplicated = Array.from({ length: 30 }, () => "Bob@Example.test");
  await assert.rejects(
    send(ports, {
      endpoint: { host: "localhost", port: 587 },
      envelope: { from: USER, to: duplicated },
    }),
    (error) => {
      assert.notEqual(error.code, "LIMIT_EXCEEDED", "duplicates were counted as recipients");
      return true;
    },
  );
  await refusal(
    send(ports, {
      endpoint: { host: "localhost", port: 587 },
      mime: Buffer.alloc(25 * 1024 * 1024 + 1, 0x41),
    }),
    "MAIL_TOO_LARGE",
  );
  await refusal(
    send(ports, {
      endpoint: { host: "localhost", port: 587 },
      envelope: { from: USER, to: ["not-an-address"] },
    }),
    "INVALID_ARGUMENT",
  );
});

test("the hourly count stops a runaway plugin", async () => {
  const { ports } = fakePorts({
    fields: { username: USER, password: PASSWORD },
    acquire: () => {
      throw Object.assign(new Error("stop here"), { code: "CONNECT_FAILED" });
    },
  });
  const limiter = new MailSendLimiter(2, () => 1_000);
  const call = () =>
    sendPluginMail(ports, {
      pluginId: "test.mail",
      slots: [mailSlot()],
      manifestTcp: [{ host: "localhost", port: 587, tls: false }],
      input: {
        credential: { slot: "mailbox", instanceId: "acc_1" },
        endpoint: { host: "localhost", port: 587 },
        envelope: { from: USER, to: ["bob@example.test"] },
        mime: MESSAGE,
      },
      limiter,
    });
  await refusal(call(), "CONNECT_FAILED");
  await refusal(call(), "CONNECT_FAILED");
  await refusal(call(), "MAIL_RATE_LIMITED");
});

test("the audit row carries counts and a code, never an address", async () => {
  const audit = [];
  const { ports } = fakePorts({ fields: { username: USER, password: PASSWORD }, audit });
  await refusal(
    send(ports, {
      endpoint: { host: "localhost", port: 587 },
      envelope: { from: USER, to: ["bob@example.test"] },
      mime: Buffer.from("From: mallory@example.test\r\n\r\nbody\r\n", "latin1"),
    }),
    "MAIL_FROM_MISMATCH",
  );
  const row = audit.at(-1);
  assert.equal(row.api, "mail.send");
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, "MAIL_FROM_MISMATCH");
  assert.equal(row.pluginId, "test.mail");
  assert.equal(row.credential, "mailbox");
  assert.equal(row.credentialInstance, "acc_1");
  assert.equal(row.recipients, 1);
  const wire = JSON.stringify(audit);
  assert.ok(!wire.includes("bob@example.test"), "a recipient address reached the audit trail");
  assert.ok(!wire.includes("mallory"), "a header address reached the audit trail");
  assert.ok(!wire.includes(PASSWORD), "the password reached the audit trail");
});

// --- the real path: runtime, sidecar, socket ---------------------------------

/**
 * One SMTP server: implicit TLS or STARTTLS, with the knobs the cases need.
 * `stall` names a command the server never answers, which is how a session is
 * held open while something else (an unload, a quota) is exercised.
 */
async function smtpServer(t, options = {}) {
  const {
    mode = "tls",
    offerStarttls = true,
    advertise = ["8BITMIME", "AUTH PLAIN LOGIN"],
    stall = [],
  } = options;
  const state = { lines: [], chunks: [], sockets: [], delivered: undefined };
  const secureContext = tls.createSecureContext({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY });

  const attach = (socket, overTls) => {
    let pending = "";
    let dataMode = false;
    const reply = (value) => socket.write(`${value}\r\n`);
    const dispatch = (line) => {
      const command = /^([A-Za-z]+)(?: (.*))?$/.exec(line);
      if (!command) return;
      const name = command[1].toUpperCase();
      const rest = command[2] ?? "";
      if (stall.includes(name)) return;
      switch (name) {
        case "EHLO": {
          const capabilities = [...advertise];
          if (!overTls && offerStarttls) capabilities.push("STARTTLS");
          const lines = ["localhost greets you", ...capabilities];
          lines.forEach((entry, index) => reply(`250${index === lines.length - 1 ? " " : "-"}${entry}`));
          return;
        }
        case "STARTTLS":
          if (!offerStarttls) {
            reply("454 TLS is not available");
            return;
          }
          reply("220 Ready to start TLS");
          upgrade(socket);
          return;
        case "AUTH": {
          if (/^PLAIN\s/i.test(rest)) {
            reply("235 2.7.0 authentication successful");
            return;
          }
          if (/^LOGIN\s*$/i.test(rest)) {
            reply("334 VXNlcm5hbWU6");
            return;
          }
          reply("504 5.5.4 unrecognised mechanism");
          return;
        }
        case "MAIL":
          reply("250 2.1.0 sender ok");
          return;
        case "RCPT": {
          const address = /<([^>]*)>/.exec(rest)?.[1] ?? "";
          reply(address === "bob@example.test" ? "250 2.1.5 ok" : "550 5.1.1 no such user");
          return;
        }
        case "DATA":
          reply("354 end with <CRLF>.<CRLF>");
          dataMode = true;
          return;
        case "QUIT":
          reply("221 2.0.0 bye");
          return;
        default:
          reply("500 5.5.2 unrecognised");
      }
    };
    const pump = () => {
      for (;;) {
        if (dataMode) {
          const end = pending.indexOf("\r\n.\r\n");
          if (end < 0) return;
          state.delivered = pending.slice(0, end + 2);
          dataMode = false;
          pending = pending.slice(end + 5);
          reply("250 2.0.0 Ok: queued as Q7");
          continue;
        }
        const index = pending.indexOf("\r\n");
        if (index < 0) return;
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        state.lines.push(line);
        dispatch(line);
      }
    };
    socket.on("data", (chunk) => {
      state.chunks.push(chunk);
      pending += chunk.toString("latin1");
      pump();
    });
    socket.on("error", () => {});
    return { reply };
  };

  const upgrade = (socket) => {
    socket.removeAllListeners("data");
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
    state.sockets.push(secure);
    attach(secure, true);
  };

  const server =
    mode === "tls"
      ? tls.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (socket) => {
          state.sockets.push(socket);
          socket.on("error", () => {});
          attach(socket, true).reply("220 localhost ESMTP");
        })
      : net.createServer((socket) => {
          state.sockets.push(socket);
          socket.on("error", () => {});
          attach(socket, false).reply("220 localhost ESMTP");
        });
  const port = await listen(server);
  t.after(() => {
    for (const socket of state.sockets) socket.destroy();
    server.close();
  });
  return {
    port,
    lines: state.lines,
    delivered: () => state.delivered,
    sawPassword: () => {
      const wire = Buffer.concat(state.chunks).toString("latin1");
      return wire.includes(PLAIN) || wire.includes(PASSWORD);
    },
  };
}

/** An HTTP `CONNECT` proxy in front of one upstream port. */
async function httpProxy(t, upstreamPort) {
  const authorities = [];
  const server = net.createServer((client) => {
    client.on("error", () => {});
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      client.removeListener("data", onData);
      const request = head.slice(0, head.indexOf("\r\n\r\n")).split("\r\n");
      const [, authority] = /^CONNECT (\S+) HTTP\/1\.[01]$/i.exec(request[0]) ?? [];
      authorities.push(authority ?? request[0]);
      const upstream = net.connect({ host: "127.0.0.1", port: upstreamPort });
      upstream.on("error", () => client.destroy());
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    };
    client.on("data", onData);
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { port, authorities };
}

/** The sidecar: it names an account and a message, and learns the outcome. */
const PLUGIN_MAIN = `
module.exports = {
  async onPanelInvoke(action, input) {
    if (action === 'send') return pi.mail.send(input);
    if (action === 'connect') return pi.net.tcp.connect(input);
    throw new Error('unknown action: ' + action);
  },
}
`;

/** The host side of `plugins.credentials.*`, answered from memory. */
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
                  publicFields: { username: fields.username ?? "" },
                  configured: true,
                }));
              return { ...slot, configured: instances.length > 0, instances };
            }),
          };
        }
        default:
          throw new Error(`unexpected host call: ${method}`);
      }
    },
  };
}

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
  const slots = spec.slots ?? [mailSlot()];
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: spec.id,
      name: spec.id,
      version: "1.0.0",
      main: "main.js",
      permissions: spec.permissions ?? ["mail.send", "credentials.use", "net.tcp"],
      net: { tcp: spec.endpoints ?? [] },
      contributes: { credentials: slots },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_MAIN, "utf8");
  host.declare(spec.id, slots);
  return dir;
}

async function harness(t, specs, options = {}) {
  const root = mkdtempSync(join(dataDir, "plugins-"));
  const frames = [];
  const audits = [];
  const host = credentialHost();
  const settings = credentialSettings(host);
  let runtime;
  const registry = new PluginTcpRegistry({
    tlsCa: TEST_CA,
    connectTimeoutMs: 30_000,
    onEvent: (pluginId, event) => runtime.deliverTcpEvent(pluginId, event),
    ...(options.registry ?? {}),
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

const { IPC } = await import("@minih-agent/shared");
const { registerPluginCredentialIpc } = await import("../electron/main/ipc/plugin-credentials-ipc.ts");
const { resolvePluginCredential: resolveStoredCredential } = await import(
  "../electron/main/plugin-credential-slots.ts"
);

/** The id the settings save just produced. */
async function lastInstance(host, pluginId, slotId = "mailbox") {
  const answer = await host.call("plugins.credentials.status", { pluginId });
  return answer.slots.find((slot) => slot.id === slotId).instances.at(-1).instanceId;
}

test("a plugin without mail.send is refused", async (t) => {
  const pluginId = "test.no-grant";
  const { call } = await harness(t, [{ id: pluginId, permissions: ["credentials.use", "net.tcp"] }], {
    registry: {},
  });
  await refusal(
    call(pluginId, "send", {
      credential: { slot: "mailbox", instanceId: "acc_1" },
      envelope: { from: USER, to: ["bob@example.test"] },
      mime: MESSAGE,
    }),
    "PERMISSION_DENIED",
  );
});

test("a sidecar sends through the declared endpoint and never sees the password", async (t) => {
  const server = await smtpServer(t, { mode: "tls" });
  const pluginId = "test.send-preset";
  const { call, host, settings, frames, audits } = await harness(t, [
    { id: pluginId, endpoints: [{ host: "localhost", port: server.port, tls: true }] },
  ]);
  await settings.save(pluginId, "mailbox", { username: USER, password: PASSWORD });

  const result = await call(pluginId, "send", {
    credential: { slot: "mailbox", instanceId: await lastInstance(host, pluginId) },
    endpoint: { host: "localhost", port: server.port },
    envelope: { from: USER, to: ["bob@example.test", "carol@example.test"] },
    mime: MESSAGE,
  });

  assert.deepEqual(result.accepted, ["bob@example.test"]);
  assert.deepEqual(result.rejected, ["carol@example.test"]);
  assert.equal(result.messageId, "Q7");
  assert.ok(server.sawPassword(), "the password reached the server over TLS");
  assert.ok(server.delivered().includes("body"), JSON.stringify(server.delivered()));
  const wire = JSON.stringify(frames);
  assert.ok(!wire.includes(PASSWORD), "the password reached the sidecar");
  assert.ok(!wire.includes(PLAIN), "the SASL payload reached the sidecar");
  const success = audits.find((entry) => entry.api === "mail.send" && entry.ok === true);
  assert.equal(success?.scheme, "smtps");
  assert.equal(success?.recipients, 1);
});

test("a plugin that is unloaded mid-send loses the session", async (t) => {
  const server = await smtpServer(t, { mode: "tls", stall: ["AUTH"] });
  const pluginId = "test.unload";
  const { call, host, settings, runtime, registry } = await harness(t, [
    { id: pluginId, endpoints: [{ host: "localhost", port: server.port, tls: true }] },
  ]);
  await settings.save(pluginId, "mailbox", { username: USER, password: PASSWORD });

  const pending = call(pluginId, "send", {
    credential: { slot: "mailbox", instanceId: await lastInstance(host, pluginId) },
    endpoint: { host: "localhost", port: server.port },
    envelope: { from: USER, to: ["bob@example.test"] },
    mime: MESSAGE,
  });
  // Give the session time to reach AUTH, then take the plugin away.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const started = Date.now();
  await runtime.unload(pluginId);
  await assert.rejects(pending, (error) => {
    // The plugin's call is answered by the unload, and the session itself ends on
    // the same event; either name is the truth, and the deadline is not.
    assert.ok(
      error.code === "PLUGIN_UNLOADED" || error.code === "CONNECT_FAILED",
      `unexpected code ${error.code}`,
    );
    return true;
  });
  assert.ok(Date.now() - started < 5_000, "the session ended with the plugin, not on its deadline");
  assert.deepEqual(registry.list(pluginId), [], "the connection was released with the plugin");

});
test("a spent connection budget fails the send instead of overrunning it", async (t) => {
  const listener = net.createServer((socket) => socket.on("error", () => {}));
  const port = await listen(listener);
  t.after(() => listener.close());
  const pluginId = "test.quota";
  const { call, host, settings } = await harness(
    t,
    [{ id: pluginId, endpoints: [{ host: "localhost", port, tls: false }] }],
    { registry: { maxPerPlugin: 1 } },
  );
  await settings.save(pluginId, "mailbox", { username: USER, password: PASSWORD });
  // Spend the one connection this plugin may hold, then ask to send.
  await call(pluginId, "connect", { endpoint: { host: "localhost", port } });
  await refusal(
    call(pluginId, "send", {
      credential: { slot: "mailbox", instanceId: await lastInstance(host, pluginId) },
      endpoint: { host: "localhost", port },
      envelope: { from: USER, to: ["bob@example.test"] },
      mime: MESSAGE,
    }),
    "LIMIT_EXCEEDED",
  );
});

test("a proxied account sends through its proxy, and the mail host is what is verified", async (t) => {
  const server = await smtpServer(t, { mode: "tls" });
  const proxy = await httpProxy(t, server.port);
  const pluginId = "test.send-proxy";
  const slots = [
    mailSlot({ userSend: { security: ["tls", "starttls"] }, userProxy: { types: ["http"] } }),
  ];
  const { call, host, settings } = await harness(t, [{ id: pluginId, slots, endpoints: [] }]);
  await settings.save(pluginId, "mailbox", {
    username: USER,
    password: PASSWORD,
    sendServer: "localhost",
    sendPort: String(server.port),
    sendSecurity: "tls",
    proxyType: "http",
    proxyHost: "127.0.0.1",
    proxyPort: String(proxy.port),
    proxyUsername: "",
    proxyPassword: "",
  });

  const result = await call(pluginId, "send", {
    credential: { slot: "mailbox", instanceId: await lastInstance(host, pluginId) },
    envelope: { from: USER, to: ["bob@example.test"] },
    mime: MESSAGE,
  });

  assert.deepEqual(result.accepted, ["bob@example.test"]);
  // The proxy was asked for the mail host by name, and the certificate was
  // checked against that name once the tunnel was open.
  assert.deepEqual(proxy.authorities, [`localhost:${server.port}`]);
  assert.ok(server.sawPassword(), "the session authenticated through the tunnel");
});