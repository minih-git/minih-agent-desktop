/**
 * The installation identity a device replacement is recognised by.
 *
 * The Gateway has to know which install is asking for a device, because one
 * approval replaces that install's previous device record instead of leaving it
 * behind (`device-grant-identity`). The identity authorises nothing: it never
 * stands in for a credential, and only accompanies the two requests that create
 * a device; the approving Host signs its correlation with the approved grant.
 *
 * One id per Gateway origin, generated once and kept for as long as this
 * install's storage exists. Forgetting a Host, signing out, and the orphan
 * cleanup `ready()` runs all leave it alone: a new id would make the next
 * approval create a second device row for the same install instead of replacing
 * the first.
 *
 * A storage failure is reported, never papered over with a fresh id. A caller
 * that cannot read or write the id must not send the request at all, so the
 * failure surfaces as `STORAGE_FAILED` (`installationIdFailure`) rather than as
 * a silently different identity.
 */
import type { OperationFailure } from "./errors.js";
import type { RegistryStorage } from "./host-registry.js";
import type { SecureStore } from "./secure-store.js";

/**
 * Its own prefix: the reconciler in `NativeCredentialPort.ready()` only touches
 * `device-token.*` items, so the installation id outlives a forgotten Host.
 */
export const INSTALLATION_ID_KEY_PREFIX = "installation-id.";

/** One record per Gateway origin: the same install is a different device there. */
export function installationIdKey(gatewayOrigin: string): string {
  return `${INSTALLATION_ID_KEY_PREFIX}${gatewayOrigin}`;
}

/**
 * The slice of a key/value store the installation id needs.
 *
 * Both concrete stores are behind async methods, so a platform store that
 * refuses a write (a locked Keychain) is a rejection here instead of a `throw`
 * that skips the caller's error path.
 */
export type InstallationIdStorage = {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
};

/** Read `globalThis.localStorage` on every call: a blocked store must fail, not be cached. */
export function browserInstallationStorage(): InstallationIdStorage {
  return {
    read: async (key) => requireLocalStorage().getItem(key),
    write: async (key, value) => {
      requireLocalStorage().setItem(key, value);
    },
  };
}

/** The browser store, or the reason this install cannot have an identity. */
function requireLocalStorage(): RegistryStorage {
  try {
    const storage = globalThis.localStorage;
    if (storage) return storage;
  } catch (error) {
    // A browser that blocks storage throws on the property itself.
    throw new Error(`this browser blocked its local storage: ${messageOf(error)}`);
  }
  throw new Error("this browser keeps no local storage, so the installation id cannot be stored");
}

/** The host registry's storage slice, reused as the browser's installation store. */
export function registryInstallationStorage(storage: RegistryStorage): InstallationIdStorage {
  return {
    read: async (key) => storage.getItem(key),
    write: async (key, value) => {
      storage.setItem(key, value);
    },
  };
}

/** The platform secure store (Keychain / Keystore) as the native install's store. */
export function secureStoreInstallationStorage(store: SecureStore): InstallationIdStorage {
  return {
    read: (key) => store.get(key),
    write: (key, value) => store.set(key, value),
  };
}

/** `crypto.randomUUID()`; a runtime without it cannot mint an identity at all. */
function randomId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("this runtime cannot generate a random installation id");
  return id;
}

export type InstallationIdOptions = {
  /**
   * Resolved on every first call, so a port can hand over a store that is only
   * attached later (a native port's Keychain adapter).
   */
  storage: () => InstallationIdStorage;
  /** Test seam; the default is `crypto.randomUUID()`. */
  generate?: () => string;
};

export type InstallationIdResolver = {
  /**
   * This install's id at that Gateway. Concurrent callers share one read (and
   * one write), so two requests started from two screens cannot mint two ids.
   */
  installationId(gatewayOrigin: string): Promise<string>;
};

export function createInstallationId(options: InstallationIdOptions): InstallationIdResolver {
  const generate = options.generate ?? randomId;
  const known = new Map<string, Promise<string>>();
  return {
    installationId(gatewayOrigin) {
      const existing = known.get(gatewayOrigin);
      if (existing) return existing;
      const pending = (async () => {
        const key = installationIdKey(gatewayOrigin);
        const storage = options.storage();
        const stored = await storage.read(key);
        if (stored) return stored;
        const created = generate();
        await storage.write(key, created);
        return created;
      })();
      known.set(gatewayOrigin, pending);
      // A failure is not remembered: the id counts as known only once it is
      // actually persisted, so the next attempt reads and writes again.
      pending.catch(() => {
        known.delete(gatewayOrigin);
      });
      return pending;
    },
  };
}

/**
 * The failure a caller reports when the installation id cannot be read or
 * written. `STORAGE_FAILED` (with its catalog reason) and never a fresh id:
 * asking again under a different identity would orphan the previous device row.
 */
export function installationIdFailure(error: unknown): OperationFailure {
  return { code: "STORAGE_FAILED", message: messageOf(error), retriable: false };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}