/**
 * IMAP login on a host-owned TCP connection (permission `net.tcp`).
 *
 * The host adds one parameter to `connect`, so a mailbox plugin never handles
 * the credential itself:
 *
 *   registry.connect({
 *     pluginId: string,
 *     endpoint: { host, port, tls },
 *     timeoutMs?: number,
 *     imap?: { username: string; password: string },
 *   }): Promise<{ connectionId: string; authenticated?: true }>
 *
 * The runtime validates and resolves the credential slot; the registry owns the
 * dialogue. Everything asserted here is either a byte observed by a real
 * `node:tls` IMAP server the test owns, or an event the host hands to the
 * plugin:
 *
 * - the mechanism the host picks — `AUTHENTICATE PLAIN` with SASL-IR,
 *   `AUTHENTICATE PLAIN` with a continuation (after asking CAPABILITY), `LOGIN`
 *   with quoted strings — and that it refuses when the server leaves no usable
 *   one;
 * - `PREAUTH` authenticates without a credential ever reaching the wire;
 * - a server that says `NO` fails the connect without echoing the secret, and a
 *   credential the command line cannot carry is refused before the socket is
 *   dialed at all;
 * - bytes that share a read chunk with the auth response still reach the
 *   plugin, and the dialogue the host consumed does not;
 * - the connection is usable afterwards (the plugin's own `SELECT` exchanges
 *   bytes), and a failed or interrupted login leaves no connection, no slot and
 *   no socket behind.
 *
 * The trust anchor is the same test-only CA the registry tests use: it is a
 * dependency of the host side, so no plugin call can widen trust.
 */
import assert from "node:assert/strict";
import tls from "node:tls";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// A private data directory: nothing here may touch the user's plugin state.
const scratch = process.env.PI_SCRATCH_DIR ?? tmpdir();
const dataDir = mkdtempSync(join(scratch, "tcp-imap-login-"));
process.env.MINIH_AGENT_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginTcpRegistry } = await import("../electron/main/plugin-tcp.ts");
const { PluginSocketError } = await import("../electron/main/plugin-websocket.ts");

const PLUGIN_ID = "com.example.mail";
/** A connect that must not reach its own timer during a test. */
const SLOW_TIMEOUT = 30_000;

const USER = "alice@example.test";
const PASSWORD = "s3cret-password";
/** Quoting only shows up with these two characters in a value. */
const QUOTED_USER = 'alice"q';
const QUOTED_PASSWORD = "pa\\ss";

// Test-only PKI: one CA and a `localhost` leaf, identical to the registry
// tests. Valid 2020–2049, so a machine clock anywhere in that window verifies.
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

// --- helpers ---------------------------------------------------------------

/** Start listening on a loopback port and hand back that port. */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * Split one received line into the pieces the cases care about. A continuation
 * payload (the `AUTHENTICATE` answer, base64) has no tag and no alphabetic verb,
 * so it comes back as `{ tag: null, name: null, line }`.
 */
function parseCommand(line) {
  const match = /^(\S+) ([A-Za-z][A-Za-z0-9._-]*)(?: (.*))?$/.exec(line);
  if (!match) return { tag: null, name: null, args: null, line };
  return { tag: match[1], name: match[2].toUpperCase(), args: match[3] ?? "", line };
}

/**
 * A real TLS IMAP server. It records every line and every byte it received,
 * answers `CAPABILITY` itself, and leaves the rest of the dialogue to the case
 * that owns it. `advertise` overrides what a CAPABILITY answer lists, so a
 * greeting without a `[CAPABILITY …]` code still has a scripted answer.
 */
async function imapServer(t, { greeting = "* OK [CAPABILITY IMAP4rev1] ready", advertise, respond } = {}) {
  const sockets = [];
  const lines = [];
  const chunks = [];
  const announced = /\[CAPABILITY ([^\]]*)\]/.exec(greeting ?? "");
  const capabilities = advertise ?? (announced ? announced[1].split(" ") : ["IMAP4rev1"]);

  const server = tls.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    if (greeting) socket.write(`${greeting}\r\n`);

    const handle = (line) => {
      const command = parseCommand(line);
      const context = {
        command,
        reply: (text) => socket.write(`${text}\r\n`),
        write: (text) => socket.write(text),
      };
      // A host may trust the greeting or ask again; both are answered here.
      if (command.name === "CAPABILITY") {
        context.reply(`* CAPABILITY ${capabilities.join(" ")}`);
        context.reply(`${command.tag} OK CAPABILITY completed`);
        return;
      }
      respond?.(context);
    };

    let pending = "";
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      pending += chunk.toString("utf8");
      let index = pending.indexOf("\r\n");
      while (index !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 2);
        lines.push(line);
        handle(line);
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
    /** Everything this server received, decoded: the whole wire, in order. */
    text: () => Buffer.concat(chunks).toString("utf8"),
    named: (name) => lines.map(parseCommand).filter((command) => command.name === name),
  };
}

function recorder() {
  const events = [];
  return { events, onEvent: (pluginId, event) => events.push({ pluginId, event }) };
}

/** Everything the plugin was handed, which must never include the secret. */
function delivered(events) {
  return events
    .filter((entry) => entry.pluginId === PLUGIN_ID && entry.event.type === "data")
    .map((entry) => Buffer.from(entry.event.data).toString("utf8"))
    .join("");
}

/** Dispose in cleanup; a failure here was already asserted by the test body. */
function registryOf(t, dependencies) {
  const registry = new PluginTcpRegistry(dependencies);
  t.after(async () => {
    await registry.dispose().catch(() => {});
  });
  return registry;
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

/** A promise the test can watch without letting it hang the run. */
function withDeadline(promise, what, timeoutMs = 3_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The SASL PLAIN payload: authorization identity left empty. */
function plainPayload(username, password) {
  return Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
}

function decodeBase64(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

function imapEndpoint(port) {
  return { host: "localhost", port, tls: true };
}

function imapRequest(port, imap = { username: USER, password: PASSWORD }, extra = {}) {
  return { pluginId: PLUGIN_ID, endpoint: imapEndpoint(port), imap, ...extra };
}

/** A failed login is the host's refusal type, never a socket error. */
async function expectRefusal(run, code, label) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof PluginSocketError, `${label}: expected PluginSocketError, got ${error}`);
    assert.equal(error.code, code, `${label}: unexpected code ${error.code}`);
    return true;
  });
}

// --- AUTH=PLAIN with SASL-IR ----------------------------------------------

test("AUTH=PLAIN with SASL-IR puts the credential on the AUTHENTICATE line", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE") reply(`${command.tag} OK authenticated`);
    },
  });
  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const result = await registry.connect(imapRequest(server.port));
  assert.equal(result.authenticated, true);
  assert.equal(typeof result.connectionId, "string");

  const attempts = server.named("AUTHENTICATE");
  assert.equal(attempts.length, 1, `one AUTHENTICATE expected, saw ${JSON.stringify(server.lines)}`);
  assert.match(attempts[0].args, /^PLAIN /, "SASL-IR was offered, so the payload belongs on the same line");
  assert.equal(decodeBase64(attempts[0].args.slice("PLAIN ".length)), `\u0000${USER}\u0000${PASSWORD}`);
  assert.equal(server.named("LOGIN").length, 0, "PLAIN was available, so LOGIN must not be used");
  // The plugin learns about the connection once, and only once it is usable.
  assert.deepEqual(events.map((entry) => entry.event.type), ["open"]);
  // The credential is the host's business: it never travels back to the plugin.
  assert.equal(delivered(events), "");
  assert.deepEqual(registry.list(PLUGIN_ID).map((entry) => entry.state), ["open"]);
});

// --- AUTH=PLAIN with a continuation ---------------------------------------

test("AUTH=PLAIN without SASL-IR asks for capabilities, then answers the continuation", async (t) => {
  const state = { stage: "waiting-for-command", tag: null, payload: null, args: null };
  const server = await imapServer(t, {
    // No CAPABILITY code in the greeting: the host has to ask before it can
    // know which mechanism the server allows.
    greeting: "* OK mailbox ready",
    advertise: ["IMAP4rev1", "AUTH=PLAIN"],
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE" && state.stage === "waiting-for-command") {
        state.stage = "waiting-for-payload";
        state.tag = command.tag;
        state.args = command.args;
        reply("+ ");
        return;
      }
      // A continuation answer carries no tag and no verb.
      if (state.stage === "waiting-for-payload" && command.name === null) {
        state.stage = "done";
        state.payload = command.line;
        reply(`${state.tag} OK authenticated`);
      }
    },
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const result = await registry.connect(imapRequest(server.port));
  assert.equal(result.authenticated, true);
  assert.equal(state.stage, "done", `the dialogue stopped at ${state.stage}: ${JSON.stringify(server.lines)}`);
  assert.equal(server.named("CAPABILITY").length, 1, "the greeting carried no capabilities");
  assert.equal(state.args, "PLAIN", "without SASL-IR the first line carries the mechanism only");
  assert.equal(decodeBase64(state.payload), `\u0000${USER}\u0000${PASSWORD}`);
  assert.equal(server.named("AUTHENTICATE").length, 1);
});

// --- LOGIN fallback -------------------------------------------------------

test("LOGIN quotes and escapes the user name and the password", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 LOGIN] ready",
    respond: ({ command, reply }) => {
      if (command.name === "LOGIN") reply(`${command.tag} OK authenticated`);
    },
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const result = await registry.connect(
    imapRequest(server.port, { username: QUOTED_USER, password: QUOTED_PASSWORD }),
  );
  assert.equal(result.authenticated, true);

  const attempts = server.named("LOGIN");
  assert.equal(attempts.length, 1, `one LOGIN expected, saw ${JSON.stringify(server.lines)}`);
  // RFC 3501 quoted string: `"` and `\` are escaped with a backslash, and an
  // atom cannot be used because both values need quoting.
  assert.equal(attempts[0].args, String.raw`"alice\"q" "pa\\ss"`);
  assert.equal(server.named("AUTHENTICATE").length, 0, "PLAIN was not offered, so LOGIN is the only choice");
});

// --- no usable mechanism --------------------------------------------------

test("a server that disables LOGIN and offers no PLAIN is refused before the credential is sent", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=CRAM-MD5 LOGINDISABLED] ready",
    // Anything the host might wrongly try is accepted, so only the refusal
    // below can decide the case.
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE" || command.name === "LOGIN") {
        reply(`${command.tag} OK authenticated`);
      }
    },
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  await expectRefusal(registry.connect(imapRequest(server.port)), "CREDENTIAL_UNSUPPORTED", "no usable mechanism");

  assert.equal(server.text(), "", `nothing may be sent: ${JSON.stringify(server.lines)}`);
  await waitFor(() => registry.list(PLUGIN_ID).length === 0);
});

test("a credential the LOGIN command line cannot carry is refused without being sent", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1] ready",
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE" || command.name === "LOGIN") {
        reply(`${command.tag} OK authenticated`);
      }
    },
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  // No AUTH=PLAIN, so LOGIN is the only mechanism, and a quoted string cannot
  // carry anything outside printable ASCII.
  await expectRefusal(
    registry.connect(imapRequest(server.port, { username: USER, password: "pässwörd" })),
    "CREDENTIAL_UNSUPPORTED",
    "a non-ASCII password",
  );

  assert.equal(server.text(), "", `nothing may be written: ${JSON.stringify(server.lines)}`);
  await waitFor(() => registry.list(PLUGIN_ID).length === 0);
});

test("a credential carrying a line break is refused before the socket is dialed", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  // A line break would let a credential write its own IMAP commands.
  const cases = [
    ["a CRLF in the user name", { username: "alice\r\nA9 LOGOUT", password: PASSWORD }],
    ["a line feed in the password", { username: USER, password: "pa\nss" }],
    ["a NUL in the password", { username: USER, password: "pa\0ss" }],
  ];
  for (const [label, imap] of cases) {
    await expectRefusal(registry.connect(imapRequest(server.port, imap)), "CREDENTIAL_UNSUPPORTED", label);
  }

  assert.deepEqual(server.sockets, [], "a credential refused that early must not dial at all");
  assert.equal(server.text(), "");
  assert.deepEqual(registry.list(PLUGIN_ID), []);
});

// --- PREAUTH --------------------------------------------------------------

test("a PREAUTH greeting authenticates without a credential on the wire", async (t) => {
  const server = await imapServer(t, {
    greeting: "* PREAUTH [CAPABILITY IMAP4rev1] mailbox is already authenticated",
    respond: () => {},
  });
  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const result = await registry.connect(imapRequest(server.port));
  assert.equal(result.authenticated, true);
  assert.equal(server.named("AUTHENTICATE").length, 0, "PREAUTH needs no authentication");
  assert.equal(server.named("LOGIN").length, 0);
  assert.equal(server.text(), "", "PREAUTH must not put the credential on the wire");
  assert.equal(delivered(events), "");
  assert.deepEqual(registry.list(PLUGIN_ID).map((entry) => entry.state), ["open"]);
});

// --- a refusal from the server --------------------------------------------

test("a NO from the server fails the connect without echoing the secret", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE") reply(`${command.tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
    },
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  await expectRefusal(registry.connect(imapRequest(server.port)), "CREDENTIAL_REJECTED", "login refused by the server");

  await assert.rejects(registry.connect(imapRequest(server.port)), (error) => {
    assert.match(error.message, /login|auth|credential/i, `the message must name the failed step: ${error.message}`);
    for (const secret of [PASSWORD, plainPayload(USER, PASSWORD)]) {
      assert.ok(!error.message.includes(secret), `the message leaked the credential: ${error.message}`);
      assert.ok(!String(error.stack ?? "").includes(secret), "the stack leaked the credential");
    }
    return true;
  });

  // The socket of a refused login is gone, not left half-authenticated.
  await waitFor(() => registry.list(PLUGIN_ID).length === 0);
  await waitFor(() => server.sockets.every((socket) => socket.destroyed));
});

// --- the tail of the same chunk -------------------------------------------

test("bytes after the auth response in the same chunk still reach the plugin", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
    respond: ({ command, write }) => {
      if (command.name !== "AUTHENTICATE") return;
      // One write, two responses: the login reads its own completion line and
      // must hand the rest of the chunk back to the plugin untouched.
      write(`${command.tag} OK login-complete\r\n* 2 EXISTS\r\n`);
    },
  });
  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const result = await registry.connect(imapRequest(server.port));
  assert.equal(result.authenticated, true);

  await waitFor(() => delivered(events).includes("2 EXISTS"));
  const seen = delivered(events);
  assert.ok(!seen.includes("login-complete"), `the consumed dialogue reached the plugin: ${JSON.stringify(seen)}`);
  assert.ok(!seen.includes(PASSWORD), "the credential reached the plugin");
});

test("authentication traffic is included in TCP usage", async (t) => {
  const greeting = "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready";
  const response = "MHA2 OK authenticated";
  const server = await imapServer(t, {
    greeting,
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE") reply(response);
    },
  });
  const rows = [];
  const registry = registryOf(t, {
    onEvent: () => {}, tlsCa: TEST_CA,
    onUsage: (usage) => rows.push(...usage),
  });
  await registry.connect(imapRequest(server.port));
  await registry.flush();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bytesIn, Buffer.byteLength(`${greeting}\r\n${response}\r\n`));
  assert.equal(rows[0].bytesOut, Buffer.byteLength(server.text()));
  assert.ok(rows[0].bytesOut > 0);
});

// --- the connection is the plugin's --------------------------------------

test("after the login the connection carries the plugin's own commands", async (t) => {
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
    respond: ({ command, reply }) => {
      if (command.name === "AUTHENTICATE") {
        reply(`${command.tag} OK authenticated`);
        return;
      }
      if (command.name === "SELECT") {
        reply("* 3 EXISTS");
        reply("* 0 RECENT");
        reply(`${command.tag} OK [READ-WRITE] Select completed`);
      }
    },
  });
  const { events, onEvent } = recorder();
  const registry = registryOf(t, { onEvent, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const { connectionId } = await registry.connect(imapRequest(server.port));
  assert.deepEqual(registry.list(PLUGIN_ID).map((entry) => entry.state), ["open"]);

  registry.send({ pluginId: PLUGIN_ID, connectionId, data: 'a7 SELECT "INBOX"\r\n' });
  await waitFor(() => delivered(events).includes("3 EXISTS"));
  const seen = delivered(events);
  assert.ok(seen.includes("a7 OK"), `the plugin's tag must come back untouched: ${JSON.stringify(seen)}`);

  const selects = server.named("SELECT");
  assert.equal(selects.length, 1);
  assert.equal(selects[0].tag, "a7");
  assert.equal(selects[0].args, '"INBOX"');
});

// --- cleanup --------------------------------------------------------------

test("a refused login leaves no connection, no slot and no socket", async (t) => {
  let attempts = 0;
  const server = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
    respond: ({ command, reply }) => {
      if (command.name !== "AUTHENTICATE") return;
      attempts += 1;
      if (attempts === 1) reply(`${command.tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
      else reply(`${command.tag} OK authenticated`);
    },
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  await expectRefusal(registry.connect(imapRequest(server.port)), "CREDENTIAL_REJECTED", "refused login");

  await waitFor(() => registry.list(PLUGIN_ID).length === 0);
  await waitFor(() => server.sockets.every((socket) => socket.destroyed));

  // The slot the failed attempt spent is free again.
  const retry = await registry.connect(imapRequest(server.port));
  assert.equal(retry.authenticated, true);
  assert.equal(attempts, 2);
});

test("unload during a stalled authentication settles the connect", async (t) => {
  const silent = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
  });
  const registry = new PluginTcpRegistry({ onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });
  t.after(async () => {
    await registry.dispose().catch(() => {});
  });

  const pending = registry.connect(imapRequest(silent.port)).then(
    () => null,
    (error) => error,
  );
  await waitFor(() => silent.named("AUTHENTICATE").length === 1);

  registry.releasePlugin(PLUGIN_ID);
  const error = await withDeadline(pending, "the stalled login");
  assert.ok(error instanceof PluginSocketError, `expected a refusal, got ${error}`);
  assert.equal(typeof error.code, "string");
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  await waitFor(() => silent.sockets.every((socket) => socket.destroyed));
});

test("quit during a stalled authentication settles the connect", async (t) => {
  const silent = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
  });
  const registry = new PluginTcpRegistry({ onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: SLOW_TIMEOUT });

  const pending = registry.connect(imapRequest(silent.port)).then(
    () => null,
    (error) => error,
  );
  await waitFor(() => silent.named("AUTHENTICATE").length === 1);

  await withDeadline(registry.dispose(), "dispose() during a stalled login");
  const error = await withDeadline(pending, "the stalled login");
  assert.ok(error instanceof PluginSocketError, `expected a refusal, got ${error}`);
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  await waitFor(() => silent.sockets.every((socket) => socket.destroyed));
});

test("the connect deadline covers the login and frees the slot", async (t) => {
  const silent = await imapServer(t, {
    greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready",
  });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA });

  await assert.rejects(registry.connect(imapRequest(silent.port, undefined, { timeoutMs: 150 })), (error) => {
    assert.equal(error.code, "TIMEOUT", `the login must stay inside the connect deadline, got ${error.code}`);
    return true;
  });
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  await waitFor(() => silent.sockets.every((socket) => socket.destroyed));
});

// --- an ordinary connection is not a mailbox ------------------------------

test("a connect without imap opens the socket without waiting for a greeting", async (t) => {
  // No greeting at all: anything that waited for an IMAP banner would time out.
  const server = await imapServer(t, { greeting: null, respond: () => {} });
  const registry = registryOf(t, { onEvent: () => {}, tlsCa: TEST_CA, connectTimeoutMs: 500 });

  const result = await registry.connect({ pluginId: PLUGIN_ID, endpoint: imapEndpoint(server.port) });
  assert.equal(typeof result.connectionId, "string");
  assert.notEqual(result.authenticated, true);
  assert.deepEqual(registry.list(PLUGIN_ID).map((entry) => entry.state), ["open"]);
  assert.deepEqual(server.lines, [], "an ordinary connection has no dialogue of its own");
});