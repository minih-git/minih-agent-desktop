import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";

import {
  HOST_CACHE_INDEX_KEY,
  HOST_CACHE_PREFIX,
  MAX_TIMELINE_ROWS,
  cacheScope,
  createHostCache,
  type CacheScope,
} from "./host-cache.js";
import { createMemoryStorage, type RegistryStorage } from "./host-registry.js";
import type { TimelineItem } from "./timeline-types.js";

/**
 * The cached first paint (`lib/host-cache.ts`).
 *
 * What matters here is not that a value round-trips — it is that the cache stays
 * inside four rules: it is keyed per device and Host, it never holds a
 * credential, it is bounded, and it forgets what it is told to forget. Each test
 * below pins one of them.
 */
function session(id: string, projectId?: string): RacpSession {
  return {
    id,
    title: `Session ${id}`,
    mode: "agent",
    status: "idle",
    planningState: "inactive",
    permissionMode: "ask",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-10-21T09:00:00.000Z",
    updatedAt: "2026-10-21T09:30:00.000Z",
    ...(projectId ? { projectId } : {}),
  };
}

function project(id: string): RacpProjectSummary {
  return { id, label: `Project ${id}`, archived: false };
}

function item(id: string, text = `Row ${id}`): TimelineItem {
  return { id, turnId: "turn_1", itemType: "message", status: "completed", text };
}

/** A storage that counts what it is asked to keep, so "bounded" is measurable. */
function storage(): RegistryStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const SCOPE: CacheScope = { deviceId: "dev_a", hostId: "host_a" };

describe("cacheScope", () => {
  it("needs both halves, so an unrecorded device caches nothing", () => {
    expect(cacheScope("dev_a", "host_a")).toEqual({ deviceId: "dev_a", hostId: "host_a" });
    expect(cacheScope(undefined, "host_a")).toBeNull();
    expect(cacheScope("dev_a", "")).toBeNull();
  });
});

describe("the catalog answer", () => {
  it("reads back the sessions and the projects of one Host", () => {
    const cache = createHostCache(storage());
    cache.writeSessions(SCOPE, [session("s1", "p1"), session("s2")]);
    cache.writeProjects(SCOPE, [project("p1")]);

    const catalog = cache.readCatalog(SCOPE);
    expect(catalog?.sessions?.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    expect(catalog?.projects?.map((entry) => entry.id)).toEqual(["p1"]);
    expect(catalog?.sessionsFetchedAt).toBeTruthy();
    expect(catalog?.projectsFetchedAt).toBeTruthy();
  });

  it("keeps the half a failed read did not replace", () => {
    const cache = createHostCache(storage());
    cache.writeSessions(SCOPE, [session("s1")]);
    cache.writeProjects(SCOPE, [project("p1")]);
    // A later visit whose `project/list` failed writes only the sessions.
    cache.writeSessions(SCOPE, [session("s2")]);

    const catalog = cache.readCatalog(SCOPE);
    expect(catalog?.sessions?.map((entry) => entry.id)).toEqual(["s2"]);
    expect(catalog?.projects?.map((entry) => entry.id)).toEqual(["p1"]);
  });

  it("is unreadable from another device or another Host", () => {
    const cache = createHostCache(storage());
    cache.writeSessions(SCOPE, [session("s1")]);

    expect(cache.readCatalog({ deviceId: "dev_b", hostId: "host_a" })).toBeNull();
    expect(cache.readCatalog({ deviceId: "dev_a", hostId: "host_b" })).toBeNull();
  });

  it("holds no credential", () => {
    const store = storage();
    const cache = createHostCache(store);
    // The strings a credential would appear as, if anything copied one.
    const secrets = ["pdt_secret_token", "csrf_secret_value", "mpt1:pairing:ticket"];
    cache.writeSessions(SCOPE, [session("s1", "p1")]);
    cache.writeProjects(SCOPE, [project("p1")]);
    cache.writeTimeline(SCOPE, "s1", [item("i1")]);

    for (const value of store.values.values()) {
      for (const secret of secrets) expect(value).not.toContain(secret);
    }
    // And the records only name the device and the Host, never a way in.
    for (const entry of store.values.values()) {
      expect(entry).not.toMatch(/token|csrf|authorization/i);
    }
  });
});

describe("a cached timeline", () => {
  it("keeps the newest rows, because the first paint opens on the last one", () => {
    const cache = createHostCache(storage());
    const rows = Array.from({ length: MAX_TIMELINE_ROWS + 10 }, (_, index) => item(`i${index}`));
    cache.writeTimeline(SCOPE, "s1", rows);

    const cached = cache.readTimeline(SCOPE, "s1");
    expect(cached?.items).toHaveLength(MAX_TIMELINE_ROWS);
    expect(cached?.items[0]?.id).toBe("i10");
    expect(cached?.items.at(-1)?.id).toBe(`i${MAX_TIMELINE_ROWS + 9}`);
  });

  it("drops the oldest rows until the record fits its byte budget", () => {
    const cache = createHostCache(storage(), { maxTimelineChars: 400 });
    cache.writeTimeline(SCOPE, "s1", [item("i1", "a".repeat(200)), item("i2", "b".repeat(200))]);

    const cached = cache.readTimeline(SCOPE, "s1");
    expect(cached?.items.map((row) => row.id)).toEqual(["i2"]);
  });

  it("stores no cursor, so a cached visit can never resume a stream", () => {
    const store = storage();
    const cache = createHostCache(store);
    cache.writeTimeline(SCOPE, "s1", [item("i1")]);

    const stored = [...store.values.entries()].find(([key]) => key.includes(".timeline."));
    expect(stored).toBeDefined();
    const record = JSON.parse(stored![1]) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(
      ["deviceId", "fetchedAt", "hostId", "items", "lastUsedAt", "sessionId", "version"].sort(),
    );
  });

  it("is per session", () => {
    const cache = createHostCache(storage());
    cache.writeTimeline(SCOPE, "s1", [item("i1")]);
    expect(cache.readTimeline(SCOPE, "s2")).toBeNull();
  });
});

describe("bounds and repair", () => {
  it("evicts the least recently written record once the budget is exceeded", () => {
    let clock = 1_000;
    const cache = createHostCache(storage(), { maxChars: 900, now: () => (clock += 1_000) });
    cache.writeSessions({ deviceId: "dev_a", hostId: "host_1" }, [session("s1")]);
    cache.writeSessions({ deviceId: "dev_a", hostId: "host_2" }, [session("s2")]);
    cache.writeSessions({ deviceId: "dev_a", hostId: "host_3" }, [session("s3")]);

    expect(cache.readCatalog({ deviceId: "dev_a", hostId: "host_3" })).not.toBeNull();
    expect(cache.readCatalog({ deviceId: "dev_a", hostId: "host_1" })).toBeNull();
  });

  it("reads a hand-edited record as no cache instead of as another Host", () => {
    const store = storage();
    const cache = createHostCache(store);
    cache.writeSessions(SCOPE, [session("s1")]);
    const key = [...store.values.keys()].find((entry) => entry.includes(".catalog."))!;

    store.values.set(key, "{ not json");
    expect(cache.readCatalog(SCOPE)).toBeNull();

    // A record whose device does not match what was asked for is refused too.
    store.values.set(key, JSON.stringify({ version: 1, deviceId: "dev_b", hostId: "host_a", sessions: [session("s9")] }));
    expect(cache.readCatalog(SCOPE)).toBeNull();
  });

  it("survives a storage that refuses to write", () => {
    const cache = createHostCache({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    });
    expect(() => cache.writeSessions(SCOPE, [session("s1")])).not.toThrow();
    expect(cache.readCatalog(SCOPE)).toBeNull();
  });
});

describe("clearing", () => {
  function seeded() {
    const store = storage();
    const cache = createHostCache(store);
    cache.writeSessions({ deviceId: "dev_a", hostId: "host_1" }, [session("s1")]);
    cache.writeTimeline({ deviceId: "dev_a", hostId: "host_1" }, "s1", [item("i1")]);
    cache.writeSessions({ deviceId: "dev_a", hostId: "host_2" }, [session("s2")]);
    cache.writeSessions({ deviceId: "dev_b", hostId: "host_3" }, [session("s3")]);
    return { store, cache };
  }

  it("drops one Host, its timeline included", () => {
    const { cache } = seeded();
    cache.forgetHost("host_1");

    expect(cache.readCatalog({ deviceId: "dev_a", hostId: "host_1" })).toBeNull();
    expect(cache.readTimeline({ deviceId: "dev_a", hostId: "host_1" }, "s1")).toBeNull();
    expect(cache.readCatalog({ deviceId: "dev_a", hostId: "host_2" })).not.toBeNull();
  });

  it("drops every Host of one device, which is what a new grant replaces", () => {
    const { cache } = seeded();
    cache.forgetDevice("dev_a");

    expect(cache.readCatalog({ deviceId: "dev_a", hostId: "host_1" })).toBeNull();
    expect(cache.readCatalog({ deviceId: "dev_a", hostId: "host_2" })).toBeNull();
    expect(cache.readCatalog({ deviceId: "dev_b", hostId: "host_3" })).not.toBeNull();
  });

  it("drops everything, and leaves no index behind", () => {
    const { store, cache } = seeded();
    cache.forgetAll();

    expect([...store.values.keys()]).toEqual([HOST_CACHE_INDEX_KEY]);
    expect(createHostCache(store).readCatalog({ deviceId: "dev_b", hostId: "host_3" })).toBeNull();
  });
});

describe("the index", () => {
  it("names every record it holds, and nothing that reads as a credential", () => {
    const store = storage();
    const cache = createHostCache(store);
    cache.writeSessions(SCOPE, [session("s1")]);
    cache.writeTimeline(SCOPE, "s1", [item("i1")]);

    const index = JSON.parse(store.values.get(HOST_CACHE_INDEX_KEY)!);
    expect(index.entries.map((entry: { kind: string }) => entry.kind).sort()).toEqual(["catalog", "timeline"]);
    for (const key of store.values.keys()) expect(key.startsWith(HOST_CACHE_PREFIX)).toBe(true);
    expect(createMemoryStorage().getItem(HOST_CACHE_INDEX_KEY)).toBeNull();
  });
});