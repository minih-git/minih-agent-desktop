import { describe, expect, it } from "vitest";

import { LAST_ROOT_STORAGE_KEY, launchRoot, storeLastRoot, type RootStorage } from "./launch-root.js";

/**
 * The launch rule (ADR mobile-direct-gateway-chat, spec §4): a fresh native
 * install opens Chats, an upgrade that already holds computers opens Computers,
 * and later launches reopen the remembered root. The browser build has one root
 * and never consults any of this.
 */
describe("launchRoot", () => {
  it("always opens the computer list in the browser build", () => {
    expect(launchRoot({ isNativeApp: false, hasHosts: false, storage: null })).toBe("hosts");
    expect(launchRoot({ isNativeApp: false, hasHosts: true, storage: null })).toBe("hosts");
  });

  it("opens Chats on a fresh native install", () => {
    expect(launchRoot({ isNativeApp: true, hasHosts: false, storage: null })).toBe("chats");
  });

  it("opens Computers on the first launch after an upgrade that has computers", () => {
    expect(launchRoot({ isNativeApp: true, hasHosts: true, storage: null })).toBe("hosts");
  });

  it("reopens the remembered root once one has been stored", () => {
    const storage = fakeStorage({ [LAST_ROOT_STORAGE_KEY]: "chats" });
    expect(launchRoot({ isNativeApp: true, hasHosts: true, storage })).toBe("chats");
    storage.set(LAST_ROOT_STORAGE_KEY, "hosts");
    expect(launchRoot({ isNativeApp: true, hasHosts: false, storage })).toBe("hosts");
  });

  it("falls back to the launch decision when the stored root is not one", () => {
    const storage = fakeStorage({ [LAST_ROOT_STORAGE_KEY]: "sessions" });
    expect(launchRoot({ isNativeApp: true, hasHosts: false, storage })).toBe("chats");
  });
});

describe("storeLastRoot", () => {
  it("writes the key the launch decision reads", () => {
    const storage = fakeStorage({});
    storeLastRoot("chats", storage);
    expect(storage.get(LAST_ROOT_STORAGE_KEY)).toBe("chats");
    storeLastRoot("hosts", storage);
    expect(storage.get(LAST_ROOT_STORAGE_KEY)).toBe("hosts");
  });

  it("keeps the session working when the store is blocked", () => {
    const throwing: RootStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => storeLastRoot("chats", throwing)).not.toThrow();
    expect(() => storeLastRoot("chats", null)).not.toThrow();
  });
});

/** A minimal `Storage` stand-in; the real one is `localStorage`. */
function fakeStorage(initial: Record<string, string>): RootStorage & { get: (key: string) => string | null; set: (key: string, value: string) => void } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
  };
}
