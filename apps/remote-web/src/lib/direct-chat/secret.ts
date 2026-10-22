/**
 * The direct-chat AccessKey, kept in the platform secure store (ADR
 * mobile-direct-gateway-chat §2).
 *
 * Three rules decide this file's shape:
 *
 * - The key lives under its own prefix, never `device-token.*`. The remote
 *   credential port reconciles that other prefix on every launch and deletes
 *   items with no registry entry (`NativeCredentialPort.ready`), so a key stored
 *   there would be deleted as an orphan. The prefix is also what keeps the two
 *   secrets from ever being mistaken for each other: a device token cannot call
 *   the model API and this key cannot call the Gateway.
 * - Nothing here reads the key back into the app's state, a URL, a log, or
 *   `localStorage`. `read` exists only so a request can be built; the caller
 *   passes it straight into a header and drops it.
 * - Unlinking is a delete. There is no "revoke" call to make: the key belongs to
 *   the user's account, not to this app.
 *
 * The store is the existing `SecureStore` port, so this module is unit-tested
 * against the in-memory fake and the plugin adapter stays untouched.
 */
import type { SecureStore } from "../secure-store.js";

/**
 * One connected model account, so one item. A per-account key would be dead
 * weight while the first release exposes a single connection at a time.
 */
export const DIRECT_CHAT_KEY_ITEM = "direct-chat.access-key.v1";

/** Whether a stored key belongs to direct chat; the other prefix is not ours. */
export function isDirectChatKeyItem(key: string): boolean {
  return key === DIRECT_CHAT_KEY_ITEM;
}

export type DirectChatSecret = {
  /** The AccessKey itself. Only a request builder may hold this. */
  read(): Promise<string | null>;
  /** Store a verified key, replacing any earlier one. */
  write(key: string): Promise<void>;
  /** Unlink: remove the secret. Idempotent. */
  remove(): Promise<void>;
  /** Whether a key is stored, without reading its value. */
  exists(): Promise<boolean>;
};

export function createDirectChatSecret(store: SecureStore): DirectChatSecret {
  return {
    async read() {
      const value = await store.get(DIRECT_CHAT_KEY_ITEM);
      const trimmed = (value ?? "").trim();
      return trimmed ? trimmed : null;
    },
    async write(key) {
      const trimmed = key.trim();
      if (!trimmed) throw new Error("an AccessKey cannot be empty");
      await store.set(DIRECT_CHAT_KEY_ITEM, trimmed);
    },
    async remove() {
      await store.remove(DIRECT_CHAT_KEY_ITEM);
    },
    async exists() {
      const value = await store.get(DIRECT_CHAT_KEY_ITEM);
      return Boolean((value ?? "").trim());
    },
  };
}

/**
 * The store a direct-chat secret uses in each build.
 *
 * A native build has the platform store attached by `boot()`. The browser build
 * has no Keychain and, by the ADR, no direct chat at all, so it gets an empty
 * store rather than a `localStorage`-backed one: writing an AccessKey into
 * `localStorage` is exactly what the decision forbids, and a stub that refuses
 * is better than one that silently degrades.
 */
export function createUnavailableSecretStore(): SecureStore {
  const message = "direct chat has no secure store in this build";
  return {
    get: async () => null,
    set: async () => {
      throw new Error(message);
    },
    remove: async () => {},
    keys: async () => [],
  };
}
