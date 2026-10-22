/**
 * Local host registry (ADR 0331 §3.4, PR-4 / PR-5).
 *
 * The client remembers, per paired Host, only what it needs to talk to that
 * Host again: the host id, the device label, the device id and the pairing
 * time. In the browser the device token is an `HttpOnly` cookie the Gateway
 * set and JavaScript can never read (security §3.1), so the entry also carries
 * the CSRF token; a native build keeps the device token in the Keychain /
 * Keystore and the entry carries no credential at all. The pairing token is
 * never stored — so a hostile script that reads `localStorage` learns nothing
 * that authenticates a request.
 *
 * The storage key stays `minih.remote-web.hosts.v1`: a web entry written by
 * PR-4 parses and re-serializes byte-for-byte, and an entry without a CSRF
 * token is still a valid entry (it simply yields no credential to the browser
 * port).
 */

export const HOST_REGISTRY_STORAGE_KEY = "minih.remote-web.hosts.v1";

/**
 * Which credential profile paired a Host. Absent on a v1 web entry, which is
 * always the cookie profile; `"native"` means the device token lives in the
 * platform secure store instead.
 */
export type CredentialProfile = "cookie" | "native";

export type HostRegistryEntry = {
  hostId: string;
  label: string;
  deviceId: string;
  /** Cookie profile only: the value of the `x-csrf-token` header. */
  csrfToken?: string;
  pairedAt: string;
  /** Absent for the cookie profile, so a v1 web entry round-trips unchanged. */
  profile?: CredentialProfile;
  /**
   * Account mode only (§11.5): this Host announced no
   * `device.accept-sibling-grant`, so it confirms every device with its own
   * user and will never adopt the device this client already holds. Asking
   * again and approving on that computer is the only way to reach it; a refresh
   * cannot help, and the Hosts screen says so.
   */
  requiresOwnConfirmation?: boolean;
  /**
   * The roles the Gateway granted this device (§11.4): `viewer`,
   * `controller`, `approver`. Recorded so a screen can tell "this device may
   * create sessions" from "it may only read" without a round trip. Absent on an
   * entry written before the field existed, which is treated as unknown rather
   * than as "no controller".
   */
  roles?: string[];
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

/**
 * Normalize one entry. Fields are composed in the order PR-4 wrote them, so a
 * web entry serializes to exactly the bytes it was read from; a token written
 * by a foreign build is dropped rather than carried forward.
 */
function toEntry(value: unknown): HostRegistryEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { hostId, label, deviceId, csrfToken, pairedAt, profile, requiresOwnConfirmation, roles } = value;
  if (typeof hostId !== "string" || !hostId) return undefined;
  const native = profile === "native";
  // A native entry keeps its device token in the Keychain / Keystore and has no
  // CSRF credential, so a browser's CSRF value is dropped rather than stored.
  const csrf = !native && typeof csrfToken === "string" && csrfToken ? csrfToken : undefined;
  const entry: HostRegistryEntry = {
    hostId,
    label: typeof label === "string" && label ? label : hostId,
    deviceId: typeof deviceId === "string" ? deviceId : "",
    ...(csrf ? { csrfToken: csrf } : {}),
    pairedAt: typeof pairedAt === "string" ? pairedAt : "",
    ...(profile === "native" ? { profile: "native" as const } : {}),
    // Written last, and only when true, so an entry from an earlier build
    // serializes to exactly the bytes it was read from.
    ...(requiresOwnConfirmation === true ? { requiresOwnConfirmation: true as const } : {}),
    // Same rule: written only when present and non-empty, so an entry that
    // never had roles round-trips unchanged.
    ...(Array.isArray(roles) && roles.some((role) => typeof role === "string" && role)
      ? { roles: roles.filter((role): role is string => typeof role === "string" && role.length > 0) }
      : {}),
  };
  return entry;
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

/**
 * Whether this device holds at least one computer right now.
 *
 * The launch rule asks this before any screen runs, so it reads the stored
 * registry rather than the hook. Counting parsed entries matters: forgetting the
 * last computer leaves `"[]"` behind, and a stored-but-empty registry is not an
 * installation that has computers.
 */
export function registryHasHosts(storage: RegistryStorage): boolean {
  try {
    return parseRegistry(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).length > 0;
  } catch {
    // A blocked store is indistinguishable from an empty one here, and the
    // launch rule treats both as a fresh install.
    return false;
  }
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

/** Which next step a Host that has not adopted this device leaves the user. */
export type UnacceptedNextStep =
  /** It requires its own confirmation: ask for a device again, approve there. */
  | "own-confirmation"
  /** It has simply not caught up yet: refreshing may be enough. */
  | "retry";

/**
 * What a Host that has not adopted this device needs (protocol §11.5). A Host
 * that announced no `device.accept-sibling-grant` refuses every sibling grant
 * for good, so no refresh will ever make it ready — the user has to ask for a
 * device again and approve it on that computer. Every other unready Host is one
 * that has not caught up yet, and a retry can fix it.
 */
export function unacceptedNextStep(entry: HostRegistryEntry): UnacceptedNextStep {
  return entry.requiresOwnConfirmation === true ? "own-confirmation" : "retry";
}
