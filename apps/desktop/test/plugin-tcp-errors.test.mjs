/**
 * The failure codes one mail connection reports.
 *
 * A plugin shows one message per case, so these names are a contract: a
 * certificate problem must not arrive as a broken handshake, and a deadline must
 * arrive as a connection that could not be made. The two handshake cases are
 * checked against a real local TLS server rather than a fake rejection.
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import tls from "node:tls";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { connectionMessage, tcpFailureCode, tlsFailureCode } = await import(
  "../electron/main/plugin-tcp-errors.ts"
);
const { upgradeToTls } = await import("../electron/main/plugin-tcp-starttls.ts");

// The same test-only leaf the other TCP suites use; its issuer is a CA this
// file does not trust unless it says so.
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** One raw connection to a local TLS server, then the upgrade under test. */
async function upgradeAgainst(t, server, options) {
  const port = await listen(server);
  t.after(() => server.close());
  const socket = net.connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.destroy());
  return upgradeToTls(socket, { host: "localhost", ...options });
}

test("a transport deadline and an unusable value reach the plugin as its own codes", () => {
  assert.equal(tcpFailureCode("TIMEOUT"), "CONNECT_FAILED");
  assert.equal(tcpFailureCode("CREDENTIAL_UNSUPPORTED"), "CREDENTIAL_REJECTED");
  assert.equal(tcpFailureCode("CREDENTIAL_INVALID"), "CREDENTIAL_REJECTED");
  // Everything else keeps the code it was decided with.
  assert.equal(tcpFailureCode("PERMISSION_DENIED"), "PERMISSION_DENIED");
  assert.equal(tcpFailureCode("CONNECT_FAILED"), "CONNECT_FAILED");
  assert.equal(tcpFailureCode("TLS_CERTIFICATE"), "TLS_CERTIFICATE");
});

test("a certificate problem is not reported as a broken handshake", () => {
  assert.equal(tlsFailureCode({ code: "CERT_HAS_EXPIRED" }), "TLS_CERTIFICATE");
  assert.equal(tlsFailureCode({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "TLS_CERTIFICATE");
  assert.equal(tlsFailureCode({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "TLS_CERTIFICATE");
  assert.equal(tlsFailureCode({ code: "ECONNRESET" }), "TLS_FAILED");
  assert.equal(tlsFailureCode(undefined), "TLS_FAILED");
  assert.match(connectionMessage("TLS_CERTIFICATE"), /certificate/);
  assert.match(connectionMessage("CONNECT_FAILED"), /connection/);
});

test("the five connection codes are the whole surface a plugin maps", () => {
  // A plugin's message table switches on exactly these names; a sixth code would
  // fall through to a generic message, so the set stays closed.
  const codes = [
    "CONNECT_FAILED",
    "TLS_CERTIFICATE",
    "TLS_FAILED",
    "STARTTLS_UNAVAILABLE",
    "CREDENTIAL_REJECTED",
  ];
  for (const code of codes) assert.equal(tcpFailureCode(code), code);
  assert.match(connectionMessage("STARTTLS_UNAVAILABLE"), /STARTTLS/);
  assert.match(connectionMessage("CREDENTIAL_REJECTED"), /credential/);
  assert.equal(new Set(codes.map(connectionMessage)).size, codes.length, "each code says its own thing");
});

test("a certificate the host does not trust is TLS_CERTIFICATE", async (t) => {
  const server = tls.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (socket) => {
    socket.on("error", () => {});
  });
  // The leaf is presented as its own anchor: nothing in the chain is trusted.
  await assert.rejects(
    upgradeAgainst(t, server, { ca: LOCALHOST_CERT }),
    (error) => error.code === "TLS_CERTIFICATE",
  );
});

test("a handshake that breaks for any other reason is TLS_FAILED", async (t) => {
  // A plain socket that hangs up instead of speaking TLS: the handshake ends
  // before any certificate exists, so this is not a certificate failure.
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.destroy();
  });
  await assert.rejects(
    upgradeAgainst(t, server, { ca: LOCALHOST_CERT }),
    (error) => error.code === "TLS_FAILED",
  );
});