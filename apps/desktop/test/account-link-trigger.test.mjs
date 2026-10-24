/**
 * The Host link's hand-off to the account join round (rollout R8 package E).
 *
 * The link owns the credentials and the status; the roster belongs to the
 * paired-host boot. This pins the one moment they meet: a transition into
 * `connected` in account mode, once per connection, never for the self-hosted
 * flow and never again for a repeated `connected` report.
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

const { createGatewayLinkBootstrap } = await import("../electron/main/bootstrap/gateway-link.ts");
const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const { buildHost } = await import("@minih-agent/racp/test-harness");

const HOSTLINK_URL = "wss://gateway.test/hostlink";
const PUBLIC_ORIGIN = "https://gateway.test";
const TLS_SERVER_NAME = "gateway.test";

function fakeEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("cannot decrypt");
      return text.slice("enc:".length);
    },
  };
}

async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), "account-link-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Enrolled credentials, account mode when `accountMode` is set. */
async function enrollOnDisk(dir, { accountMode }) {
  const store = createGatewayCredentialStore({
    dataDir: dir,
    encryption: fakeEncryption(),
    newHostId: () => "host_test_fixed",
  });
  await store.open();
  await store.saveCredentials({
    hostId: "host_test_fixed",
    gatewayUrl: HOSTLINK_URL,
    gatewayCaPem: "ca-pem",
    certificatePem: "cert-pem",
    privateKeyPem: "key-pem",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...(accountMode
      ? { hostlinkUrl: HOSTLINK_URL, tlsServerName: TLS_SERVER_NAME }
      : {}),
  });
}

/**
 * The local host as account mode reads it: the Router advertises a usable
 * Gateway and this desktop holds a key for the account.
 */
function stubHost() {
  return {
    async call(method) {
      if (method === "easytier.status") {
        return {
          remoteGateway: {
            available: true,
            hostlinkUrl: HOSTLINK_URL,
            publicOrigin: PUBLIC_ORIGIN,
            dialUrl: "https://127.0.0.1:1",
            caPem: "ca-pem",
            tlsServerName: TLS_SERVER_NAME,
          },
        };
      }
      if (method === "providers.list") {
        return { providers: [{ id: "pr_router", vendorKey: "minih-router", hasSecret: true, enabled: true }] };
      }
      if (method === "session.list") return { sessions: [] };
      if (method === "projects.list") return { projects: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
}

/** A transport whose link is already connected, with its status listener kept. */
function connectedPort() {
  const calls = { start: 0, stop: 0 };
  let listener;
  return {
    calls,
    port: {
      async enroll(input) {
        return {
          hostId: input.hostId,
          gatewayUrl: input.gatewayUrl,
          gatewayCaPem: input.gatewayCaPem,
          certificatePem: "cert-pem",
          privateKeyPem: "key-pem",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        };
      },
      start(options) {
        calls.start += 1;
        listener = options.onStatus;
        return {
          status: () => ({ state: "connected", since: new Date().toISOString() }),
          async stop() {
            calls.stop += 1;
          },
        };
      },
    },
    /** Report a transport status the way a real link does. */
    report(state) {
      listener?.({ state, since: new Date().toISOString() });
    },
  };
}

function bootstrapFor(dir, port, events) {
  const host = buildHost();
  return createGatewayLinkBootstrap({
    dataDir: dir,
    encryption: fakeEncryption(),
    port,
    getSettings: async () => ({ remoteGateway: { enabled: true, url: HOSTLINK_URL } }),
    saveSettings: async () => undefined,
    getHost: () => stubHost(),
    getAgentHost: () => host.host,
    serverVersion: "0.0.0-test",
    emitStatus: () => undefined,
    log: () => undefined,
    now: () => Date.parse("2026-10-23T00:00:00.000Z"),
    onAccountLinkUp: (input) => events.push(input),
  });
}

test("a connected account-mode link hands this computer's identity over once", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir, { accountMode: true });
    const events = [];
    const transport = connectedPort();
    const bootstrap = bootstrapFor(dir, transport.port, events);

    await bootstrap.open();
    assert.equal(transport.calls.start, 1);

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      publicOrigin: PUBLIC_ORIGIN,
      hostId: "host_test_fixed",
      certificatePem: "cert-pem",
      privateKeyPem: "key-pem",
    });

    // A repeated `connected` report is the same connection: the roster is not
    // asked for again.
    transport.report("connected");
    assert.equal(events.length, 1);

    // A reconnect is a new connection, so discovery runs again.
    transport.report("backoff");
    transport.report("connected");
    assert.equal(events.length, 2);

    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("the self-hosted flow has no account to join and never calls out", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir, { accountMode: false });
    const events = [];
    const transport = connectedPort();
    const bootstrap = bootstrapFor(dir, transport.port, events);

    await bootstrap.open();
    assert.equal(transport.calls.start, 1);

    transport.report("connected");
    assert.deepEqual(events, []);

    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

/** Poll until `predicate` holds; the wait is bounded and named, never a bare sleep. */
async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** A bootstrap whose account join round reports whatever the test decides. */
function accountJoinBootstrap(dir, port, { emitStatus, retryDelaysMs, onAccountLinkUp }) {
  const host = buildHost();
  return createGatewayLinkBootstrap({
    dataDir: dir,
    encryption: fakeEncryption(),
    port,
    getSettings: async () => ({ remoteGateway: { enabled: true, url: HOSTLINK_URL } }),
    saveSettings: async () => undefined,
    getHost: () => stubHost(),
    getAgentHost: () => host.host,
    serverVersion: "0.0.0-test",
    emitStatus,
    log: () => undefined,
    now: () => Date.parse("2026-10-23T00:00:00.000Z"),
    accountJoinRetryDelaysMs: retryDelaysMs,
    onAccountLinkUp,
  });
}

test("a failed round is reported on the status and retried while the link stays up", async () => {
  // The round is the only thing that turns the account's other computers into
  // remote hosts, and it used to run once per connection with its failure going
  // nowhere but the log: the list stayed empty until the next restart. A failed
  // round now names its reason on the status and gets a bounded retry.
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir, { accountMode: true });
    const attempts = [];
    const statuses = [];
    const transport = connectedPort();
    const bootstrap = accountJoinBootstrap(dir, transport.port, {
      emitStatus: (status) => statuses.push(status),
      retryDelaysMs: [5, 5],
      onAccountLinkUp: async () => {
        attempts.push(attempts.length + 1);
        return { state: "failed", reason: "ACCOUNT_LOGIN_REFUSED", detail: "INVALID_ARGUMENT" };
      },
    });

    await bootstrap.open();
    await waitFor(() => attempts.length === 3, "the first round and its two retries");

    const report = statuses.at(-1).accountComputers;
    assert.equal(report.state, "failed");
    assert.equal(report.reason, "ACCOUNT_LOGIN_REFUSED");
    assert.equal(report.detail, "INVALID_ARGUMENT", "the Gateway's own code reaches the page");

    // The backoff is bounded: past its last entry no further round is asked for.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(attempts.length, 3);

    // A status read carries the same report, so the page never depends on a push
    // arriving while it is mounted.
    const pulled = await bootstrap.controller().status();
    assert.equal(pulled.accountComputers?.reason, "ACCOUNT_LOGIN_REFUSED");

    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("a successful round reports the computers it joined", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir, { accountMode: true });
    const statuses = [];
    const transport = connectedPort();
    const bootstrap = accountJoinBootstrap(dir, transport.port, {
      emitStatus: (status) => statuses.push(status),
      retryDelaysMs: [5],
      onAccountLinkUp: async () => ({ state: "joined", computers: 2 }),
    });

    await bootstrap.open();
    await waitFor(() => statuses.at(-1)?.accountComputers?.state === "joined", "the joined report");
    assert.equal(statuses.at(-1).accountComputers.computers, 2);
    assert.equal(
      statuses.at(-1).accountComputers.nextRetryAt,
      undefined,
      "a round that succeeded queues nothing",
    );

    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("disposal cancels a queued retry", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir, { accountMode: true });
    const attempts = [];
    const transport = connectedPort();
    const bootstrap = accountJoinBootstrap(dir, transport.port, {
      emitStatus: () => undefined,
      retryDelaysMs: [40],
      onAccountLinkUp: async () => {
        attempts.push(attempts.length + 1);
        return { state: "failed", reason: "ACCOUNT_ROSTER_UNAVAILABLE" };
      },
    });

    await bootstrap.open();
    await waitFor(() => attempts.length === 1, "the first round");
    await bootstrap.dispose();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(attempts.length, 1, "nothing runs after disposal");
  } finally {
    await cleanup();
  }
});

test("a callback that throws synchronously reports once and does not re-enter", async () => {
  // `emit` re-enters through the status push, so a synchronous throw used to
  // start another round from inside the first one, and again from inside that —
  // a stack overflow instead of a failure the page can show. One round, one
  // report, and the reason survives.
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir, { accountMode: true });
    let calls = 0;
    const statuses = [];
    const transport = connectedPort();
    const bootstrap = accountJoinBootstrap(dir, transport.port, {
      emitStatus: (status) => statuses.push(status),
      retryDelaysMs: [],
      onAccountLinkUp: () => {
        calls += 1;
        throw new Error("boom");
      },
    });

    await bootstrap.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "the failing round is not re-entered");
    assert.equal(statuses.at(-1).accountComputers.state, "failed");
    assert.equal(statuses.at(-1).accountComputers.reason, "boom");

    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("a link that goes down drops the report and the retry it promised", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir, { accountMode: true });
    const statuses = [];
    const transport = connectedPort();
    const bootstrap = accountJoinBootstrap(dir, transport.port, {
      emitStatus: (status) => statuses.push(status),
      // Long enough that the retry is still queued when the link drops.
      retryDelaysMs: [5000],
      onAccountLinkUp: async () => ({ state: "failed", reason: "ACCOUNT_ROSTER_UNAVAILABLE" }),
    });

    await bootstrap.open();
    await waitFor(() => statuses.at(-1)?.accountComputers?.nextRetryAt !== undefined, "the queued retry");

    transport.report("backoff");

    // The report described a connection that no longer exists; the page must not
    // keep promising a retry for it.
    assert.equal(statuses.at(-1).accountComputers, undefined);
    const pulled = await bootstrap.controller().status();
    assert.equal(pulled.accountComputers, undefined);

    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});