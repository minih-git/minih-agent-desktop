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
    expect(parseRegistry(JSON.stringify({ hostId: "x" }))).toEqual([]);
    expect(parseRegistry(JSON.stringify([{ hostId: "x" }, entry, "junk"]))).toEqual([entry]);
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
