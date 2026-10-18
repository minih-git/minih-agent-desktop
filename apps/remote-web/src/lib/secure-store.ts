/**
 * `SecureStore` — the tiny async key/value port the native credential port
 * needs (PR-5).
 *
 * The port exists so the credential logic is unit-tested against an in-memory
 * fake and the plugin adapter stays a thin file (`native-secure-store.ts`).
 * The values are device tokens: nothing here logs, prints, or returns a token
 * to a caller that is not the credential port.
 */

export type SecureStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

/**
 * One item per paired Host. The prefix keeps this client's items apart from
 * anything else an app might keep in the same Keychain / Keystore.
 */
export const DEVICE_TOKEN_KEY_PREFIX = "device-token.";

export function deviceTokenKey(hostId: string): string {
  return `${DEVICE_TOKEN_KEY_PREFIX}${hostId}`;
}

/** The host id a stored key belongs to, or null for an item this client did not write. */
export function hostIdFromKey(key: string): string | null {
  if (!key.startsWith(DEVICE_TOKEN_KEY_PREFIX)) return null;
  const hostId = key.slice(DEVICE_TOKEN_KEY_PREFIX.length);
  return hostId ? hostId : null;
}

export type MemorySecureStore = SecureStore & {
  /** Every stored item, for assertions in tests. */
  entries(): Record<string, string>;
  /** Make each later `set` reject, so the storage-failure path is testable. */
  failWrites(error: Error): void;
};

/** The test / preview stand-in for the platform secure store. Never ships in a native build. */
export function createMemorySecureStore(initial: Record<string, string> = {}): MemorySecureStore {
  const values = new Map<string, string>(Object.entries(initial));
  let writeFailure: Error | null = null;
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      if (writeFailure) throw writeFailure;
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
    keys: async () => [...values.keys()],
    entries: () => Object.fromEntries(values),
    failWrites: (error) => {
      writeFailure = error;
    },
  };
}
