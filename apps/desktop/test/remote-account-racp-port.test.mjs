/**
 * The seam between the desktop Gateway service and the RACP transport
 * (rollout R7 package E2, D666).
 *
 * The service hands the production port a per-attempt dial resolver so that a
 * No-TUN forward port host-core re-allocates is followed without re-enrolling
 * (provider-config §3). The service tests use an in-memory port and the racp
 * tests call `startHostLink` directly, so neither would notice if the two sides
 * named the option differently and the resolver were silently dropped: the link
 * would then dial the stored, advertised endpoint, which the Host link never
 * listens on in No-TUN mode. This test drives the real `racpGatewayLinkPort` and
 * proves the resolved address is the one actually dialled.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { racpGatewayLinkPort } = await import("../electron/main/remote/gateway-link/racp-gateway-link-port.ts");
const { createCertificateAuthority, createHostCsr, issueCertificateFromCsr, newKeyPair } = await import(
  "@minih-agent/racp"
);

test("the production port dials the address the resolver returns, not the stored endpoint", async () => {
  // A plain TCP listener stands in for the loopback forward: the TLS handshake
  // will fail against it, but a connection arriving here proves where the link
  // dialled.
  const forward = createServer((socket) => socket.destroy());
  forward.listen(0, "127.0.0.1");
  await once(forward, "listening");
  const address = forward.address();
  assert.ok(address && typeof address === "object");
  const dialled = once(forward, "connection");

  // Real key material: TLS rejects malformed PEM before it ever opens a socket,
  // which would make this test pass or fail for the wrong reason.
  const ca = await createCertificateAuthority({ commonName: "gateway.example.com" });
  const keys = newKeyPair();
  const csrPem = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_seam" });
  const issued = await issueCertificateFromCsr({ ca, csrPem, purpose: "client", accountId: "42" });

  let resolved = 0;
  const handle = racpGatewayLinkPort.start({
    credentials: {
      hostId: "host_seam",
      // The advertised endpoint is stored as the identity; it must never be
      // dialled when a resolver is present.
      gatewayUrl: "wss://gateway.example.com/hostlink",
      hostlinkUrl: "wss://gateway.example.com/hostlink",
      gatewayCaPem: ca.certificatePem,
      certificatePem: issued.certificatePem,
      privateKeyPem: keys.privateKeyPem,
      expiresAt: "2030-01-01T00:00:00.000Z",
      tlsServerName: "gateway.example.com",
    },
    server: /** @type {never} */ ({}),
    authenticator: /** @type {never} */ ({}),
    log: () => undefined,
    backoff: { baseDelayMs: 50, maxDelayMs: 50 },
    resolveDialUrl: () => {
      resolved += 1;
      return `wss://127.0.0.1:${address.port}/hostlink`;
    },
  });
  try {
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("the resolved address was never dialled")), 5_000);
      timer.unref();
    });
    await Promise.race([dialled, timeout]);
    assert.ok(resolved >= 1, "the resolver was consulted before dialling");
  } finally {
    await handle.stop();
    forward.close();
  }
});
