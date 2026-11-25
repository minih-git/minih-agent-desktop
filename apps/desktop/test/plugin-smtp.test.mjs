/**
 * The SMTP conversation of `mail.send`, against a real socket pair.
 *
 * Every case here is one of the promises the host makes on the user's behalf:
 * the password is never written to an unprotected stream, a server that cannot
 * take the content is refused instead of silently rewriting it, and an aborted
 * or unanswered session ends instead of holding the plugin's concurrency slot.
 *
 * The PKI is test-only: one CA and a `localhost` leaf, the same pair the TCP and
 * IMAP tests generate, so the machine clock anywhere in 2020–2049 verifies.
 */
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { sendSmtpMail } = await import("../electron/main/plugin-smtp.ts");
const { socketTransport } = await import("../electron/main/plugin-smtp-transport.ts");

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

const USER = "alice@example.test";
const PASSWORD = "s3cret-smtp-password";
const PLAIN = Buffer.from(`\u0000${USER}\u0000${PASSWORD}`, "utf8").toString("base64");
const MESSAGE = Buffer.from(
  "From: Alice <alice@example.test>\r\n" +
    "To: bob@example.test\r\n" +
    "Subject: hello\r\n" +
    "\r\n" +
    ".a line that starts with a dot\r\n" +
    "second line\r\n",
  "latin1",
);

// --- the fake server -------------------------------------------------------

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * One SMTP server: implicit TLS or STARTTLS, with the knobs each case needs —
 * which capabilities it advertises, whether it honours the upgrade, which
 * recipients it refuses, and which command it never answers.
 */
async function smtpServer(t, options = {}) {
  const {
    mode = "starttls",
    offerStarttls = true,
    refuseStarttls = false,
    advertise = ["8BITMIME", "AUTH PLAIN LOGIN"],
    password = PASSWORD,
    rejectRcpt = [],
    stall = [],
    queueId = "Q1",
  } = options;
  const state = { lines: [], chunks: [], plain: [], sockets: [], upgraded: 0 };
  const secureContext = tls.createSecureContext({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY });

  const attach = (socket, overTls) => {
    let pending = "";
    let dataMode = false;
    let login = null;
    const reply = (value) => socket.write(`${value}\r\n`);

    const dispatch = (line) => {
      // A LOGIN continuation is one base64 field, not a command.
      if (login) {
        const decoded = Buffer.from(line, "base64").toString("utf8");
        const acceptable = login.step === "user" ? decoded === USER : decoded === password;
        if (!acceptable) {
          reply("535 5.7.8 authentication failed");
          return;
        }
        if (login.step === "user") {
          login.step = "password";
          reply("334 UGFzc3dvcmQ6");
          return;
        }
        login = null;
        reply("235 2.7.0 authentication successful");
        return;
      }
      const command = /^([A-Za-z]+)(?: (.*))?$/.exec(line);
      if (!command) return;
      const name = command[1].toUpperCase();
      const rest = command[2] ?? "";
      if (stall.includes(name)) return;
      switch (name) {
        case "EHLO": {
          const capabilities = [...advertise];
          if (!overTls && offerStarttls) capabilities.push("STARTTLS");
          // A multi-line reply: every line but the last carries `250-`.
          const lines = ["localhost greets you", ...capabilities];
          lines.forEach((entry, index) => {
            reply(`250${index === lines.length - 1 ? " " : "-"}${entry}`);
          });
          return;
        }
        case "STARTTLS":
          if (overTls || !offerStarttls || refuseStarttls) {
            reply("454 TLS is not available");
            return;
          }
          reply("220 Ready to start TLS");
          upgrade(socket);
          return;
        case "AUTH": {
          if (/^PLAIN\s/i.test(rest)) {
            const decoded = Buffer.from(rest.slice(rest.indexOf(" ") + 1), "base64").toString("utf8");
            const [, user, secret] = decoded.split("\u0000");
            reply(
              user === USER && secret === password
                ? "235 2.7.0 authentication successful"
                : "535 5.7.8 authentication failed",
            );
            return;
          }
          if (/^LOGIN\s*$/i.test(rest)) {
            login = { step: "user" };
            reply("334 VXNlcm5hbWU6");
            return;
          }
          reply("504 5.5.4 unrecognised authentication mechanism");
          return;
        }
        case "MAIL": {
          const address = /<([^>]*)>/.exec(rest)?.[1] ?? "";
          reply(address === USER ? "250 2.1.0 sender ok" : "550 5.7.1 sender refused");
          return;
        }
        case "RCPT": {
          const address = /<([^>]*)>/.exec(rest)?.[1] ?? "";
          reply(rejectRcpt.includes(address) ? "550 5.1.1 no such user" : "250 2.1.5 recipient ok");
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
          reply("500 5.5.2 command unrecognised");
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
          reply(`250 2.0.0 Ok: queued as ${queueId}`);
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
      if (!overTls) state.plain.push(chunk);
      pending += chunk.toString("latin1");
      pump();
    });
    socket.on("error", () => {});
    return { reply };
  };

  const upgrade = (socket) => {
    socket.removeAllListeners("data");
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
    state.upgraded += 1;
    state.sockets.push(secure);
    attach(secure, true);
    return secure;
  };

  let server;
  if (mode === "tls") {
    server = tls.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (socket) => {
      state.sockets.push(socket);
      socket.on("error", () => {});
      const client = attach(socket, true);
      client.reply("220 localhost ESMTP");
    });
  } else {
    server = net.createServer((socket) => {
      state.sockets.push(socket);
      socket.on("error", () => {});
      const client = attach(socket, false);
      client.reply("220 localhost ESMTP");
    });
  }
  const port = await listen(server);
  t.after(() => {
    for (const socket of state.sockets) socket.destroy();
    server.close();
  });
  return {
    port,
    lines: state.lines,
    upgraded: () => state.upgraded,
    delivered: () => state.delivered,
    /** Everything the server read before the TLS upgrade. */
    plainText: () => Buffer.concat(state.plain).toString("latin1"),
    sawCredential: () => {
      const seen = Buffer.concat(state.chunks).toString("latin1");
      return seen.includes(PLAIN) || seen.includes(PASSWORD);
    },
    named: (name) => state.lines.filter((line) => new RegExp(`^${name}( |$)`, "i").test(line)),
  };
}

/** A dialer as the host builds one: verify with the test CA, wrap the socket. */
function dialer(security) {
  return async ({ host, port }) => {
    const socket =
      security === "tls"
        ? tls.connect({ host, port, servername: host, ca: TEST_CA, rejectUnauthorized: true })
        : net.connect({ host, port });
    await new Promise((resolve, reject) => {
      socket.once(security === "tls" ? "secureConnect" : "connect", resolve);
      socket.once("error", reject);
    });
    return socketTransport(socket, { host, ca: TEST_CA });
  };
}

function send(server, security, overrides = {}) {
  return sendSmtpMail({
    endpoint: { host: "localhost", port: server.port, security },
    dial: dialer(security),
    credential: { username: USER, password: PASSWORD },
    envelope: { from: USER, to: ["bob@example.test"] },
    mime: MESSAGE,
    ...overrides,
  });
}

function refusal(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    return true;
  });
}

// --- the cases -------------------------------------------------------------

test("an implicit-TLS session logs in and delivers a dot-stuffed message", async (t) => {
  const server = await smtpServer(t, { mode: "tls", rejectRcpt: ["carol@example.test"] });
  const result = await send(server, "tls", {
    envelope: { from: USER, to: ["bob@example.test", "carol@example.test"] },
  });

  assert.deepEqual(result.accepted, ["bob@example.test"]);
  assert.deepEqual(result.rejected, ["carol@example.test"]);
  assert.equal(result.messageId, "Q1");
  const authenticate = server.named("AUTH")[0];
  assert.ok(/AUTH PLAIN/.test(authenticate), JSON.stringify(server.lines));
  assert.equal(
    Buffer.from(authenticate.split("PLAIN ")[1], "base64").toString("utf8"),
    `\u0000${USER}\u0000${PASSWORD}`,
  );
  // The message arrives exactly as the plugin wrote it, except that the leading
  // dot is doubled and every line ends CRLF.
  const delivered = server.delivered();
  assert.ok(delivered.includes("\r\n..a line that starts with a dot\r\n"), JSON.stringify(delivered));
  assert.ok(delivered.endsWith("second line\r\n"), JSON.stringify(delivered));
  assert.deepEqual(
    server.lines
      .filter((line) => /^(MAIL|RCPT|DATA|QUIT)( |$)/.test(line))
      .map((line) => line.split(" ")[0]),
    ["MAIL", "RCPT", "RCPT", "DATA", "QUIT"],
  );
});

test("STARTTLS re-reads the capabilities over TLS before the login", async (t) => {
  const server = await smtpServer(t, { mode: "starttls" });
  await send(server, "starttls");

  assert.equal(server.upgraded(), 1);
  assert.deepEqual(
    server.lines.map((line) => line.split(" ")[0].toUpperCase()),
    ["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"],
  );
  // Nothing in the clear carried the credential: the plaintext half stopped at
  // the STARTTLS command.
  assert.ok(!server.plainText().includes(PLAIN), server.plainText());
  assert.ok(!server.plainText().includes(PASSWORD), server.plainText());
});

test("AUTH LOGIN is used when the server offers no PLAIN", async (t) => {
  const server = await smtpServer(t, { mode: "tls", advertise: ["8BITMIME", "AUTH LOGIN"] });
  await send(server, "tls");
  assert.ok(/^AUTH LOGIN/.test(server.named("AUTH")[0]), JSON.stringify(server.lines));
  // The two fields travel base64-encoded, so `sawCredential` (the PLAIN blob)
  // does not see them; the exchange still carried them.
  assert.ok(server.lines.includes(Buffer.from(USER, "utf8").toString("base64")), JSON.stringify(server.lines));
  assert.ok(server.lines.includes(Buffer.from(PASSWORD, "utf8").toString("base64")), JSON.stringify(server.lines));
});

test("a server without STARTTLS fails instead of falling back to plaintext", async (t) => {
  const server = await smtpServer(t, { mode: "starttls", offerStarttls: false });
  await refusal(send(server, "starttls"), "STARTTLS_UNAVAILABLE");
  assert.equal(server.upgraded(), 0);
  assert.ok(!server.sawCredential(), "no credential byte reached the server at all");
});

test("a server that offers STARTTLS and then refuses it is still unavailable", async (t) => {
  const server = await smtpServer(t, { mode: "starttls", refuseStarttls: true });
  await refusal(send(server, "starttls"), "STARTTLS_UNAVAILABLE");
  assert.equal(server.upgraded(), 0, "nothing was upgraded");
  assert.ok(!server.sawCredential(), "no credential byte reached the server at all");
});

test("a refused login is AUTH_FAILED and no mail command follows", async (t) => {
  const server = await smtpServer(t, { mode: "tls", password: "a-different-password" });
  await refusal(send(server, "tls"), "AUTH_FAILED");
  assert.equal(server.named("MAIL").length, 0, JSON.stringify(server.lines));
});

test("a refused sender is SENDER_REJECTED", async (t) => {
  const server = await smtpServer(t, { mode: "tls" });
  await refusal(
    send(server, "tls", { envelope: { from: "someone-else@example.test", to: ["bob@example.test"] } }),
    "SENDER_REJECTED",
  );
});

test("every refused recipient fails the send, and the refusal names them", async (t) => {
  const server = await smtpServer(t, { mode: "tls", rejectRcpt: ["bob@example.test"] });
  await assert.rejects(send(server, "tls"), (error) => {
    assert.equal(error.code, "RECIPIENT_REJECTED");
    assert.match(error.message, /bob@example\.test/);
    assert.ok(!/no such user/.test(error.message), "the server's own text must not be relayed");
    return true;
  });
  assert.equal(server.named("DATA").length, 0, "nothing was offered for delivery");
});

test("eight-bit content is refused when the server cannot take it", async (t) => {
  const server = await smtpServer(t, { mode: "tls", advertise: ["AUTH PLAIN"] });
  await refusal(
    send(server, "tls", { mime: Buffer.from([0x46, 0xff, 0x0a]) }),
    "MAIL_EIGHT_BIT_UNSUPPORTED",
  );
  assert.equal(server.named("DATA").length, 0);
});

test("an aborted send stops mid-session", async (t) => {
  const server = await smtpServer(t, { mode: "tls", stall: ["AUTH"] });
  const controller = new AbortController();
  const pending = send(server, "tls", { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await refusal(pending, "CONNECT_FAILED");
  assert.equal(server.named("MAIL").length, 0);
});

test("a server that never answers is stopped by the deadline", async (t) => {
  const server = await smtpServer(t, { mode: "tls", stall: ["EHLO"] });
  const started = Date.now();
  await refusal(send(server, "tls", { timeoutMs: 50 }), "TIMEOUT");
  assert.ok(Date.now() - started < 2_000, "the deadline ended the session");
});