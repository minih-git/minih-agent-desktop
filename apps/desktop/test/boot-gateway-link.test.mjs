/**
 * Desktop-as-connected-Host boot and lifecycle (rollout R5, ADR 0331).
 *
 * The feature is off by default and must stay inert when it is: security gate
 * 27 says a disabled desktop behaves exactly like today's build — no store
 * write, no `RacpServer`, no outbound dial. The lifecycle tests below drive
 * the same bootstrap the app boots, with an in-memory port standing in for the
 * Gateway transport PR-3b lands.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createGatewayLinkBootstrap } = await import(
  "../electron/main/bootstrap/gateway-link.ts"
);
const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const { buildHost } = await import("@minih-agent/racp/test-harness");

const CREDENTIALS_PATH = join("remote-gateway", "gateway-link.json");

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
  const dir = await mkdtemp(join(tmpdir(), "gateway-link-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Records what the bootstrap asked the transport to do. */
function memoryPort() {
  const calls = { enroll: 0, start: 0, stop: 0 };
  return {
    calls,
    port: {
      async enroll(input) {
        calls.enroll += 1;
        return {
          hostId: input.hostId,
          gatewayUrl: input.gatewayUrl,
          gatewayCaPem: input.gatewayCaPem,
          certificatePem: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
          privateKeyPem: "test-private-key",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        };
      },
      start() {
        calls.start += 1;
        let stopped = false;
        return {
          status: () => ({ state: "connecting", since: new Date().toISOString() }),
          async stop() {
            if (stopped) return;
            stopped = true;
            calls.stop += 1;
          },
        };
      },
    },
  };
}

function stubHost() {
  return {
    async call(method) {
      if (method === "session.list") return { sessions: [] };
      if (method === "projects.list") return { projects: [] };
      throw new Error(`unexpected ${method}`);
    },
  };
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

function bootstrapFor(dir, options = {}) {
  const host = buildHost();
  const { port, calls } = memoryPort();
  const saved = [];
  const emitted = [];
  const settings = options.settings ?? null;
  const bootstrap = createGatewayLinkBootstrap({
    dataDir: dir,
    encryption: options.encryption ?? fakeEncryption(),
    port,
    getSettings: async () => settings,
    saveSettings: async (remoteGateway) => {
      saved.push(remoteGateway);
    },
    getHost: () => stubHost(),
    getAgentHost: () => host.host,
    serverVersion: "0.0.0-test",
    emitStatus: (status) => emitted.push(status),
    log: () => undefined,
    // The pairing code lifetime is not part of these assertions; a fixed clock
    // keeps timestamps comparable.
    now: () => Date.parse("2026-10-18T00:00:00.000Z"),
  });
  return { bootstrap, calls, saved, emitted, host };
}

test("a missing or disabled setting creates nothing and never dials (S12)", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    for (const settings of [null, {}, { remoteGateway: { enabled: false, url: "" } }]) {
      const { bootstrap, calls } = bootstrapFor(dir, { settings });
      await bootstrap.open();
      assert.equal(calls.enroll, 0);
      assert.equal(calls.start, 0);
      const status = await bootstrap.controller().status();
      assert.ok(
        status.state === "disabled" || status.state === "not-enrolled",
        `unexpected state ${status.state}`,
      );
      assert.equal(status.enabled, false);
      // Nothing was written: a disabled feature leaves the data directory alone.
      await assert.rejects(stat(join(dir, CREDENTIALS_PATH)), { code: "ENOENT" });
      await bootstrap.dispose();
    }
  } finally {
    await cleanup();
  }
});

test("an enabled but unenrolled desktop starts no link", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const { bootstrap, calls } = bootstrapFor(dir, {
      settings: { remoteGateway: { enabled: true, url: "wss://gateway.test" } },
    });
    await bootstrap.open();
    assert.equal(calls.start, 0);
    assert.equal(calls.enroll, 0);
    const status = await bootstrap.controller().status();
    assert.equal(status.state, "not-enrolled");
    assert.equal(status.enrolled, false);
    assert.equal(status.url, "wss://gateway.test");
    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("an enrolled desktop that is switched on starts exactly one link", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir);
    const { bootstrap, calls, emitted } = bootstrapFor(dir, {
      settings: { remoteGateway: { enabled: true, url: "wss://gateway.test" } },
    });
    await bootstrap.open();
    assert.equal(calls.start, 1);
    const status = await bootstrap.controller().status();
    assert.equal(status.enrolled, true);
    assert.equal(status.enabled, true);
    assert.equal(status.hostId, "host_test_fixed");
    assert.ok(status.state === "connecting" || status.state === "connected");
    // Status pushes reach the renderer, which is what a (re)loaded window
    // subscribes to.
    assert.ok(emitted.length > 0);
    assert.equal(emitted.at(-1).enabled, true);
    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("disabling stops the handle, re-enabling starts a new one", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir);
    const { bootstrap, calls, saved } = bootstrapFor(dir);
    await bootstrap.open();
    const controller = bootstrap.controller();

    const enabledStatus = await controller.setEnabled(true);
    assert.equal(enabledStatus.enabled, true);
    assert.equal(calls.start, 1);
    // The row records the user's choice (`decided`, gate 27) and nothing else
    // that is unset: strict mode off and automatic admission on are the defaults
    // and are left out of the stored shape.
    assert.deepEqual(saved.at(-1), { enabled: true, url: "", decided: true });

    await controller.setEnabled(false);
    assert.equal(calls.stop, 1);
    await controller.setEnabled(true);
    assert.equal(calls.start, 2);
    assert.deepEqual(saved.at(-1), { enabled: true, url: "", decided: true });
    await bootstrap.dispose();
    assert.equal(calls.stop, 2);
  } finally {
    await cleanup();
  }
});

test("rapid switching never overlaps two links", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir);
    const { bootstrap, calls } = bootstrapFor(dir);
    await bootstrap.open();
    const controller = bootstrap.controller();
    await Promise.all([
      controller.setEnabled(true),
      controller.setEnabled(false),
      controller.setEnabled(true),
    ]);
    // Every transition ran once, in order: start, stop, start — never two
    // starts for one live handle.
    assert.equal(calls.start, 2);
    assert.equal(calls.stop, 1);
    const status = await controller.status();
    assert.equal(status.enabled, true);
    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("dispose is idempotent and closes the link once", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir);
    const { bootstrap, calls, emitted } = bootstrapFor(dir, {
      settings: { remoteGateway: { enabled: true, url: "wss://gateway.test" } },
    });
    await bootstrap.open();
    assert.equal(calls.start, 1);
    await Promise.all([bootstrap.dispose(), bootstrap.dispose()]);
    await bootstrap.dispose();
    assert.equal(calls.stop, 1);
    const last = emitted.at(-1);
    assert.equal(last.enabled, false);
    assert.equal(last.state, "disabled");
    // No further pushes after dispose: the listener set is released.
    const after = emitted.length;
    await bootstrap.dispose();
    assert.equal(emitted.length, after);
  } finally {
    await cleanup();
  }
});

test("a renderer reload re-reads status without touching the link", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir);
    const { bootstrap, calls } = bootstrapFor(dir, {
      settings: { remoteGateway: { enabled: true, url: "wss://gateway.test" } },
    });
    await bootstrap.open();
    assert.equal(calls.start, 1);

    // A reloaded renderer drops its own listener and subscribes again; the
    // link belongs to main, so nothing here stops or restarts the transport.
    const status = await bootstrap.controller().status();
    assert.equal(status.enabled, true);
    const again = await bootstrap.controller().status();
    assert.equal(again.state, status.state);
    assert.equal(calls.start, 1);
    assert.equal(calls.stop, 0);
    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});

test("credentials that cannot be decrypted are reported, not treated as empty", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await enrollOnDisk(dir);
    const broken = {
      isAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`),
      decryptString: () => {
        throw new Error("keychain moved");
      },
    };
    const { bootstrap, calls } = bootstrapFor(dir, {
      encryption: broken,
      settings: { remoteGateway: { enabled: true, url: "wss://gateway.test" } },
    });
    await bootstrap.open();
    assert.equal(calls.start, 0);
    const status = await bootstrap.controller().status();
    assert.equal(status.state, "error");
    assert.equal(status.lastError.code, "GATEWAY_CREDENTIALS_UNREADABLE");
    // The failed read must not have rewritten or removed the file.
    const raw = JSON.parse(await readFile(join(dir, CREDENTIALS_PATH), "utf8"));
    assert.equal(typeof raw.payload, "string");
    await bootstrap.dispose();
  } finally {
    await cleanup();
  }
});
