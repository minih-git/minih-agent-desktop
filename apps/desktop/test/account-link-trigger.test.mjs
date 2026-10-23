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