/**
 * The installation identity (`./device-installation.ts`).
 *
 * The id has to be the SAME after a restart, a forgotten Host, and the orphan
 * cleanup — that is the whole point of it — so these tests are about durability
 * and isolation, and about a storage failure being reported instead of being
 * covered up with a fresh id.
 */
import { describe, expect, it } from "vitest";

import {
  INSTALLATION_ID_KEY_PREFIX,
  browserInstallationStorage,
  createInstallationId,
  installationIdFailure,
  installationIdKey,
  registryInstallationStorage,
  secureStoreInstallationStorage,
  type InstallationIdStorage,
} from "./device-installation.js";
import { createMemoryStorage } from "./host-registry.js";
import { DEVICE_TOKEN_KEY_PREFIX, createMemorySecureStore, hostIdFromKey } from "./secure-store.js";

const ORIGIN = "https://gw.example.com";
const OTHER_ORIGIN = "https://other.example.com";
/** A v4 UUID, which is what `crypto.randomUUID()` produces. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A storage that records every access and can be made to fail on demand. */
function testStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<[string, string]> = [];
  let readFailure: Error | null = null;
  let writeFailure: Error | null = null;
  const storage: InstallationIdStorage = {
    read: async (key) => {
      reads.push(key);
      if (readFailure) throw readFailure;
      return values.get(key) ?? null;
    },
    write: async (key, value) => {
      if (writeFailure) throw writeFailure;
      writes.push([key, value]);
      values.set(key, value);
    },
  };
  return {
    storage,
    reads,
    writes,
    values,
    failReads: (error: Error) => {
      readFailure = error;
    },
    failWrites: (error: Error) => {
      writeFailure = error;
    },
    heal: () => {
      readFailure = null;
      writeFailure = null;
    },
  };
}

describe("createInstallationId", () => {
  it("mints one random id per Gateway origin and stores it", async () => {
    const store = testStorage();
    const resolver = createInstallationId({ storage: () => store.storage });

    const id = await resolver.installationId(ORIGIN);

    expect(id).toMatch(UUID);
    expect(store.values.get(installationIdKey(ORIGIN))).toBe(id);
    expect(store.writes).toEqual([[installationIdKey(ORIGIN), id]]);
  });

  it("returns the stored id instead of minting another one", async () => {
    const store = testStorage();
    const first = await createInstallationId({ storage: () => store.storage }).installationId(ORIGIN);

    // A fresh resolver is what a reloaded app is: the id must not change.
    const second = await createInstallationId({ storage: () => store.storage }).installationId(ORIGIN);

    expect(second).toBe(first);
    expect(store.writes).toHaveLength(1);
  });

  it("shares one read and one write between concurrent callers", async () => {
    const store = testStorage();
    const resolver = createInstallationId({ storage: () => store.storage });

    const [first, second] = await Promise.all([resolver.installationId(ORIGIN), resolver.installationId(ORIGIN)]);

    expect(second).toBe(first);
    // Two taps must not become two ids: the second caller joined the first read.
    expect(store.reads).toHaveLength(1);
    expect(store.writes).toHaveLength(1);
  });

  it("keeps a separate id per Gateway origin", async () => {
    const store = testStorage();
    const resolver = createInstallationId({ storage: () => store.storage });

    const here = await resolver.installationId(ORIGIN);
    const there = await resolver.installationId(OTHER_ORIGIN);

    expect(there).not.toBe(here);
    expect(store.values.get(installationIdKey(ORIGIN))).toBe(here);
    expect(store.values.get(installationIdKey(OTHER_ORIGIN))).toBe(there);
  });

  it("gives two installs different ids", async () => {
    // Two phones: nothing shared but the code, so two identities.
    const one = await createInstallationId({ storage: () => testStorage().storage }).installationId(ORIGIN);
    const other = await createInstallationId({ storage: () => testStorage().storage }).installationId(ORIGIN);

    expect(other).not.toBe(one);
  });

  it("rejects when the store cannot be read, and tries again on the next call", async () => {
    const store = testStorage();
    store.failReads(new Error("the Keychain is locked"));
    const resolver = createInstallationId({ storage: () => store.storage });

    await expect(resolver.installationId(ORIGIN)).rejects.toThrow("the Keychain is locked");

    // A failure is not remembered: the retry reads and writes again.
    store.heal();
    await expect(resolver.installationId(ORIGIN)).resolves.toMatch(UUID);
    expect(store.writes).toHaveLength(1);
  });

  it("does not hand out an id it could not store", async () => {
    const store = testStorage();
    store.failWrites(new Error("the Keychain is locked"));
    const resolver = createInstallationId({ storage: () => store.storage });

    await expect(resolver.installationId(ORIGIN)).rejects.toThrow("the Keychain is locked");
    // Nothing was kept, so nothing may be reported as this install's identity.
    expect(store.values.size).toBe(0);

    store.heal();
    const id = await resolver.installationId(ORIGIN);
    expect(store.values.get(installationIdKey(ORIGIN))).toBe(id);
  });

  it("uses the injected generator, which is how a build without crypto fails loudly", async () => {
    const store = testStorage();
    const resolver = createInstallationId({ storage: () => store.storage, generate: () => "generated-once" });

    await expect(resolver.installationId(ORIGIN)).resolves.toBe("generated-once");
    expect(store.values.get(installationIdKey(ORIGIN))).toBe("generated-once");
  });
});

describe("installationIdKey", () => {
  it("keeps a key the device-token cleanup cannot claim", () => {
    const key = installationIdKey(ORIGIN);

    expect(key).toBe(`${INSTALLATION_ID_KEY_PREFIX}${ORIGIN}`);
    // `NativeCredentialPort.ready()` deletes only items it can attribute to a
    // forgotten Host; the id is not one of them, so it survives every launch.
    expect(hostIdFromKey(key)).toBeNull();
    expect(key.startsWith(DEVICE_TOKEN_KEY_PREFIX)).toBe(false);
  });
});

describe("installation storage adapters", () => {
  it("writes and reads through the platform secure store", async () => {
    const secure = createMemorySecureStore();
    const storage = secureStoreInstallationStorage(secure);

    await storage.write(installationIdKey(ORIGIN), "id-from-keychain");

    expect(await storage.read(installationIdKey(ORIGIN))).toBe("id-from-keychain");
    expect(secure.entries()).toEqual({ [installationIdKey(ORIGIN)]: "id-from-keychain" });
  });

  it("writes and reads through the browser's registry storage slice", async () => {
    const slice = createMemoryStorage();
    const storage = registryInstallationStorage(slice);

    await storage.write(installationIdKey(ORIGIN), "id-from-localstorage");

    expect(await storage.read(installationIdKey(ORIGIN))).toBe("id-from-localstorage");
    expect(slice.getItem(installationIdKey(ORIGIN))).toBe("id-from-localstorage");
  });

  it("reads the browser's localStorage at call time", async () => {
    const values = new Map<string, string>();
    const fake = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fake });
    try {
      const resolver = createInstallationId({ storage: browserInstallationStorage });
      const id = await resolver.installationId(ORIGIN);
      expect(values.get(installationIdKey(ORIGIN))).toBe(id);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("reports a browser that blocks storage instead of inventing an id", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      await expect(browserInstallationStorage().read(installationIdKey(ORIGIN))).rejects.toThrow(
        /blocked its local storage: SecurityError/,
      );
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }

    // Node has no `localStorage` either, and says so rather than minting an id
    // that no restart could keep.
    await expect(browserInstallationStorage().write(installationIdKey(ORIGIN), "x")).rejects.toThrow(/local storage/);
  });
});

describe("installationIdFailure", () => {
  it("is a storage failure the screens can name", () => {
    expect(installationIdFailure(new Error("the Keychain is locked"))).toEqual({
      code: "STORAGE_FAILED",
      message: "the Keychain is locked",
      retriable: false,
    });
    expect(installationIdFailure("quota").message).toBe("quota");
  });
});