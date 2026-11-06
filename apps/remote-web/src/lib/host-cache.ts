/**
 * The last answer of each host-scoped read, kept so a phone can paint before the
 * Gateway answers.
 *
 * Measured on a real phone, every command costs 300–400 ms: the phone reaches a
 * Gateway on another continent and the Gateway reaches the computer, and the
 * computer itself answers in 1–4 ms. Opening a project list used to mean a
 * blank screen for two of those round trips. The cache below stores the last
 * successful `session/list`, `project/list`, and session snapshot per
 * *(device, host)* so the screen renders that immediately and replaces it when
 * the real answer arrives.
 *
 * Three rules shape this module:
 *
 * - **The cache is never the source of truth.** It is read on mount only; every
 *   successful live answer overwrites it, and nothing here ever feeds a stream
 *   cursor. A session snapshot is displayed until `session/attach` returns, and
 *   then discarded (`cached-view.ts`).
 * - **No credential, ever.** The records hold session and project summaries and
 *   timeline rows. `host-cache.test.ts` scans the storage this module writes and
 *   fails if a device token, a CSRF token, or a pairing ticket appears in it.
 * - **Bounded.** Rows per timeline, size per record, and a total budget with
 *   least-recently-written eviction, because a phone's storage quota is small
 *   and a full quota breaks the rest of the app, not just this cache.
 *
 * Storage is the `localStorage`-shaped port the host registry already uses
 * (`RegistryStorage`), so the rules are tested against a plain map and the
 * browser adapter is the only part that needs a browser.
 */
import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";

import type { RegistryStorage } from "./host-registry.js";
import type { TimelineItem } from "./timeline-types.js";

/** Namespace of every key this module writes. */
export const HOST_CACHE_PREFIX = "minih.remote-web.cache.v1";
/** The bookkeeping key: one entry per record, for eviction and clearing. */
export const HOST_CACHE_INDEX_KEY = `${HOST_CACHE_PREFIX}.index`;

/**
 * Total serialized size this cache may occupy, in characters (a `localStorage`
 * value is measured in UTF-16 code units, so this is roughly half as many
 * bytes). Deliberately far below any browser's quota: the registry, the session
 * views, and the gateway history share the same store, and a cache that fills it
 * breaks them first.
 */
export const MAX_CACHE_CHARS = 1_200_000;

/** The tail of a conversation a cached first paint needs, not the transcript. */
export const MAX_TIMELINE_ROWS = 30;

/** One cached timeline never costs more than this, however long its rows are. */
export const MAX_TIMELINE_CHARS = 80_000;

/**
 * Which device, on which Host. An account device is one `deviceId` on every
 * Host of the account, so this pair is exactly "this phone's view of this
 * computer", and a second phone (or a second account) can never read it.
 */
export type CacheScope = { deviceId: string; hostId: string };

/** The scope for one host, or `null` when the device id is not known yet. */
export function cacheScope(
  deviceId: string | null | undefined,
  hostId: string | null | undefined,
): CacheScope | null {
  if (!deviceId || !hostId) return null;
  return { deviceId, hostId };
}

/** The `project/list` and `session/list` answer last read from one Host. */
export type CachedCatalog = {
  version: 1;
  deviceId: string;
  hostId: string;
  sessions?: RacpSession[];
  sessionsFetchedAt?: string;
  projects?: RacpProjectSummary[];
  projectsFetchedAt?: string;
  /** When this record was last written; the eviction order reads it. */
  lastUsedAt: string;
};

/** The rows a session screen may show before `session/attach` answers. */
export type CachedTimeline = {
  version: 1;
  deviceId: string;
  hostId: string;
  sessionId: string;
  items: TimelineItem[];
  fetchedAt: string;
  lastUsedAt: string;
};

/** What a cached timeline read returns: rows and when the Host sent them. */
export type CachedTimelineView = { items: TimelineItem[]; fetchedAt: string };

type IndexEntry = {
  key: string;
  kind: "catalog" | "timeline";
  deviceId: string;
  hostId: string;
  sessionId?: string;
  chars: number;
  /** Epoch milliseconds, so eviction does not have to parse a date. */
  writtenAt: number;
};

export type HostCacheOptions = {
  now?: () => number;
  maxChars?: number;
  maxTimelineRows?: number;
  maxTimelineChars?: number;
};

export type HostCache = {
  readCatalog(scope: CacheScope | null): CachedCatalog | null;
  writeSessions(scope: CacheScope | null, sessions: RacpSession[]): void;
  writeProjects(scope: CacheScope | null, projects: RacpProjectSummary[]): void;
  readTimeline(scope: CacheScope | null, sessionId: string): CachedTimelineView | null;
  writeTimeline(scope: CacheScope | null, sessionId: string, items: TimelineItem[]): void;
  /** Drop everything cached for one Host (forgotten, or its device was revoked). */
  forgetHost(hostId: string): void;
  /** Drop everything cached for one device (the account issued a new one). */
  forgetDevice(deviceId: string): void;
  /** Drop the whole cache (sign-out, a reset). */
  forgetAll(): void;
};

function catalogKey(scope: CacheScope): string {
  return `${HOST_CACHE_PREFIX}.catalog.${encodeURIComponent(scope.deviceId)}.${encodeURIComponent(scope.hostId)}`;
}

function timelineKey(scope: CacheScope, sessionId: string): string {
  return `${HOST_CACHE_PREFIX}.timeline.${encodeURIComponent(scope.deviceId)}.${encodeURIComponent(scope.hostId)}.${encodeURIComponent(sessionId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSession(value: unknown): value is RacpSession {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

function isProject(value: unknown): value is RacpProjectSummary {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

/**
 * A cached row, or nothing. A row without an id or a type cannot be rendered, so
 * it is dropped rather than allowed to break the first paint it exists for.
 */
function isTimelineItem(value: unknown): value is TimelineItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.itemType === "string" &&
    value.itemType.length > 0
  );
}

/**
 * Keep the newest rows that fit both caps.
 *
 * The tail is what a first paint needs — a conversation opens on its newest row —
 * so rows are dropped from the oldest end, which is also the end
 * `session/history` can reload from the Host.
 */
function boundRows(
  items: readonly TimelineItem[],
  maxRows: number,
  maxChars: number,
): TimelineItem[] {
  let rows = items.slice(Math.max(0, items.length - maxRows));
  // A tool result can be tens of kilobytes: keep dropping the oldest row until
  // the record is small enough, and give up (store nothing) if even one row is.
  while (rows.length > 0 && JSON.stringify(rows).length > maxChars) {
    rows = rows.slice(1);
  }
  return rows;
}

/**
 * The cache, over one storage port.
 *
 * Every write is one record plus the index; every read validates the record it
 * finds against the scope it was asked for, so a hand-edited or half-written
 * value reads as "no cache" instead of as somebody else's Host.
 */
export function createHostCache(storage: RegistryStorage, options: HostCacheOptions = {}): HostCache {
  const now = options.now ?? (() => Date.now());
  const maxChars = options.maxChars ?? MAX_CACHE_CHARS;
  const maxTimelineRows = options.maxTimelineRows ?? MAX_TIMELINE_ROWS;
  const maxTimelineChars = options.maxTimelineChars ?? MAX_TIMELINE_CHARS;

  const readIndex = (): IndexEntry[] => {
    const raw = storage.getItem(HOST_CACHE_INDEX_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed["entries"])) return [];
      return parsed["entries"].filter(
        (entry): entry is IndexEntry =>
          isRecord(entry) && typeof entry["key"] === "string" && typeof entry["chars"] === "number",
      );
    } catch {
      return [];
    }
  };

  const writeIndex = (entries: readonly IndexEntry[]): void => {
    try {
      storage.setItem(HOST_CACHE_INDEX_KEY, JSON.stringify({ entries }));
    } catch {
      // The index is bookkeeping: losing it costs eviction accuracy, not data.
    }
  };

  const remove = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      // A store that refuses a removal has nothing this cache can do about it.
    }
  };

  /** Remove every entry matching `match`, and forget it in the index. */
  const forget = (match: (entry: IndexEntry) => boolean): void => {
    const entries = readIndex();
    const keep: IndexEntry[] = [];
    for (const entry of entries) {
      if (match(entry)) remove(entry.key);
      else keep.push(entry);
    }
    writeIndex(keep);
  };

  /**
   * Store one record, evicting the oldest others until the budget fits.
   *
   * A record larger than the whole budget is not worth a slot; one the store
   * refuses (quota) is dropped and reported as a failed write rather than
   * retried in a loop, because the screens treat the cache as best-effort.
   */
  const store = (
    key: string,
    payload: unknown,
    entry: Omit<IndexEntry, "key" | "chars" | "writtenAt">,
  ): void => {
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch {
      return;
    }
    if (json.length > maxChars) return;

    let entries = readIndex().filter((existing) => existing.key !== key);
    entries.push({ key, chars: json.length, writtenAt: now(), ...entry });

    let total = entries.reduce((sum, item) => sum + item.chars, 0);
    while (total > maxChars && entries.length > 1) {
      // Least recently written first; never the record being written now.
      const victims = entries.filter((item) => item.key !== key);
      const oldest = victims.reduce((a, b) => (b.writtenAt < a.writtenAt ? b : a));
      remove(oldest.key);
      entries = entries.filter((item) => item.key !== oldest.key);
      total -= oldest.chars;
    }

    try {
      storage.setItem(key, json);
    } catch {
      // Quota or a read-only store: drop the record rather than leave the index
      // claiming a value that is not there.
      remove(key);
      writeIndex(entries.filter((item) => item.key !== key));
      return;
    }
    writeIndex(entries);
  };

  const read = <T>(key: string, accept: (value: unknown) => T | null): T | null => {
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
      return accept(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  };

  const readCatalog = (scope: CacheScope | null): CachedCatalog | null => {
    if (!scope) return null;
    return read(catalogKey(scope), (value) => {
      if (!isRecord(value)) return null;
      if (value["version"] !== 1) return null;
      if (value["deviceId"] !== scope.deviceId || value["hostId"] !== scope.hostId) return null;
      const sessions = Array.isArray(value["sessions"])
        ? value["sessions"].filter(isSession)
        : undefined;
      const projects = Array.isArray(value["projects"])
        ? value["projects"].filter(isProject)
        : undefined;
      if (!sessions && !projects) return null;
      return {
        version: 1,
        deviceId: scope.deviceId,
        hostId: scope.hostId,
        ...(sessions ? { sessions } : {}),
        ...(typeof value["sessionsFetchedAt"] === "string"
          ? { sessionsFetchedAt: value["sessionsFetchedAt"] }
          : {}),
        ...(projects ? { projects } : {}),
        ...(typeof value["projectsFetchedAt"] === "string"
          ? { projectsFetchedAt: value["projectsFetchedAt"] }
          : {}),
        lastUsedAt: typeof value["lastUsedAt"] === "string" ? value["lastUsedAt"] : new Date(now()).toISOString(),
      };
    });
  };

  /**
   * Write one half of the catalog answer, keeping the other half as it was: the
   * two lists are read by separate calls, and a failed `project/list` must not
   * wipe the projects a previous visit did read.
   */
  const writeCatalog = (
    scope: CacheScope | null,
    patch: { sessions?: RacpSession[]; projects?: RacpProjectSummary[] },
  ): void => {
    if (!scope) return;
    const previous = readCatalog(scope);
    const at = new Date(now()).toISOString();
    const sessions = patch.sessions ?? previous?.sessions;
    const projects = patch.projects ?? previous?.projects;
    if (!sessions && !projects) return;
    const record: CachedCatalog = {
      version: 1,
      deviceId: scope.deviceId,
      hostId: scope.hostId,
      ...(sessions ? { sessions } : {}),
      ...(sessions
        ? { sessionsFetchedAt: patch.sessions ? at : (previous?.sessionsFetchedAt ?? at) }
        : {}),
      ...(projects ? { projects } : {}),
      ...(projects
        ? { projectsFetchedAt: patch.projects ? at : (previous?.projectsFetchedAt ?? at) }
        : {}),
      lastUsedAt: at,
    };
    store(catalogKey(scope), record, {
      kind: "catalog",
      deviceId: scope.deviceId,
      hostId: scope.hostId,
    });
  };

  return {
    readCatalog,

    writeSessions(scope, sessions) {
      writeCatalog(scope, { sessions });
    },

    writeProjects(scope, projects) {
      writeCatalog(scope, { projects });
    },

    readTimeline(scope, sessionId) {
      if (!scope || !sessionId) return null;
      return read(timelineKey(scope, sessionId), (value) => {
        if (!isRecord(value)) return null;
        if (value["version"] !== 1) return null;
        if (value["deviceId"] !== scope.deviceId || value["hostId"] !== scope.hostId) return null;
        if (value["sessionId"] !== sessionId) return null;
        if (!Array.isArray(value["items"]) || typeof value["fetchedAt"] !== "string") return null;
        const items = value["items"].filter(isTimelineItem);
        if (items.length === 0) return null;
        return { items, fetchedAt: value["fetchedAt"] };
      });
    },

    writeTimeline(scope, sessionId, items) {
      if (!scope || !sessionId) return;
      const rows = boundRows(items, maxTimelineRows, maxTimelineChars);
      if (rows.length === 0) return;
      const at = new Date(now()).toISOString();
      const record: CachedTimeline = {
        version: 1,
        deviceId: scope.deviceId,
        hostId: scope.hostId,
        sessionId,
        items: rows,
        fetchedAt: at,
        lastUsedAt: at,
      };
      store(timelineKey(scope, sessionId), record, {
        kind: "timeline",
        deviceId: scope.deviceId,
        hostId: scope.hostId,
        sessionId,
      });
    },

    forgetHost(hostId) {
      forget((entry) => entry.hostId === hostId);
    },

    forgetDevice(deviceId) {
      forget((entry) => entry.deviceId === deviceId);
    },

    forgetAll() {
      forget(() => true);
    },
  };
}