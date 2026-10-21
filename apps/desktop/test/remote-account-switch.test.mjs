/**
 * Account mode before the user ever turns the switch on (D666; rollout R7).
 *
 * A fresh desktop has no credentials, and the remote-control switch cannot be
 * turned on without one — so if account mode were only read while the link
 * starts, a desktop that had just installed Minih Router could never reach the
 * account at all: the switch waits for an enrollment, the enrollment waits for
 * the switch. These tests pin the fix: the availability of account mode is read
 * without enrolling anything, and turning the switch on is what enrolls.
 *
 * Nothing here dials: the transport is an in-memory port that only records what
 * it was asked to do.
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
const { createGatewayLinkBootstrap } = await import("../electron/main/bootstrap/gateway-link.ts");
const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const { remoteGatewaySwitchDisabled, accountModeVisible } = await import(
  "../src/lib/remote-gateway-state.ts"
);
const {
  createCertificateAuthority,
  createHostCsr,
  issueCertificateFromCsr,
  newKeyPair,
} = await import("@minih-agent/racp");

const ACCOUNT_ID = "42";
const ROUTER_KEY = "sk_placeholder_account_key";
const HOSTLINK_URL = "wss://gateway.example.com/hostlink";
const DIAL_URL = "wss://127.0.0.1:41234/hostlink";
const CA_PEM = `-----BEGIN CERTIFICATE-----\n${"A".repeat(64)}\n-----END CERTIFICATE-----`;

function fakeEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (buffer) => buffer.toString("utf8"),
  };
}

/** The `easytier.status` answer host-core produces when the Router offers it. */
function easyTierStatus(remoteGateway) {
  return { enabled: true, effectiveMode: "no_tun", remoteGateway };
}

function advertised(overrides = {}) {
  return {
    available: true,
    hostlinkUrl: HOSTLINK_URL,
    publicOrigin: "https://gateway.example.com",
    caPem: CA_PEM,
    dialUrl: DIAL_URL,
    tlsServerName: "gateway.example.com",
    localForwardPort: 41234,
    unavailableReason: "",
    ...overrides,
  };
}

const ROUTER_ROW = { id: "router", vendorKey: "minih-router", hasSecret: true, enabled: true };

/** A host-core whose account-mode advertisement and Router rows a test can set. */
function fakeHost(state = {}) {
  const calls = [];
  return {
    state: { remoteGateway: advertised(), providers: [ROUTER_ROW], secret: ROUTER_KEY, ...state },
    calls,
    async call(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "easytier.status":
          return easyTierStatus(this.state.remoteGateway);
        case "providers.list":
          return { providers: this.state.providers };
        case "providers.getSecret":
          return { value: this.state.secret };
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
  };
}

/** Records enrollments and starts; never dials. */
function recordingPort(certificate) {
  const calls = { enroll: 0, start: 0 };
  return {
    calls,
    port: {
      async enroll(input) {
        calls.enroll += 1;
        return {
          hostId: input.hostId,
          gatewayUrl: input.hostlinkUrl ?? input.gatewayUrl,
          ...(input.hostlinkUrl ? { hostlinkUrl: input.hostlinkUrl } : {}),
          gatewayCaPem: input.gatewayCaPem,
          certificatePem: certificate.certificatePem,
          privateKeyPem: certificate.privateKeyPem,
          expiresAt: "2030-01-01T00:00:00.000Z",
          ...(input.tlsServerName ? { tlsServerName: input.tlsServerName } : {}),
        };
      },
      start() {
        calls.start += 1;
        return {
          status: () => ({ state: "connected", since: new Date().toISOString() }),
          stop: async () => undefined,
        };
      },
    },
  };
}

async function accountCertificate() {
  const ca = await createCertificateAuthority({ commonName: "gateway.example.com" });
  const keys = newKeyPair();
  const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId: "host_desktop" });
  const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client", accountId: ACCOUNT_ID });
  return { certificatePem: issued.certificatePem, privateKeyPem: keys.privateKeyPem };
}

/** A service that has never been enrolled and whose switch is still off. */
async function withFreshDesktop(run, state) {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-switch-"));
  try {
    const host = fakeHost(state);
    const store = createGatewayCredentialStore({ dataDir, encryption: fakeEncryption(), log: () => undefined });
    await store.open();
    const { port, calls } = recordingPort(await accountCertificate());
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
      await run({ service, calls, host, store });
    } finally {
      await service.dispose();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("a fresh desktop reads account mode with the switch off, without enrolling", async () => {
  await withFreshDesktop(async ({ service, calls, host }) => {
    await service.initialize({ enabled: false });
    const status = service.status();

    // The page can now say what account mode is and why, before anything runs.
    assert.equal(status.state, "disabled");
    assert.equal(status.enrolled, false);
    assert.equal(accountModeVisible(status), true);
    assert.equal(status.accountMode?.available, true);
    assert.equal(status.accountMode?.url, HOSTLINK_URL);

    // Reading availability is not enrolling: nothing was asked of the Gateway,
    // and the Router key was never even decrypted.
    assert.equal(calls.enroll, 0);
    assert.equal(calls.start, 0);
    assert.deepEqual(
      host.calls.filter((call) => call.method === "providers.getSecret"),
      [],
      "checking availability must not read the account secret",
    );

    // …and the switch is offered, which is what ends the deadlock.
    assert.equal(remoteGatewaySwitchDisabled(status), false);
    // An empty profile is still an empty profile: nothing was written.
    assert.equal(status.hostId !== undefined, true);
  });
});

test("turning that switch on enrolls once and starts the link", async () => {
  await withFreshDesktop(async ({ service, calls }) => {
    await service.initialize({ enabled: false });
    assert.equal(calls.enroll, 0);

    await service.setEnabled(true);
    assert.equal(calls.enroll, 1, "exactly one automatic enrollment");
    assert.equal(calls.start, 1);
    const status = service.status();
    assert.equal(status.enabled, true);
    assert.equal(status.enrolled, true);
    assert.equal(status.accountMode?.available, true);
  });
});

test("account mode the Router does not advertise keeps the switch unavailable", async () => {
  await withFreshDesktop(
    async ({ service, calls }) => {
      await service.initialize({ enabled: false });
      const status = service.status();
      // Said out loud, with the reason host-core gave, and nothing enrolled.
      assert.equal(accountModeVisible(status), true);
      assert.equal(status.accountMode?.available, false);
      assert.match(status.accountMode?.reason ?? "", /forward is not installed/);
      assert.equal(calls.enroll, 0);
      // Unavailable account mode is not a way in: the switch keeps waiting for
      // an enrollment, exactly as before.
      assert.equal(remoteGatewaySwitchDisabled(status), true);
    },
    { remoteGateway: advertised({ available: false, unavailableReason: "the forward is not installed" }) },
  );
});

test("no Router key is named as the reason instead of hiding account mode", async () => {
  await withFreshDesktop(
    async ({ service, calls }) => {
      await service.initialize({ enabled: false });
      const status = service.status();
      assert.equal(accountModeVisible(status), true);
      assert.equal(status.accountMode?.available, false);
      assert.match(status.accountMode?.reason ?? "", /AccessKey/);
      assert.equal(calls.enroll, 0);
      assert.equal(remoteGatewaySwitchDisabled(status), true);
    },
    { providers: [] },
  );
});

test("a host-core that does not report account mode keeps the self-hosted page", async () => {
  await withFreshDesktop(
    async ({ service }) => {
      await service.initialize({ enabled: false });
      const status = service.status();
      // No field: the page shows no account-mode affordance at all.
      assert.equal(accountModeVisible(status), false);
      assert.equal(remoteGatewaySwitchDisabled(status), true);
    },
    { remoteGateway: undefined },
  );
});

test("the three switch states: never chosen defaults on, an explicit off stays off", async () => {
  // Security §3.8 / gate 27. Account mode changed the default for the one state
  // that used to be indistinguishable from "off": a user who has never touched
  // the switch. The account already names this desktop, so it starts on — and
  // the choice is written down, which is what keeps it from being re-decided.
  const neverChosen = await mkdtemp(join(tmpdir(), "remote-account-never-"));
  try {
    const host = fakeHost();
    const { port, calls } = recordingPort(await accountCertificate());
    const saved = [];
    const bootstrap = createGatewayLinkBootstrap({
      dataDir: neverChosen,
      encryption: fakeEncryption(),
      port,
      // No stored row at all: the user has never opened this page.
      getSettings: async () => null,
      saveSettings: async (remoteGateway) => {
        saved.push(remoteGateway);
      },
      getHost: () => host,
      getAgentHost: () => ({}),
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
    });
    try {
      await bootstrap.open();
      const status = await bootstrap.controller().status();
      assert.equal(status.enabled, true, "account mode defaults the switch on");
      assert.equal(status.accountMode?.available, true);
      // The decision is persisted, so the next boot reads a choice rather than
      // deciding again.
      assert.deepEqual(saved, [{ enabled: true, url: "", decided: true }]);
      assert.equal(calls.enroll, 1, "turning it on is what enrolls this desktop");
      assert.equal(calls.start, 1);
    } finally {
      await bootstrap.dispose();
    }
  } finally {
    await rm(neverChosen, { recursive: true, force: true });
  }

  // An explicit off is never re-enabled, even with account mode available: the
  // user already answered this question.
  const chosenOff = await mkdtemp(join(tmpdir(), "remote-account-off-"));
  try {
    const host = fakeHost();
    const { port, calls } = recordingPort(await accountCertificate());
    const saved = [];
    const bootstrap = createGatewayLinkBootstrap({
      dataDir: chosenOff,
      encryption: fakeEncryption(),
      port,
      getSettings: async () => ({ remoteGateway: { enabled: false, url: "", decided: true } }),
      saveSettings: async (remoteGateway) => {
        saved.push(remoteGateway);
      },
      getHost: () => host,
      getAgentHost: () => ({}),
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
    });
    try {
      await bootstrap.open();
      const status = await bootstrap.controller().status();
      assert.equal(status.enabled, false, "an explicitly disabled switch stays off");
      assert.equal(status.accountMode?.available, true);
      assert.equal(calls.enroll, 0);
      assert.equal(calls.start, 0);
      assert.deepEqual(saved, [], "nothing is written for a decision already made");
    } finally {
      await bootstrap.dispose();
    }
  } finally {
    await rm(chosenOff, { recursive: true, force: true });
  }
});

test("a self-hosted desktop with no account mode keeps its off default", async () => {
  // The "off by default" reading was written for the self-hosted flow and stays
  // exactly as it was: a Gateway the user must configure first is not an
  // account that already names this desktop.
  const dataDir = await mkdtemp(join(tmpdir(), "remote-self-hosted-"));
  try {
    const host = fakeHost({ remoteGateway: undefined });
    const { port, calls } = recordingPort(await accountCertificate());
    const saved = [];
    const bootstrap = createGatewayLinkBootstrap({
      dataDir,
      encryption: fakeEncryption(),
      port,
      getSettings: async () => null,
      saveSettings: async (remoteGateway) => {
        saved.push(remoteGateway);
      },
      getHost: () => host,
      getAgentHost: () => ({}),
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
    });
    try {
      await bootstrap.open();
      const status = await bootstrap.controller().status();
      assert.equal(status.enabled, false);
      assert.equal(status.accountMode, undefined);
      assert.equal(calls.enroll, 0);
      assert.equal(calls.start, 0);
      assert.deepEqual(saved, []);
    } finally {
      await bootstrap.dispose();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a later status read sees an account mode that became available", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-reread-"));
  try {
    // Nothing works yet: the overlay is still coming up and no Router key is
    // configured. Both are everyday states of a fresh install, and both change
    // without the switch being touched.
    const host = fakeHost({
      remoteGateway: advertised({ available: false, unavailableReason: "the forward is not installed" }),
      providers: [],
    });
    const { port, calls } = recordingPort(await accountCertificate());
    const bootstrap = createGatewayLinkBootstrap({
      dataDir,
      encryption: fakeEncryption(),
      port,
      getSettings: async () => null,
      saveSettings: async () => undefined,
      getHost: () => host,
      getAgentHost: () => ({}),
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
    });
    try {
      await bootstrap.open();
      const first = await bootstrap.controller().status();
      assert.equal(first.accountMode?.available, false);
      assert.match(first.accountMode?.reason ?? "", /forward is not installed/);
      assert.equal(remoteGatewaySwitchDisabled(first), true);

      // The overlay finished connecting.
      host.state.remoteGateway = advertised();
      const second = await bootstrap.controller().status();
      assert.equal(second.accountMode?.available, false, "the key is still missing");
      assert.match(second.accountMode?.reason ?? "", /AccessKey/);

      // The user finished setting up Minih Router.
      host.state.providers = [ROUTER_ROW];
      const third = await bootstrap.controller().status();
      assert.equal(third.accountMode?.available, true, "a later answer must not be masked by the first");
      assert.equal(remoteGatewaySwitchDisabled(third), false);
      // Reading status is still not enrolling.
      assert.equal(calls.enroll, 0);
      assert.equal(calls.start, 0);
    } finally {
      await bootstrap.dispose();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a switched-off desktop keeps following the Router's answer", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "remote-account-off-refresh-"));
  try {
    const host = fakeHost();
    const { port, calls } = recordingPort(await accountCertificate());
    const bootstrap = createGatewayLinkBootstrap({
      dataDir,
      encryption: fakeEncryption(),
      port,
      // The user already turned remote access on once, so the service exists.
      getSettings: async () => ({ remoteGateway: { enabled: true, url: "" } }),
      saveSettings: async () => undefined,
      getHost: () => host,
      getAgentHost: () => ({}),
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
    });
    try {
      await bootstrap.open();
      assert.equal(calls.enroll, 1, "the first start enrolls through the account");

      // The user turns remote access back off.
      await bootstrap.controller().setEnabled(false);
      const off = await bootstrap.controller().status();
      assert.equal(off.enabled, false);
      assert.equal(off.accountMode?.available, true);

      // The Router stops advertising account mode while the switch is off: the
      // page still has to tell the truth, because that answer is what would
      // let the user turn the switch back on.
      host.state.remoteGateway = advertised({
        available: false,
        unavailableReason: "the forward is not installed",
      });
      const after = await bootstrap.controller().status();
      assert.equal(after.accountMode?.available, false, "a switched-off service must re-read it");
      assert.match(after.accountMode?.reason ?? "", /forward is not installed/);
      // This desktop is enrolled, so the switch stays usable regardless: what
      // had to change is the answer that describes account mode.
      assert.equal(after.enrolled, true);
      assert.equal(remoteGatewaySwitchDisabled(after), false);
    } finally {
      await bootstrap.dispose();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
