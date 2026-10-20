/**
 * Account mode on the desktop (ADR `remote-control-router-account-binding`,
 * D666; rollout R7 package E2).
 *
 * Everything here is the main-process half: the decision to enroll with the
 * Router key, the confirmation dialog the desktop shows for a phone, the strict
 * mode that stops accepting sibling grants, and the revocation queue that
 * survives an offline link. The link transport itself is stubbed, so nothing
 * leaves the machine.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { readAccountGateway, resolveAccountAccessKey, accountEnrollmentCurrent, desktopEnrollmentLabel } =
  await import("../electron/main/remote/gateway-link/account-mode.ts");
const { createDesktopDevices, deviceRevocationQueuePath } = await import(
  "../electron/main/remote/gateway-link/account-devices.ts"
);
const { createGatewayLinkService } = await import(
  "../electron/main/remote/gateway-link/gateway-link-service.ts"
);
const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const { MemoryCredentialStore } = await import("@minih-agent/racp");
const { RACP_HOST_CAPABILITIES } = await import("@minih-agent/shared");
const {
  createCertificateAuthority,
  createServerCertificate,
  createHostCsr,
  issueCertificateFromCsr,
  newKeyPair,
} = await import("@minih-agent/racp");

const ACCOUNT_ID = "42";
const PLACEHOLDER_KEY = "sk_placeholder_account_key";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

function fakeEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8"),
  };
}

/** The `easytier.status` answer host-core would produce for account mode. */
function easyTierStatus(remoteGateway) {
  return {
    enabled: true,
    configuredMode: "no_tun",
    effectiveMode: "no_tun",
    state: "connected",
    virtualIpv4: null,
    hostname: null,
    networkName: "minih-router",
    peers: [],
    bootstrapPeers: [],
    peerCount: 0,
    connectedPeers: [],
    routerLanUrl: "http://11.12.0.1:3001/v1",
    localForwardPort: 41000,
    localForwardUrl: "http://127.0.0.1:41000/v1",
    usingLan: true,
    activeRouterBaseUrl: "http://127.0.0.1:41000/v1",
    fallbackRouterBaseUrl: "https://router.example.com/v1",
    routerLanReachable: true,
    lastError: null,
    updatedAtMs: Date.now(),
    dhcp: true,
    staticIpv4: "",
    bootstrapSource: "gateway",
    bootstrapNetworkName: "minih-router",
    bootstrapError: "",
    ...(remoteGateway === undefined ? {} : { remoteGateway }),
  };
}

function availableGateway(overrides = {}) {
  return {
    available: true,
    hostlinkUrl: "wss://gateway.example.com/hostlink",
    publicOrigin: "https://gateway.example.com",
    caPem: CA_PEM,
    dialUrl: "wss://127.0.0.1:41234/hostlink",
    tlsServerName: "gateway.example.com",
    localForwardPort: 41234,
    unavailableReason: "",
    ...overrides,
  };
}

/** A host whose Router row is configurable per test. */
function fakeHost(options) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "easytier.status":
          return easyTierStatus(options.remoteGateway);
        case "providers.list":
          return { providers: options.providers ?? [] };
        case "providers.getSecret":
          return params?.id === options.secretFor ? { value: options.secretValue } : {};
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
  };
}

// --- Account mode discovery ---------------------------------------------------

test("an unavailable account mode keeps the self-hosted flow", async () => {
  const host = fakeHost({
    remoteGateway: availableGateway({ available: false, unavailableReason: "the forward is not installed" }),
  });
  const state = await readAccountGateway(host);
  assert.equal(state.supported, true);
  assert.equal(state.mode.available, false);
  assert.match(state.mode.reason, /forward/);
  // No endpoint: nothing may be dialled.
  assert.equal(state.gateway, undefined);
});

test("a host that does not report account mode is not a failure", async () => {
  const state = await readAccountGateway(fakeHost({ remoteGateway: undefined }));
  assert.equal(state.supported, false);
  assert.equal(state.mode.available, false);
});

test("an available account mode yields the dialled address and the service name", async () => {
  const state = await readAccountGateway(fakeHost({ remoteGateway: availableGateway() }));
  assert.equal(state.mode.available, true);
  assert.equal(state.mode.url, "wss://gateway.example.com/hostlink");
  assert.deepEqual(state.gateway, {
    dialUrl: "wss://127.0.0.1:41234/hostlink",
    // Edges are trimmed so the stored CA compares equal to the advertised one.
    caPem: CA_PEM.trim(),
    // Security §5.1: the identity is the advertised name, never loopback.
    tlsServerName: "gateway.example.com",
    hostlinkUrl: "wss://gateway.example.com/hostlink",
    publicOrigin: "https://gateway.example.com",
  });
});

test("an incomplete advertisement is unavailable, not half-used", async () => {
  const state = await readAccountGateway(
    fakeHost({ remoteGateway: availableGateway({ tlsServerName: "" }) }),
  );
  assert.equal(state.mode.available, false);
  assert.match(state.mode.reason, /incomplete/);
  assert.equal(state.gateway, undefined);
});

// --- AccessKey resolution -----------------------------------------------------

test("the first enabled minih-router row with a token provides the key", async () => {
  const host = fakeHost({
    providers: [
      { id: "other", vendorKey: "openai", hasSecret: true, enabled: true },
      { id: "router", vendorKey: "minih-router", hasSecret: true, enabled: true },
    ],
    secretFor: "router",
    secretValue: `  ${PLACEHOLDER_KEY}  `,
  });
  const resolved = await resolveAccountAccessKey(host);
  assert.deepEqual(resolved, { accessKey: PLACEHOLDER_KEY, providerId: "router" });
});

test("a disabled router row, or one without a token, is not used", async () => {
  const disabled = fakeHost({
    providers: [{ id: "router", vendorKey: "minih-router", hasSecret: true, enabled: false }],
    secretFor: "router",
    secretValue: PLACEHOLDER_KEY,
  });
  assert.equal(await resolveAccountAccessKey(disabled), null);

  const noSecret = fakeHost({
    providers: [{ id: "router", vendorKey: "minih-router", hasSecret: false, enabled: true }],
    secretFor: "router",
    secretValue: PLACEHOLDER_KEY,
  });
  assert.equal(await resolveAccountAccessKey(noSecret), null);
  // Nothing was asked for: a row without a secret cannot authenticate.
  assert.equal(noSecret.calls.some((call) => call.method === "providers.getSecret"), false);
});

// --- Enrollment decisions -----------------------------------------------------


test("account enrollment follows the advertised endpoint, not the dial address", () => {
  const credentials = {
    hostId: "host_1",
    gatewayUrl: "wss://gateway.example.com/hostlink",
    hostlinkUrl: "wss://gateway.example.com/hostlink",
    gatewayCaPem: CA_PEM,
    certificatePem: "cert",
    privateKeyPem: "key",
    expiresAt: "2030-01-01T00:00:00.000Z",
    tlsServerName: "gateway.example.com",
  };
  const gateway = {
    dialUrl: "wss://127.0.0.1:41234/hostlink",
    caPem: CA_PEM,
    tlsServerName: "gateway.example.com",
    hostlinkUrl: "wss://gateway.example.com/hostlink",
    publicOrigin: "https://gateway.example.com",
  };
  assert.equal(accountEnrollmentCurrent(credentials, gateway), true);
  // A forwarded port that moved with a restarted overlay is the same Gateway.
  assert.equal(
    accountEnrollmentCurrent(credentials, { ...gateway, dialUrl: "wss://127.0.0.1:41999/hostlink" }),
    true,
  );
  // The advertised endpoint moving is a different Gateway.
  assert.equal(
    accountEnrollmentCurrent(credentials, { ...gateway, hostlinkUrl: "wss://other.example.com/hostlink" }),
    false,
  );
  // A different CA is a different Gateway even when it is exactly as large.
  const otherCa = CA_PEM.replace("MIIB", "MIIC");
  assert.equal(otherCa.length, CA_PEM.length);
  assert.equal(accountEnrollmentCurrent(credentials, { ...gateway, caPem: otherCa }), false);
  // The certificate service name is part of the identity.
  assert.equal(
    accountEnrollmentCurrent(credentials, { ...gateway, tlsServerName: "renamed.example.com" }),
    false,
  );
  // A self-hosted enrollment carries no service name, so it is not account mode.
  assert.equal(
    accountEnrollmentCurrent({ ...credentials, tlsServerName: undefined }, gateway),
    false,
  );
  // An account credential written before the identity was stored cannot prove
  // which Gateway it belongs to; it is replaced once.
  assert.equal(accountEnrollmentCurrent({ ...credentials, hostlinkUrl: undefined }, gateway), false);
});

/** A `device.request` the directory can be handed while minting a grant. */
function request(overrides = {}) {
  return {
    requestId: "req_1",
    accountId: ACCOUNT_ID,
    deviceLabel: "iPhone",
    client: "ios",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

// --- Strict mode, capabilities, and the revocation queue ----------------------

async function hostIdentity(accountId = ACCOUNT_ID) {
  const ca = await createCertificateAuthority({ commonName: "gateway.example.com" });
  const keys = newKeyPair();
  const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_desktop" });
  const issued = await issueCertificateFromCsr({
    ca,
    csrPem: csr,
    purpose: "client",
    accountId,
  });
  return {
    ca,
    hostId: "host_desktop",
    certificatePem: issued.certificatePem,
    privateKeyPem: keys.privateKeyPem,
  };
}

test("strict mode stops advertising sibling grants and cannot be bypassed", async () => {
  const identity = await hostIdentity();
  const store = new MemoryCredentialStore();
  const relaxed = createDesktopDevices({
    dataDir: tmpdir(),
    hostId: identity.hostId,
    signer: { certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem },
    gatewayCaPem: identity.ca.certificatePem,
    store,
    log: () => undefined,
    emitRequest: () => undefined,
    strictDevices: false,
  });
  assert.ok(relaxed);
  assert.deepEqual(relaxed.capabilities.sort(), [
    RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant,
    RACP_HOST_CAPABILITIES.deviceConfirm,
  ].sort());
  assert.equal(relaxed.directory.isStrict, false);

  const strict = createDesktopDevices({
    dataDir: tmpdir(),
    hostId: identity.hostId,
    signer: { certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem },
    gatewayCaPem: identity.ca.certificatePem,
    store,
    log: () => undefined,
    emitRequest: () => undefined,
    strictDevices: true,
  });
  assert.ok(strict);
  // The capability list is the announcement: a strict Host never says it
  // accepts a sibling grant.
  assert.deepEqual(strict.capabilities, [RACP_HOST_CAPABILITIES.deviceConfirm]);
  assert.equal(strict.directory.isStrict, true);
});

test("without a confirmer the desktop advertises nothing", async () => {
  const identity = await hostIdentity();
  const devices = createDesktopDevices({
    dataDir: tmpdir(),
    hostId: identity.hostId,
    signer: { certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem },
    gatewayCaPem: identity.ca.certificatePem,
    store: new MemoryCredentialStore(),
    log: () => undefined,
    strictDevices: false,
  });
  // No emitter means no window: the directory announces nothing, so the Gateway
  // reports this Host as unable to confirm (security gate 33).
  assert.ok(devices);
  assert.deepEqual(devices.confirmer.pending(), []);
  assert.equal(await devices.confirmer.confirm(request({ requestId: "req_x" })), "denied");
});

test("a self-hosted certificate yields no device directory", async () => {
  const ca = await createCertificateAuthority({ commonName: "gateway.example.com" });
  const keys = newKeyPair();
  const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_self" });
  // No account binding: a sibling Host would refuse anything it signed.
  const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client" });
  const devices = createDesktopDevices({
    dataDir: tmpdir(),
    hostId: "host_self",
    signer: { certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem },
    gatewayCaPem: ca.certificatePem,
    store: new MemoryCredentialStore(),
    log: () => undefined,
    emitRequest: () => undefined,
    strictDevices: false,
  });
  assert.equal(devices, null);
});

test("the revocation queue is per-desktop, owner-only, and survives a restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-devices-"));
  try {
    const identity = await hostIdentity();
    const devices = createDesktopDevices({
      dataDir,
      hostId: identity.hostId,
      signer: { certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem },
      gatewayCaPem: identity.ca.certificatePem,
      store: new MemoryCredentialStore(),
      log: () => undefined,
      emitRequest: () => undefined,
      strictDevices: false,
    });
    assert.ok(devices);
    // A device the directory minted is what a revocation can be signed for.
    const grant = await devices.directory.approve(request({ requestId: "req_mint" }));
    const frame = await devices.directory.revoke(grant.grant.deviceId);
    assert.ok(frame);
    assert.equal(await devices.revocations.enqueue(frame), 0);
    const path = deviceRevocationQueuePath(dataDir);
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(stored.entries.length, 1);
    // The queue holds a signed frame only: no token ever reaches the file.
    assert.equal(JSON.stringify(stored).includes(grant.deviceToken), false);
    const reopened = (await import("@minih-agent/racp")).FileDeviceRevocationQueue;
    assert.equal((await new reopened(path).pending()).length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// --- The service: key never leaves main --------------------------------------

test("the Router key never appears in a status payload or a log line", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-service-"));
  const logged = [];
  try {
    const identity = await hostIdentity();
    const store = createGatewayCredentialStore({
      dataDir,
      encryption: fakeEncryption(),
      log: () => undefined,
    });
    await store.open();
    const enrolled = [];
    const port = {
      async enroll(input) {
        enrolled.push(input);
        const keys = newKeyPair();
        const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_desktop" });
        const issued = await issueCertificateFromCsr({
          ca: identity.ca,
          csrPem: csr,
          purpose: "client",
          accountId: ACCOUNT_ID,
        });
        return {
          hostId: "host_desktop",
          // The real contract: the credential names the Gateway, never the
          // forward port it enrolled through.
          gatewayUrl: input.hostlinkUrl ?? input.gatewayUrl,
          ...(input.hostlinkUrl ? { hostlinkUrl: input.hostlinkUrl } : {}),
          gatewayCaPem: input.gatewayCaPem,
          certificatePem: issued.certificatePem,
          privateKeyPem: keys.privateKeyPem,
          expiresAt: issued.expiresAt,
          ...(input.tlsServerName ? { tlsServerName: input.tlsServerName } : {}),
        };
      },
      start() {
        return {
          status: () => ({ state: "connecting", since: new Date().toISOString() }),
          stop: async () => undefined,
        };
      },
    };
    const host = fakeHost({
      remoteGateway: availableGateway(),
      providers: [{ id: "router", vendorKey: "minih-router", hasSecret: true, enabled: true }],
      secretFor: "router",
      secretValue: PLACEHOLDER_KEY,
    });
    const service = createGatewayLinkService({
      port,
      store,
      dataDir,
      agentHost: () => ({}) ,
      getHost: () => host,
      serverVersion: "0.0.0-test",
      log: (level, message, data) => logged.push(`${message} ${JSON.stringify(data ?? {})}`),
      strictDevices: false,
    });
    await service.initialize({ enabled: true });

    // One enrollment, with the account credential and the advertised identity.
    assert.equal(enrolled.length, 1);
    assert.equal(enrolled[0].accessKey, PLACEHOLDER_KEY);
    // Enrollment posts to the address that is reachable now…
    assert.equal(enrolled[0].gatewayUrl, "wss://127.0.0.1:41234/hostlink");
    // …and stores the advertised endpoint as the registration identity.
    assert.equal(enrolled[0].hostlinkUrl, "wss://gateway.example.com/hostlink");
    assert.equal(enrolled[0].tlsServerName, "gateway.example.com");
    assert.equal(store.enrolled(), true);
    assert.equal(store.credentials().gatewayUrl, "wss://gateway.example.com/hostlink");
    assert.equal(store.credentials().hostlinkUrl, "wss://gateway.example.com/hostlink");

    const status = service.status();
    assert.equal(status.accountMode?.available, true);
    assert.equal(status.strictDevices, false);
    // The key is nowhere in the projection main pushes to the renderer.
    assert.equal(JSON.stringify(status).includes(PLACEHOLDER_KEY), false);
    assert.equal(logged.join("\n").includes(PLACEHOLDER_KEY), false);

    // The switch turning off drops the account-mode status with it.
    await service.setEnabled(false);
    assert.equal(service.status().state, "disabled");
    await service.dispose();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the service reports a missing key instead of silently doing nothing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-nokey-"));
  try {
    const store = createGatewayCredentialStore({
      dataDir,
      encryption: fakeEncryption(),
      log: () => undefined,
    });
    await store.open();
    const port = {
      async enroll() {
        throw new Error("must not enroll without a key");
      },
      start() {
        throw new Error("must not start without credentials");
      },
    };
    const service = createGatewayLinkService({
      port,
      store,
      dataDir,
      agentHost: () => ({}),
      getHost: () => fakeHost({ remoteGateway: availableGateway(), providers: [] }),
      serverVersion: "0.0.0-test",
      log: () => undefined,
    });
    await service.initialize({ enabled: true });
    const status = service.status();
    // The Router offers account mode, but this desktop has no key: the page
    // says so and keeps the registration-code form.
    assert.equal(status.accountMode?.available, false);
    assert.match(status.accountMode?.reason ?? "", /AccessKey/);
    assert.equal(status.state, "not-enrolled");
    await service.dispose();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// --- The computer's own name ---------------------------------------------------

test("the enrollment carries a human-readable computer name", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-label-"));
  try {
    const identity = await hostIdentity();
    const store = createGatewayCredentialStore({
      dataDir,
      encryption: fakeEncryption(),
      log: () => undefined,
    });
    await store.open();
    const enrolled = [];
    const port = {
      async enroll(input) {
        enrolled.push(input);
        const keys = newKeyPair();
        const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_desktop" });
        const issued = await issueCertificateFromCsr({
          ca: identity.ca,
          csrPem: csr,
          purpose: "client",
          accountId: ACCOUNT_ID,
        });
        return {
          hostId: "host_desktop",
          gatewayUrl: input.hostlinkUrl ?? input.gatewayUrl,
          gatewayCaPem: input.gatewayCaPem,
          certificatePem: issued.certificatePem,
          privateKeyPem: keys.privateKeyPem,
          expiresAt: issued.expiresAt,
          ...(input.tlsServerName ? { tlsServerName: input.tlsServerName } : {}),
        };
      },
      start() {
        return {
          status: () => ({ state: "connected", since: new Date().toISOString() }),
          stop: async () => undefined,
        };
      },
    };
    const service = createGatewayLinkService({
      port,
      store,
      dataDir,
      agentHost: () => ({}),
      getHost: () =>
        fakeHost({
          remoteGateway: availableGateway(),
          providers: [{ id: "router", vendorKey: "minih-router", hasSecret: true, enabled: true }],
          secretFor: "router",
          secretValue: PLACEHOLDER_KEY,
        }),
      serverVersion: "0.0.0-test",
      log: () => undefined,
    });
    await service.initialize({ enabled: true });
    assert.equal(enrolled.length, 1);
    // The phone shows this name instead of `host_<uuid>`: the Gateway falls back
    // to the id whenever an account-mode enrollment carries no label.
    assert.equal(typeof enrolled[0].label, "string", "the enrollment must carry a computer name");
    assert.ok(enrolled[0].label.length > 0);
    assert.ok(enrolled[0].label.length <= 128);
    assert.equal(enrolled[0].label.includes(PLACEHOLDER_KEY), false);
    assert.equal(enrolled[0].label.endsWith(".local"), false);
    await service.dispose();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the computer name is trimmed, bounded, and omitted when unusable", () => {
  // A real hostname, without the mDNS suffix a phone cannot do anything with.
  assert.equal(desktopEnrollmentLabel(() => "Studio-Mac.local"), "Studio-Mac");
  assert.equal(desktopEnrollmentLabel(() => "  Studio-Mac.local  "), "Studio-Mac");
  // An empty or whitespace-only name leaves the label out, so the Gateway keeps
  // its own fallback rather than storing a blank.
  assert.equal(desktopEnrollmentLabel(() => ""), undefined);
  assert.equal(desktopEnrollmentLabel(() => "   "), undefined);
  assert.equal(desktopEnrollmentLabel(() => undefined), undefined);
  // A name the Gateway would reject is cut, not dropped: the desktop keeps a
  // readable name within `HOST_LABEL_MAX_LENGTH`.
  assert.equal(desktopEnrollmentLabel(() => "n".repeat(200)).length, 128);
  assert.equal(desktopEnrollmentLabel(() => `${"n".repeat(200)}.local`).length, 128);
  // The hostname the test machine actually reports is usable.
  const own = desktopEnrollmentLabel(() => os.hostname());
  assert.ok(own === undefined || (own.length > 0 && own.length <= 128));
});
