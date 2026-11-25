/**
 * Per-account proxies, seen from the dialer: HTTP `CONNECT` and SOCKS5 tunnels
 * in front of a local mail server.
 *
 * What is proved here is the boundary around a proxied mail login, not a full
 * mailbox:
 *
 * - a tunnel reaches an implicit-TLS IMAP login, with the certificate checked
 *   against the *mail* host and the proxy only ever seeing the mail host's name;
 * - bytes that arrive with the proxy's own reply belong to the mail server — for
 *   STARTTLS that is the greeting, and losing it would stall the login;
 * - a proxy that refuses the login, refuses the tunnel, or is not running fails
 *   the connection with its own code and never falls back to a direct dial.
 *
 * Isolation: every server is local, the registry gets the test CA as its only
 * trust anchor, and no plugin process is involved.
 */
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import test from "node:test";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginTcpRegistry } = await import("../electron/main/plugin-tcp.ts");
const { readTcpProxy } = await import("../electron/main/plugin-tcp-proxy.ts");

const USER = "alice@example.test";
const PASSWORD = "s3cret-mail-password";

// Test-only PKI: one CA and a `localhost` leaf, the same pair the other TCP
// suites use, valid across a machine clock anywhere in 2020–2049.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBTDCB86ADAgECAgIQADAKBggqhkjOPQQDAjAdMRswGQYDVQQDDBJwbHVnaW4t
dGNwIHRlc3QgQ0EwHhcNMjAwMTAxMDAwMDAwWhcNNDkxMjMxMDAwMDAwWjAdMRsw
GQYDVQQDDBJwbHVnaW4tdGNwIHRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAAQ9gDPjJSs35q8+fhMiWbcQGw9tiDl5OuLP1RtR4cQp/Cmhw9gCX3FLNiI9
LxJ0NZkrO5x920ogkerXL8J2vxoKoyMwITAPBgNVHRMBAf8EBTADAQH/MA4GA1Ud
DwEB/wQEAwIBBjAKBggqhkjOPQQDAgNIADBFAiArK1Fd78YK7MG7+6b0LCwfIoSp
K6hwAc0KbRDzFG+4GgIhAJUYz72c4QxhQuL6iBpYfhCXWnn14J+oFsEJ0ZQOFxbb
-----END CERTIFICATE-----`;

const LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIBcTCCARigAwIBAgICEAEwCgYIKoZIzj0EAwIwHTEbMBkGA1UEAwwScGx1Z2lu
LXRjcCB0ZXN0IENBMB4XDTIwMDEwMTAwMDAwMFoXDTQ5MTIzMTAwMDAwMFowFDES
MBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr6mv
eRoT56WuTylMyvLSg1JdsvWhm/w+Y6OrURZdsy6yqvGRKUYg9R9S0q//IyesevCe
2pI9zcHwDaIb69q1S6NRME8wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4Aw
EwYDVR0lBAwwCgYIKwYBBQUHAwEwGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAAB
MAoGCCqGSM49BAMCA0cAMEQCIAVPVrjhtp/+pPKabuGpHlLYaXMCnVKHQETLEyCS
we2XAiAbq4EYB05ZIoIpTLJ77mT/OeXh+p61nOz2gzUku2yZEQ==
-----END CERTIFICATE-----`;

const LEAF_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIE+6JrEC49MJ13LM8ReLgfWfFn/qh6kVAw8HXEx8U0tuoAoGCCqGSM49
AwEHoUQDQgAEr6mveRoT56WuTylMyvLSg1JdsvWhm/w+Y6OrURZdsy6yqvGRKUYg
9R9S0q//IyesevCe2pI9zcHwDaIb69q1Sw==
-----END EC PRIVATE KEY-----`;

/** A connect that must not reach its own timer during a test. */
const SLOW_TIMEOUT = 30_000;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * An IMAP server over implicit TLS: greeting, capabilities, then a login that
 * always succeeds. `lines` is every line it was sent.
 */
async function imapTlsServer(t) {
  const state = { lines: [], sockets: 0 };
  const server = tls.createServer({ cert: LEAF_CERT, key: LEAF_KEY }, (socket) => {
    state.sockets += 1;
    socket.on("error", () => {});
    let buffered = "";
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] ready\r\n");
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let end = buffered.indexOf("\r\n");
      while (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        state.lines.push(line);
        const tagged = /^(\S+) (AUTHENTICATE|COMMAND)(?: .*)?$/i.exec(line);
        if (tagged) socket.write(`${tagged[1]} OK done\r\n`);
        end = buffered.indexOf("\r\n");
      }
    });
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
  });
  return { port, lines: state.lines, sockets: () => state.sockets };
}

/**
 * A POP3 server that speaks first, so its greeting can arrive together with a
 * proxy reply, and answers `CAPA` with `STLS` on offer.
 */
async function pop3PlainServer(t) {
  const state = { lines: [] };
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("+OK ready\r\n");
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let end = buffered.indexOf("\r\n");
      while (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        state.lines.push(line);
        if (/^CAPA$/i.test(line)) socket.write("+OK\r\nUSER\r\nSTLS\r\n.\r\n");
        // The point of this case is the greeting, not the upgrade: refuse STLS
        // so the login ends promptly once the capability round trip is done.
        if (/^STLS$/i.test(line)) socket.write("-ERR not now\r\n");
        end = buffered.indexOf("\r\n");
      }
    });
  });
  const port = await listen(server);
  t.after(() => {
    server.close();
  });
  return { port, lines: state.lines };
}

/**
 * An HTTP `CONNECT` proxy in front of one upstream port.
 *
 * `status` lets a case answer 407 or 502 instead of opening the tunnel, and
 * `coalesce` writes the upstream's first bytes in the same chunk as the proxy's
 * own reply — the STARTTLS case this suite exists for.
 */
async function httpProxy(t, { upstreamPort, status = 200, coalesce = false }) {
  const state = { authorities: [], authenticated: [] };
  const server = net.createServer((client) => {
    client.on("error", () => {});
    let head = "";
    const onData = async (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      client.removeListener("data", onData);
      const request = head.slice(0, head.indexOf("\r\n\r\n")).split("\r\n");
      const [, authority] = /^CONNECT (\S+) HTTP\/1\.[01]$/i.exec(request[0]) ?? [];
      state.authorities.push(authority ?? request[0]);
      const auth = request.find((line) => /^Proxy-Authorization:/i.test(line));
      state.authenticated.push(auth ?? "");
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status} refused\r\n\r\n`);
        return;
      }
      const upstream = net.connect({ host: "127.0.0.1", port: upstreamPort });
      upstream.on("error", () => client.destroy());
      if (!coalesce) {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
        return;
      }
      // Hold the upstream's greeting, then hand it over with the reply. The
      // listener is what makes the socket flow; pausing first would starve it.
      let greeting = Buffer.alloc(0);
      const collect = (chunk) => {
        greeting = Buffer.concat([greeting, chunk]);
        if (greeting.includes("\r\n")) {
          upstream.removeListener("data", collect);
          client.write(Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), greeting]));
          upstream.pipe(client);
          client.pipe(upstream);
        }
      };
      upstream.on("data", collect);
    };
    client.on("data", onData);
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { port, authorities: state.authorities, authenticated: state.authenticated };
}

/**
 * A SOCKS5 proxy in front of one upstream port.
 *
 * `requireLogin` makes it demand RFC 1929 credentials and accept only `tunnel` /
 * `s3cret`; `coalesce` hands the upstream's greeting over with the CONNECT reply.
 */
async function socksProxy(t, { upstreamPort, requireLogin = false, coalesce = false }) {
  const state = { targets: [], logins: [] };
  const server = net.createServer((client) => {
    client.on("error", () => {});
    let stage = "greeting";
    const onData = async (chunk) => {
      if (stage === "greeting") {
        if (chunk[0] !== 0x05) return client.destroy();
        const methods = [...chunk.subarray(2, 2 + chunk[1])];
        if (requireLogin && !methods.includes(0x02)) {
          client.write(Buffer.from([0x05, 0xff]));
          return;
        }
        const chosen = requireLogin ? 0x02 : 0x00;
        client.write(Buffer.from([0x05, chosen]));
        stage = requireLogin ? "login" : "connect";
        return;
      }
      if (stage === "login") {
        const userLength = chunk[1];
        const user = chunk.subarray(2, 2 + userLength).toString("utf8");
        const passwordLength = chunk[2 + userLength];
        const password = chunk.subarray(3 + userLength, 3 + userLength + passwordLength).toString("utf8");
        state.logins.push({ user, password });
        const ok = user === "tunnel" && password === "s3cret";
        client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) return;
        stage = "connect";
        return;
      }
      if (stage === "connect") {
        client.removeListener("data", onData);
        const atyp = chunk[3];
        let authority;
        if (atyp === 0x03) {
          const length = chunk[4];
          authority = `${chunk.subarray(5, 5 + length).toString("utf8")}:${chunk.readUInt16BE(5 + length)}`;
        } else {
          authority = "ip-literal";
        }
        state.targets.push(authority);
        const upstream = net.connect({ host: "127.0.0.1", port: upstreamPort });
        upstream.on("error", () => client.destroy());
        const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]);
        if (!coalesce) {
          client.write(reply);
          upstream.pipe(client);
          client.pipe(upstream);
          return;
        }
        let greeting = Buffer.alloc(0);
        const collect = (data) => {
          greeting = Buffer.concat([greeting, data]);
          if (greeting.includes("\r\n")) {
            upstream.removeListener("data", collect);
            client.write(Buffer.concat([reply, greeting]));
            upstream.pipe(client);
            client.pipe(upstream);
            upstream.resume();
          }
        };
        upstream.on("data", collect);
        stage = "tunnel";
      }
    };
    client.on("data", onData);
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { port, targets: state.targets, logins: state.logins };
}

function registryOf(t) {
  const registry = new PluginTcpRegistry({
    tlsCa: TEST_CA,
    connectTimeoutMs: SLOW_TIMEOUT,
    onEvent: () => {},
  });
  t.after(() => registry.dispose());
  return registry;
}

const PLUGIN = "test.proxy";

function login(protocol, security) {
  return { username: USER, password: PASSWORD, protocol, security };
}

async function refusal(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    assert.ok(!error.message.includes(PASSWORD), "a refusal never quotes a credential");
    return true;
  });
}

test("an HTTP CONNECT tunnel reaches an implicit-TLS IMAP login", async (t) => {
  const mail = await imapTlsServer(t);
  const proxy = await httpProxy(t, { upstreamPort: mail.port });
  const registry = registryOf(t);

  const result = await registry.connect({
    pluginId: PLUGIN,
    endpoint: { host: "localhost", port: mail.port, tls: true },
    login: login("imap", "tls"),
    proxy: { type: "http", host: "127.0.0.1", port: proxy.port },
  });

  assert.ok(result.connectionId);
  // The proxy was asked for the mail host by name, and no proxy credential was
  // invented for an account that has none.
  assert.deepEqual(proxy.authorities, [`localhost:${mail.port}`]);
  assert.deepEqual(proxy.authenticated, [""]);
  assert.ok(mail.lines.some((line) => /AUTHENTICATE PLAIN/.test(line)), JSON.stringify(mail.lines));
  assert.equal(registry.list(PLUGIN).length, 1);
});

test("a proxy login travels as Proxy-Authorization, and only to the proxy", async (t) => {
  const mail = await imapTlsServer(t);
  const proxy = await httpProxy(t, { upstreamPort: mail.port });
  const registry = registryOf(t);

  await registry.connect({
    pluginId: PLUGIN,
    endpoint: { host: "localhost", port: mail.port, tls: true },
    login: login("imap", "tls"),
    proxy: { type: "http", host: "127.0.0.1", port: proxy.port, username: "tunnel", password: "s3cret" },
  });

  const basic = Buffer.from("tunnel:s3cret", "utf8").toString("base64");
  assert.deepEqual(proxy.authenticated, [`Proxy-Authorization: Basic ${basic}`]);
  // The mail server only ever sees the mail login, never the proxy's.
  assert.ok(!mail.lines.some((line) => line.includes(basic)));
  assert.ok(!mail.lines.some((line) => line.includes("s3cret")));
});

test("the certificate is checked against the mail host, never the proxy", async (t) => {
  const mail = await imapTlsServer(t);
  const proxy = await httpProxy(t, { upstreamPort: mail.port });
  const registry = registryOf(t);

  // The proxy resolves the name (it is given the name, not an address), and the
  // tunnel then lands on a certificate issued for `localhost`.
  await refusal(
    registry.connect({
      pluginId: PLUGIN,
      endpoint: { host: "imap.example.test", port: 993, tls: true },
      login: login("imap", "tls"),
      proxy: { type: "http", host: "127.0.0.1", port: proxy.port },
    }),
    "TLS_CERTIFICATE",
  );
  assert.deepEqual(proxy.authorities, ["imap.example.test:993"]);
  // Failed before any login line: the handshake never completed.
  assert.equal(mail.lines.filter((line) => /AUTHENTICATE/.test(line)).length, 0);
});

test("a SOCKS5 reply and the mail greeting in one chunk still logs in", async (t) => {
  const mail = await pop3PlainServer(t);
  const proxy = await socksProxy(t, { upstreamPort: mail.port, coalesce: true });
  const registry = registryOf(t);

  await refusal(
    registry.connect({
      pluginId: PLUGIN,
      endpoint: { host: "localhost", port: mail.port, tls: false },
      login: login("pop3", "starttls"),
      proxy: { type: "socks5", host: "127.0.0.1", port: proxy.port },
    }),
    "STARTTLS_UNAVAILABLE",
  );

  // The greeting arrived with the proxy's own reply and was still processed: the
  // client went on to ask for capabilities without waiting for anything else.
  await waitFor(() => mail.lines.some((line) => /^CAPA$/i.test(line)), "CAPA after the greeting");
  assert.deepEqual(proxy.targets, [`localhost:${mail.port}`]);
});

test("a SOCKS5 proxy that wants a login gets it, and a wrong one is reported", async (t) => {
  const mail = await imapTlsServer(t);
  const proxy = await socksProxy(t, { upstreamPort: mail.port, requireLogin: true });
  const registry = registryOf(t);

  await refusal(
    registry.connect({
      pluginId: PLUGIN,
      endpoint: { host: "localhost", port: mail.port, tls: true },
      login: login("imap", "tls"),
      proxy: { type: "socks5", host: "127.0.0.1", port: proxy.port, username: "tunnel", password: "wrong" },
    }),
    "PROXY_AUTH_FAILED",
  );
  assert.deepEqual(proxy.logins, [{ user: "tunnel", password: "wrong" }]);
  assert.equal(mail.sockets(), 0, "a refused login never reaches the mail server");
});

test("a proxy that answers 407 is an auth failure, and one that refuses is a proxy failure", async (t) => {
  const mail = await imapTlsServer(t);
  const unauthorized = await httpProxy(t, { upstreamPort: mail.port, status: 407 });
  const registry = registryOf(t);
  await refusal(
    registry.connect({
      pluginId: PLUGIN,
      endpoint: { host: "localhost", port: mail.port, tls: true },
      login: login("imap", "tls"),
      proxy: { type: "http", host: "127.0.0.1", port: unauthorized.port },
    }),
    "PROXY_AUTH_FAILED",
  );

  const refused = await httpProxy(t, { upstreamPort: mail.port, status: 502 });
  await refusal(
    registry.connect({
      pluginId: PLUGIN,
      endpoint: { host: "localhost", port: mail.port, tls: true },
      login: login("imap", "tls"),
      proxy: { type: "http", host: "127.0.0.1", port: refused.port },
    }),
    "PROXY_FAILED",
  );
  assert.equal(mail.sockets(), 0);
});

test("a proxy that is not running fails the connection instead of dialling directly", async (t) => {
  const mail = await imapTlsServer(t);
  // A port nothing listens on: reserved by binding and closing one.
  const placeholder = net.createServer();
  const deadPort = await listen(placeholder);
  await new Promise((resolve) => placeholder.close(resolve));

  const registry = registryOf(t);
  await refusal(
    registry.connect({
      pluginId: PLUGIN,
      endpoint: { host: "localhost", port: mail.port, tls: true },
      login: login("imap", "tls"),
      proxy: { type: "http", host: "127.0.0.1", port: deadPort },
    }),
    "PROXY_FAILED",
  );
  assert.equal(mail.sockets(), 0, "no direct fallback: the mail server was never dialled");
  assert.deepEqual(registry.list(PLUGIN), []);
});

test("a stored proxy the host cannot read is a proxy failure, and no type is no proxy", () => {
  assert.equal(readTcpProxy({}, ["http"]), null);
  assert.equal(readTcpProxy({ proxyType: "" }, ["http"]), null);
  assert.deepEqual(readTcpProxy({ proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: "7897" }, ["socks5"]), {
    type: "socks5",
    host: "127.0.0.1",
    port: 7897,
  });
  for (const fields of [
    { proxyType: "http", proxyHost: "", proxyPort: "8080" },
    { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: "0" },
    { proxyType: "smtp", proxyHost: "127.0.0.1", proxyPort: "8080" },
    { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: "8080", proxyUsername: "only-a-name" },
  ]) {
    assert.throws(() => readTcpProxy(fields, ["http", "socks5"]), /PROXY_FAILED|could not be reached/);
  }
});