import { describe, expect, it } from "vitest";

import {
  HOST_REGISTRY_STORAGE_KEY,
  createHostRegistry,
  createMemoryStorage,
  parseRegistry,
  serializeRegistry,
  type HostRegistryEntry,
} from "./host-registry.js";

const entry: HostRegistryEntry = {
  hostId: "host1",
  label: "Chrome on macOS",
  deviceId: "dev_1",
  csrfToken: "csrf-1",
  pairedAt: "2026-09-18T10:00:00.000Z",
};

describe("host registry", () => {
  it("stores and reads one entry per host", () => {
    const storage = createMemoryStorage();
    const registry = createHostRegistry(storage);
    registry.save(entry);
    registry.save({ ...entry, hostId: "host2", label: "iPad" });
    expect(registry.list().map((item) => item.hostId)).toEqual(["host1", "host2"]);
    expect(registry.get("host2")?.label).toBe("iPad");
  });

  it("replaces an existing host instead of appending a duplicate", () => {
    const registry = createHostRegistry(createMemoryStorage());
    registry.save(entry);
    registry.save({ ...entry, label: "renamed" });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("host1")?.label).toBe("renamed");
  });

  it("forgets one host", () => {
    const registry = createHostRegistry(createMemoryStorage());
    registry.save(entry);
    registry.forget("host1");
    expect(registry.list()).toEqual([]);
  });

  it("never persists a device token", () => {
    const storage = createMemoryStorage({
      [HOST_REGISTRY_STORAGE_KEY]: JSON.stringify([{ ...entry, token: "pdt1.secret" }]),
    });
    const registry = createHostRegistry(storage);
    // Reading drops the unknown field ...
    expect(registry.list()).toEqual([entry]);
    // ... and the next write stores only the registry shape.
    registry.save({ ...entry, label: "renamed" });
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("pdt1.secret");
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).toContain("renamed");
  });

  it("drops malformed entries instead of throwing", () => {
    expect(parseRegistry(null)).toEqual([]);
    expect(parseRegistry("not json")).toEqual([]);
    // Not an array of objects.
    expect(parseRegistry(JSON.stringify({ hostId: "x" }))).toEqual([]);
    // An object without a host id is not an entry; the rest still parse.
    expect(parseRegistry(JSON.stringify([{ label: "no host id" }, entry, "junk", null, []]))).toEqual([entry]);
  });

  it("accepts an entry with no credential, as PR-5 requires", () => {
    // PR-4 required a CSRF token; a native entry has none, so a bare host id is
    // a valid (credential-less) entry rather than a malformed one.
    expect(parseRegistry(JSON.stringify([{ hostId: "x" }]))).toEqual([
      { hostId: "x", label: "x", deviceId: "", pairedAt: "" },
    ]);
  });

  it("drops a duplicate host id when reading", () => {
    expect(parseRegistry(JSON.stringify([entry, { ...entry, label: "later" }]))).toEqual([entry]);
  });

  it("serializes only known fields", () => {
    expect(JSON.parse(serializeRegistry([{ ...entry, extra: true } as HostRegistryEntry]))).toEqual([entry]);
  });

  it("notifies subscribers on every mutation", () => {
    const registry = createHostRegistry(createMemoryStorage());
    let calls = 0;
    const unsubscribe = registry.subscribe(() => {
      calls += 1;
    });
    registry.save(entry);
    registry.forget("host1");
    unsubscribe();
    registry.save(entry);
    expect(calls).toBe(2);
  });
});

/**
 * PR-5 keeps the same storage key for both profiles: a web entry written by
 * PR-4 must parse and re-serialize unchanged, and a native entry records only
 * the profile marker — never a credential.
 */
describe("host registry profiles", () => {
  it("round-trips a v1 web entry byte-for-byte", () => {
    const raw = JSON.stringify([entry]);
    expect(serializeRegistry(parseRegistry(raw))).toBe(raw);
  });

  it("accepts an entry with neither a CSRF token nor a profile marker", () => {
    const { csrfToken: _csrf, ...withoutToken } = entry;
    const parsed = parseRegistry(JSON.stringify([withoutToken]));
    expect(parsed).toEqual([withoutToken]);
    expect(parsed[0]).not.toHaveProperty("csrfToken");
    expect(parsed[0]).not.toHaveProperty("profile");
  });

  it("keeps the native marker and still persists no credential", () => {
    const nativeEntry: HostRegistryEntry = {
      hostId: "host1",
      label: "iOS app",
      deviceId: "dev_1",
      pairedAt: "2026-09-18T10:00:00.000Z",
      profile: "native",
    };
    const storage = createMemoryStorage();
    const registry = createHostRegistry(storage);
    registry.save({ ...nativeEntry, token: "pdt1.secret", csrfToken: "csrf-1" } as HostRegistryEntry);
    expect(registry.list()).toEqual([nativeEntry]);
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("pdt1.secret");
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("csrf-1");
  });
});
