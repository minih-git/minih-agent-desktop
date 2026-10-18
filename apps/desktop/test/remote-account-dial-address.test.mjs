/**
 * Registration identity versus dial address (D666; rollout R7 package E2).
 *
 * The Router advertises a stable endpoint (`hostlinkUrl`, its CA, its
 * certificate name) and a dial address that changes whenever the overlay
 * re-allocates its No-TUN forward port. Only the first triple decides whether a
 * desktop has to enroll again: a moved port is the same Gateway, and the link
 * must follow it with the certificate it already holds — even when the account
 * key is gone (ADR decision 8).
 *
 * Everything here runs in this process: host-core is a fake status source and
 * the transport is an in-memory port that records what the service asked of it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createGatewayLinkService } = await import(
  "../electron/main/remote/gateway-link/gateway-link-service.ts"
);
const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const {
  createCertificateAuthority,
  createHostCsr,
  issueCertificateFromCsr,
  newKeyPair,
} = await import("@minih-agent/racp");

const ACCOUNT_ID = "42";
const KEY = "sk_placeholder_account_key";
const ADVERTISED = "wss://gateway.example.com/hostlink";
const DIAL_A = "wss://127.0.0.1:41234/hostlink";
const DIAL_B = "wss://127.0.0.1:41999/hostlink";

function caPem(seed) {
  // Trailing-free and the same length for every seed: the fingerprint must not
  // be a length, and the reader trims, so the constants compare verbatim.
  return `-----BEGIN CERTIFICATE-----\n${seed.repeat(64)}\n-----END CERTIFICATE-----`;
}

const CA_A = caPem("A");
const CA_B = caPem("B");
assert.equal(CA_A.length, CA_B.length);

function fakeEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8"),
  };
}

/** The `easytier.status` answer host-core produces for account mode. */
function easyTierStatus(remoteGateway) {
  return { enabled: true, effectiveMode: "no_tun", remoteGateway };
}

function advertised(overrides = {}) {
  return {
    available: true,
    hostlinkUrl: ADVERTISED,
    publicOrigin: "https://gateway.example.com",
    caPem: CA_A,
    dialUrl: DIAL_A,
    tlsServerName: "gateway.example.com",
    localForwardPort: 41234,
    unavailableReason: "",
    ...overrides,
  };
}

/** A host-core whose advertised endpoint and dial address tests can move. */
function fakeHost(state) {
  return {
    state,
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      switch (method) {
        case "easytier.status":
          return easyTierStatus(this.state.remoteGateway);
        case "providers.list":
          return { providers: this.state.providers ?? [] };
        case "providers.getSecret":
          return { value: KEY };
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
  };
}

async function routerRow() {
  return { id: "router", vendorKey: "minih-router", hasSecret: true, enabled: true };
}

/** An account-bound Host certificate, so the device directory can be built. */
async function accountCertificate(ca) {
  const keys = newKeyPair();
  const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_desktop" });
  const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client", accountId: ACCOUNT_ID });
  return { certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem };
}

/**
 * A transport that records each `start` and hands back the `resolveDialUrl` resolver
 * so a test can ask it what it would dial right now.
 */
function recordingPort(certificate, options = {}) {
  const enrollments = [];
  const starts = [];
  return {
    enrollments,
    starts,
    async enroll(input) {
      enrollments.push(input);
      if (options.failEnroll) throw options.failEnroll;
      return {
        hostId: input.hostId,
        // What the real transport does: the credential names the Gateway, never
        // the forward port that happened to be reachable during enrollment.
        gatewayUrl: input.hostlinkUrl ?? input.gatewayUrl,
        ...(input.hostlinkUrl ? { hostlinkUrl: input.hostlinkUrl } : {}),
        gatewayCaPem: input.gatewayCaPem,
        certificatePem: certificate.certificatePem,
        privateKeyPem: certificate.privateKeyPem,
        expiresAt: "2030-01-01T00:00:00.000Z",
        ...(input.tlsServerName ? { tlsServerName: input.tlsServerName } : {}),
      };
    },
    start(startOptions) {
      starts.push(startOptions);
      return {
        status: () => ({ state: "connected", since: new Date().toISOString() }),
        stop: async () => undefined,
      };
    },
  };
}

async function withService(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-dial-"));
  try {
    const ca = await createCertificateAuthority({ commonName: "gateway.example.com" });
    const certificate = await accountCertificate(ca);
    const host = fakeHost({
      remoteGateway: advertised(),
      providers: [await routerRow()],
    });
    const store = createGatewayCredentialStore({ dataDir, encryption: fakeEncryption(), log: () => undefined });
    await store.open();
    const port = recordingPort(certificate);
    const service = createGatewayLinkService({
      port,
      store,
      dataDir,
      agentHost: () => ({}),
      getHost: () => host,
      serverVersion: "0.0.0-test",
      log: () => undefined,
      strictDevices: false,
    });
    try {
      await run({ service, port, host, store });
    } finally {
      await service.dispose();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** One disabled→enabled cycle, which is what a restart and a toggle both do. */
async function restart(service) {
  await service.setEnabled(false);
  await service.setEnabled(true);
}

test("a moved forward port neither re-enrolls nor strands the link", async () => {
  await withService(async ({ service, port, host, store }) => {
    await service.initialize({ enabled: true });
    assert.equal(port.enrollments.length, 1);
    assert.equal(port.enrollments[0].gatewayUrl, DIAL_A);
    assert.equal(store.credentials().gatewayUrl, ADVERTISED);

    // The overlay restarted: same Gateway, new loopback port.
    host.state.remoteGateway = advertised({ dialUrl: DIAL_B, localForwardPort: 41999 });
    await restart(service);

    assert.equal(port.enrollments.length, 1, "a new port is not a new Gateway");
    const last = port.starts.at(-1);
    assert.ok(last.resolveDialUrl, "account mode dials what host-core reports now");
    assert.equal(await last.resolveDialUrl(), DIAL_B);
    // The stored credential still names the advertised endpoint, never the port.
    assert.equal(store.credentials().gatewayUrl, ADVERTISED);
    assert.equal(store.credentials().tlsServerName, "gateway.example.com");
  });
});

test("a disabled key keeps the existing certificate when the port moved", async () => {
  await withService(async ({ service, port, host, store }) => {
    await service.initialize({ enabled: true });
    assert.equal(port.enrollments.length, 1);

    // The user disabled or deleted the Router key and the overlay restarted:
    // a new enrollment is impossible, the issued certificate is still valid.
    host.state.providers = [{ ...(await routerRow()), enabled: false }];
    host.state.remoteGateway = advertised({ dialUrl: DIAL_B, localForwardPort: 41999 });
    await restart(service);

    assert.equal(port.enrollments.length, 1, "no key, no enrollment");
    const last = port.starts.at(-1);
    assert.ok(last, "the link still starts");
    assert.equal(last.credentials.certificatePem, store.credentials().certificatePem);
    assert.equal(await last.resolveDialUrl(), DIAL_B, "and follows the new port");
    // The key only gates a *new* enrollment: the existing certificate is what
    // keeps this desktop reachable, so account mode stays reported as active
    // (ADR decision 8). A missing key while an enrollment is actually required
    // is reported instead, which the "missing key" test covers.
    assert.equal(service.status().accountMode?.available, true);
    assert.equal(service.status().state, "connected");
  });
});

test("the dial address is resolved again on every attempt, not cached", async () => {
  await withService(async ({ service, port, host }) => {
    await service.initialize({ enabled: true });
    const dial = port.starts.at(-1).resolveDialUrl;
    assert.equal(await dial(), DIAL_A);
    // Nothing about the address is memoized: the next attempt asks again.
    host.state.remoteGateway = advertised({ dialUrl: DIAL_B, localForwardPort: 41999 });
    assert.equal(await dial(), DIAL_B);
    // A status answer without a usable endpoint is a transport error, so the
    // link backs off instead of dialing the port from the last overlay.
    host.state.remoteGateway = advertised({ available: false, unavailableReason: "the forward is not installed" });
    await assert.rejects(() => dial(), /forward is not installed/);
  });
});

test("a new advertised endpoint or CA enrolls again", async () => {
  await withService(async ({ service, port, host }) => {
    await service.initialize({ enabled: true });
    assert.equal(port.enrollments.length, 1);

    // The Gateway really changed: another endpoint.
    host.state.remoteGateway = advertised({ hostlinkUrl: "wss://other.example.com/hostlink" });
    await restart(service);
    assert.equal(port.enrollments.length, 2);
    assert.equal(port.enrollments[1].hostlinkUrl, "wss://other.example.com/hostlink");

    // …and another pinned CA, of exactly the same size.
    host.state.remoteGateway = advertised({
      hostlinkUrl: "wss://other.example.com/hostlink",
      caPem: CA_B,
    });
    await restart(service);
    assert.equal(port.enrollments.length, 3);
    assert.equal(port.enrollments[2].gatewayCaPem, CA_B);
  });
});

test("a failed Gateway does not mask a different one of the same size", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-ca-"));
  try {
    const ca = await createCertificateAuthority({ commonName: "gateway.example.com" });
    const certificate = await accountCertificate(ca);
    const host = fakeHost({ remoteGateway: advertised({ caPem: CA_A }), providers: [await routerRow()] });
    const store = createGatewayCredentialStore({ dataDir, encryption: fakeEncryption(), log: () => undefined });
    await store.open();
    const failure = Object.assign(new Error("the Gateway refused the enrollment"), { errorCode: "ACCESS_KEY_INVALID" });
    const port = recordingPort(certificate, { failEnroll: failure });
    const service = createGatewayLinkService({
      port,
      store,
      dataDir,
      agentHost: () => ({}),
      getHost: () => host,
      serverVersion: "0.0.0-test",
      log: () => undefined,
      strictDevices: false,
    });
    try {
      await service.initialize({ enabled: true });
      assert.equal(port.enrollments.length, 1);
      // The same identity is not retried in a loop…
      await restart(service);
      assert.equal(port.enrollments.length, 1);
      // …but a different Gateway with an identically sized CA is a new identity.
      host.state.remoteGateway = advertised({ caPem: CA_B });
      await restart(service);
      assert.equal(port.enrollments.length, 2);
      assert.equal(port.enrollments[1].gatewayCaPem, CA_B);
    } finally {
      await service.dispose();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
