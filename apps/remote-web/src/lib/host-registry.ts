/**
 * Local host registry (ADR 0331 §3.4, PR-4).
 *
 * The browser remembers, per paired Host, only what it needs to talk to that
 * Host again: the host id, the device label, the device id, the CSRF token and
 * the pairing time. The device token itself is an `HttpOnly` cookie the
 * Gateway set and JavaScript can never read (security §3.1), and the pairing
 * token is never stored at all — so a hostile script that reads
 * `localStorage` learns nothing that authenticates a request.
 */

export const HOST_REGISTRY_STORAGE_KEY = "minih.remote-web.hosts.v1";

export type HostRegistryEntry = {
  hostId: string;
  label: string;
  deviceId: string;
  csrfToken: string;
  pairedAt: string;
};

/** The slice of `Storage` the registry needs, so tests can pass a plain map. */
export type RegistryStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type HostRegistry = {
  list(): HostRegistryEntry[];
  get(hostId: string): HostRegistryEntry | undefined;
  save(entry: HostRegistryEntry): void;
  forget(hostId: string): void;
  /** Notify on every mutation; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
};

export function createMemoryStorage(initial: Record<string, string> = {}): RegistryStorage {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEntry(value: unknown): HostRegistryEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { hostId, label, deviceId, csrfToken, pairedAt } = value;
  if (typeof hostId !== "string" || !hostId) return undefined;
  if (typeof csrfToken !== "string" || !csrfToken) return undefined;
  return {
    hostId,
    label: typeof label === "string" && label ? label : hostId,
    deviceId: typeof deviceId === "string" ? deviceId : "",
    csrfToken,
    pairedAt: typeof pairedAt === "string" ? pairedAt : "",
  };
}

/**
 * Read the persisted registry. A malformed payload yields the entries it can
 * still prove; unknown fields (including a device token written by an older or
 * foreign build) are dropped rather than carried forward.
 */
export function parseRegistry(raw: string | null): HostRegistryEntry[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const entries: HostRegistryEntry[] = [];
  for (const candidate of value) {
    const entry = toEntry(candidate);
    if (entry && !entries.some((existing) => existing.hostId === entry.hostId)) entries.push(entry);
  }
  return entries;
}

export function serializeRegistry(entries: readonly HostRegistryEntry[]): string {
  return JSON.stringify(entries.map((entry) => toEntry(entry) ?? entry));
}

export function createHostRegistry(storage: RegistryStorage): HostRegistry {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const read = (): HostRegistryEntry[] => parseRegistry(storage.getItem(HOST_REGISTRY_STORAGE_KEY));
  const write = (entries: readonly HostRegistryEntry[]): void => {
    storage.setItem(HOST_REGISTRY_STORAGE_KEY, serializeRegistry(entries));
    notify();
  };

  return {
    list: read,
    get: (hostId) => read().find((entry) => entry.hostId === hostId),
    save: (entry) => {
      const normalized = toEntry(entry);
      if (!normalized) return;
      const entries = read().filter((existing) => existing.hostId !== normalized.hostId);
      write([...entries, normalized]);
    },
    forget: (hostId) => {
      write(read().filter((entry) => entry.hostId !== hostId));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
