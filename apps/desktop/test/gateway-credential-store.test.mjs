/**
 * Encrypted credential store for the desktop Host link (rollout R5, ADR 0330).
 *
 * The file holds this desktop's Host id, its mTLS key material, and the paired
 * devices. It must never be readable without the OS keychain: these tests use
 * a fake `EncryptionPort` and assert the bytes on disk are ciphertext only, and
 * that an unreadable file is an error rather than an empty store.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createGatewayCredentialStore } = await import(
  "../electron/main/remote/gateway-link/gateway-credential-store.ts"
);
const { hashToken } = await import("@minih-agent/racp");

const FILE = join("remote-gateway", "gateway-link.json");
const DEVICE_TOKEN = "rdt1.fake-device-token-for-tests";

function fakeEncryption(overrides = {}) {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not ciphertext");
      return text.slice("enc:".length);
    },
    ...overrides,
  };
}

async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), "gateway-credentials-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("credentials are written encrypted, atomically, and read back", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const store = createGatewayCredentialStore({
      dataDir: dir,
      encryption: fakeEncryption(),
      newHostId: () => "host_fixed",
    });
    await store.open();
    assert.equal(store.hostId(), "host_fixed");
    assert.equal(store.enrolled(), false);
    // Opening a missing file must not create one.
    await assert.rejects(stat(join(dir, FILE)), { code: "ENOENT" });

    await store.saveCredentials({
      hostId: "host_fixed",
      gatewayUrl: "wss://gateway.test",
      gatewayCaPem: "ca-pem",
      certificatePem: "certificate-pem",
      privateKeyPem: "private-key-pem",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    await store.saveDevice({
      deviceId: "dev_phone",
      label: "phone",
      roles: ["viewer", "controller", "approver"],
      tokenHash: hashToken(DEVICE_TOKEN),
      createdAt: "2026-10-18T00:00:00.000Z",
      origin: "gateway",
    });

    const raw = await readFile(join(dir, FILE), "utf8");
    // The file is an envelope around one ciphertext blob: no plaintext JSON,
    // no device id, no token, and no private key.
    const envelope = JSON.parse(raw);
    assert.equal(envelope.version, 1);
    assert.equal(typeof envelope.payload, "string");
    for (const secret of [DEVICE_TOKEN, "dev_phone", "private-key-pem", "host_fixed", "\"devices\""]) {
      assert.equal(raw.includes(secret), false, `the file must not contain ${secret}`);
    }
    const mode = (await stat(join(dir, FILE))).mode & 0o777;
    assert.equal(mode, 0o600, "the credential file is owner-only");

    // A second instance reads the same document back.
    const reopened = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
    await reopened.open();
    assert.equal(reopened.hostId(), "host_fixed");
    assert.equal(reopened.credentials().privateKeyPem, "private-key-pem");
    const devices = await reopened.listDevices();
    assert.equal(devices.length, 1);
    // The store keeps the hash; the service is what omits it from the renderer.
    assert.equal(devices[0].tokenHash, hashToken(DEVICE_TOKEN));
    const found = await reopened.findDeviceByTokenHash(hashToken(DEVICE_TOKEN));
    assert.equal(found.deviceId, "dev_phone");
    assert.deepEqual(found.roles, ["viewer", "controller", "approver"]);
  } finally {
    await cleanup();
  }
});

test("pairing tokens are single use and survive a restart", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const store = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
    await store.open();
    const tokenHash = hashToken("pdt1.pairing-token-for-tests");
    await store.savePairing({
      tokenHash,
      expiresAt: "2030-01-01T00:00:00.000Z",
      origin: "gateway",
    });

    const reopened = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
    await reopened.open();
    const record = await reopened.findPairing(tokenHash);
    assert.equal(record.origin, "gateway");
    assert.equal(await reopened.consumePairing(tokenHash, "2026-10-18T00:00:00.000Z"), true);
    assert.equal(await reopened.consumePairing(tokenHash, "2026-10-18T00:01:00.000Z"), false);
    assert.equal((await reopened.findPairing(tokenHash)).consumedAt, "2026-10-18T00:00:00.000Z");
  } finally {
    await cleanup();
  }
});

test("revoking a device is recorded once and is durable", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const store = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
    await store.open();
    await store.saveDevice({
      deviceId: "dev_phone",
      label: "phone",
      roles: ["viewer"],
      tokenHash: hashToken(DEVICE_TOKEN),
      createdAt: "2026-10-18T00:00:00.000Z",
      origin: "gateway",
    });
    assert.equal(await store.revokeDevice("dev_phone", "2026-10-18T01:00:00.000Z"), true);
    assert.equal(await store.revokeDevice("dev_phone", "2026-10-18T02:00:00.000Z"), false);
    assert.equal(await store.revokeDevice("dev_unknown", "2026-10-18T02:00:00.000Z"), false);

    const reopened = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
    await reopened.open();
    const [device] = await reopened.listDevices();
    assert.equal(device.revokedAt, "2026-10-18T01:00:00.000Z");
    await reopened.touchDevice("dev_phone", "2026-10-18T03:00:00.000Z");
    assert.equal((await reopened.listDevices())[0].lastSeenAt, "2026-10-18T03:00:00.000Z");
  } finally {
    await cleanup();
  }
});

test("an undecryptable file is an error, not an empty store", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const store = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
    await store.open();
    await store.saveCredentials({
      hostId: "host_fixed",
      gatewayUrl: "wss://gateway.test",
      gatewayCaPem: "ca-pem",
      certificatePem: "cert",
      privateKeyPem: "key",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });

    const broken = createGatewayCredentialStore({
      dataDir: dir,
      encryption: fakeEncryption({
        decryptString: () => {
          throw new Error("keychain moved");
        },
      }),
    });
    await assert.rejects(broken.open(), (error) => error.errorCode === "GATEWAY_CREDENTIALS_UNREADABLE");
    // Using it before a successful open fails loudly too.
    assert.throws(() => broken.credentials(), /opened/);

    // A corrupt file and an unavailable keychain are equally explicit.
    await writeFile(join(dir, FILE), "{not json", "utf8");
    const corrupt = createGatewayCredentialStore({ dataDir: dir, encryption: fakeEncryption() });
    await assert.rejects(corrupt.open(), (error) => error.errorCode === "GATEWAY_CREDENTIALS_UNREADABLE");

    // An unavailable keychain is reported on its own path: a valid file that
    // this machine can no longer decrypt must not read as "corrupt".
    const { dir: keychainDir, cleanup: cleanupKeychain } = await tmpDir();
    try {
      const seeded = createGatewayCredentialStore({ dataDir: keychainDir, encryption: fakeEncryption() });
      await seeded.open();
      await seeded.saveCredentials({
        hostId: "host_fixed",
        gatewayUrl: "wss://gateway.test",
        gatewayCaPem: "ca-pem",
        certificatePem: "cert",
        privateKeyPem: "key",
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
      const unavailable = createGatewayCredentialStore({
        dataDir: keychainDir,
        encryption: fakeEncryption({ isAvailable: () => false }),
      });
      await assert.rejects(
        unavailable.open(),
        (error) => error.errorCode === "GATEWAY_CREDENTIALS_STORAGE_UNAVAILABLE",
      );
    } finally {
      await cleanupKeychain();
    }
  } finally {
    await cleanup();
  }
});
