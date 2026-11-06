/**
 * System wake and network hints for the desktop Host link (protocol §11.4
 * rule 5).
 *
 * A dead overlay tunnel is detected by the link's own idle watchdog. These
 * hints only remove the backoff wait that follows, so the assertions are about
 * where a hint goes and what owns it: the watch forwards it, the bootstrap asks
 * the running link, and disposal takes every listener and timer with it.
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

const { createLinkWakeWatch } = await import(
  "../electron/main/remote/gateway-link/link-wake-watch.ts"
);
const { createGatewayLinkBootstrap } = await import(
  "../electron/main/bootstrap/gateway-link.ts"
);
const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const { buildHost } = await import("@minih-agent/racp/test-harness");

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
  const dir = await mkdtemp(join(tmpdir(), "gateway-link-wake-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function enrollOnDisk(dir, hostId = "host_test_fixed") {
  const store = createGatewayCredentialStore({
    dataDir: dir,
    encryption: fakeEncryption(),
    newHostId: () => hostId,
  });
  await store.open();
  await store.saveCredentials({
    hostId,
    gatewayUrl: "wss://gateway.test",
    gatewayCaPem: "ca-pem",
    certificatePem: "cert-pem",
    privateKeyPem: "key-pem",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
}

/** Wake sources a test drives by hand: no Electron, no polling. */
function fakeSources(options = {}) {
  const state = { online: options.online ?? true };
  const listeners = new Set();
  return {
    state,
    listeners,
    sources: {
      onResume(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isOnline: () => state.online,
    },
    resume() {
      for (const listener of [...listeners]) listener();
    },
  };
}

test("a resume reaches the wake handler", async () => {
  const sources = fakeSources();
  const reasons = [];
  const watch = createLinkWakeWatch({
    sources: sources.sources,
    onWake: (reason) => reasons.push(reason),
    pollMs: 5,
  });
  try {
    sources.resume();
    assert.deepEqual(reasons, ["resume"]);
  } finally {
    watch.dispose();
  }
});

test("only a returning network is a hint, never going offline", async () => {
  const sources = fakeSources();
  const reasons = [];
  const watch = createLinkWakeWatch({
    sources: sources.sources,
    onWake: (reason) => reasons.push(reason),
    pollMs: 5,
  });
  try {
    sources.state.online = false;
    // The poll notices the transition; a private overlay can be healthy with no
    // internet, so losing it is never a reason to touch the link.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(reasons, []);
    sources.state.online = true;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(reasons, ["network"]);
  } finally {
    watch.dispose();
  }
});

test("disposal removes the listener and the timer it owns", async () => {
  const sources = fakeSources();
  const reasons = [];
  const watch = createLinkWakeWatch({
    sources: sources.sources,
    onWake: (reason) => reasons.push(reason),
    pollMs: 5,
  });
  watch.dispose();
  assert.equal(sources.listeners.size, 0);
  sources.resume();
  sources.state.online = false;
  await new Promise((resolve) => setTimeout(resolve, 25));
  sources.state.online = true;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(reasons, []);
});

test("a throwing wake handler does not escape the timer", async () => {
  const sources = fakeSources();
  const watch = createLinkWakeWatch({
    sources: sources.sources,
    onWake: () => {
      throw new Error("handler failed");
    },
    pollMs: 5,
    log: () => undefined,
  });
  try {
    // The resume listener is called synchronously by Electron; a throw here
    // would surface as an uncaught exception in the main process.
    assert.doesNotThrow(() => sources.resume());
  } finally {
    watch.dispose();
  }
});

test("a resume asks the running link to reconnect, and disappears with it", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir);
    const host = buildHost();
    const sources = fakeSources();
    let reconnects = 0;
    let stops = 0;
    const bootstrap = createGatewayLinkBootstrap({
      dataDir: dir,
      encryption: fakeEncryption(),
      port: {
        async enroll(input) {
          throw new Error(`unexpected enroll for ${input.hostId}`);
        },
        start() {
          return {
            status: () => ({ state: "backoff", since: new Date().toISOString() }),
            async stop() {
              stops += 1;
            },
            reconnectNow() {
              reconnects += 1;
              return true;
            },
          };
        },
      },
      getSettings: async () => ({ remoteGateway: { enabled: true, url: "wss://gateway.test" } }),
      saveSettings: async () => undefined,
      getHost: () => ({ async call() { return { sessions: [], projects: [] }; } }),
      getAgentHost: () => host.host,
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
      wakeSources: sources.sources,
      wakePollMs: 5,
    });
    await bootstrap.open();
    assert.equal(sources.listeners.size, 1, "the watch is created with the link");
    sources.resume();
    assert.equal(reconnects, 1);
    // The hint goes through the same entry the app would call.
    assert.equal(bootstrap.reconnectNow(), true);
    assert.equal(reconnects, 2);
    await bootstrap.dispose();
    assert.equal(sources.listeners.size, 0, "disposal takes the listener with it");
    assert.equal(stops, 1);
    assert.equal(bootstrap.reconnectNow(), false, "nothing is left to reconnect");
    assert.equal(reconnects, 2);
  } finally {
    await cleanup();
  }
});

test("a hint does nothing while the feature is off", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const sources = fakeSources();
    const bootstrap = createGatewayLinkBootstrap({
      dataDir: dir,
      encryption: fakeEncryption(),
      port: {
        async enroll() {
          throw new Error("unexpected enroll");
        },
        start() {
          throw new Error("unexpected start");
        },
      },
      getSettings: async () => ({ remoteGateway: { enabled: false, url: "" } }),
      saveSettings: async () => undefined,
      getHost: () => null,
      getAgentHost: () => buildHost().host,
      serverVersion: "0.0.0-test",
      emitStatus: () => undefined,
      log: () => undefined,
      wakeSources: sources.sources,
      wakePollMs: 5,
    });
    await bootstrap.open();
    assert.equal(sources.listeners.size, 0, "an off switch owns no listener");
    assert.equal(bootstrap.reconnectNow(), false);
    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});