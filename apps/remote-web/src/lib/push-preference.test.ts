import { describe, expect, it } from "vitest";

import { PUSH_ENABLED_KEY, readPushEnabled, writePushEnabled } from "./push-preference.js";

/**
 * Review fix: the master switch was memory-only, so a device that turned push
 * off uploaded a token again on the next launch.
 */
describe("the stored push preference", () => {
  function storage(initial?: Record<string, string>) {
    const map = new Map(Object.entries(initial ?? {}));
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      entries: () => Object.fromEntries(map),
    };
  }

  it("is on when nothing was ever chosen", () => {
    expect(readPushEnabled(storage())).toBe(true);
    expect(readPushEnabled(null)).toBe(true);
  });

  it("remembers that push was turned off", () => {
    const store = storage();
    writePushEnabled(false, store);
    expect(store.entries()[PUSH_ENABLED_KEY]).toBe("false");
    expect(readPushEnabled(store)).toBe(false);
    writePushEnabled(true, store);
    expect(readPushEnabled(store)).toBe(true);
  });

  it("treats an unreadable value as on rather than guessing", () => {
    expect(readPushEnabled(storage({ [PUSH_ENABLED_KEY]: "nonsense" }))).toBe(true);
  });

  it("survives a storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPushEnabled(hostile)).toBe(true);
    expect(() => writePushEnabled(false, hostile)).not.toThrow();
  });
});