import { describe, expect, it } from "vitest";

import {
  createBackgroundRetention,
  nativeBackgroundPlugin,
  type NativeBackgroundPlugin,
} from "./native-background.js";

/** A plugin that records the calls, so the test can see the burst boundaries. */
function fakePlugin(options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const plugin: NativeBackgroundPlugin = {
    async begin() {
      calls.push("begin");
      if (options.fail) throw new Error("not available");
      return { active: true };
    },
    async end() {
      calls.push("end");
      if (options.fail) throw new Error("not available");
      return { active: false };
    },
  };
  return { plugin, calls };
}

describe("background time while replies run", () => {
  it("starts holding on the first reply and stops with the last", async () => {
    const { plugin, calls } = fakePlugin();
    const retention = createBackgroundRetention(plugin);

    await retention.setRunningReplies(0);
    // Nothing to hold yet: no call to the platform.
    expect(calls).toEqual([]);

    await retention.setRunningReplies(1);
    expect(calls).toEqual(["begin"]);

    // A second reply joins the same grant instead of asking twice.
    await retention.setRunningReplies(2);
    expect(calls).toEqual(["begin"]);

    // One ending leaves the other running, so the grant stays.
    await retention.setRunningReplies(1);
    expect(calls).toEqual(["begin"]);

    await retention.setRunningReplies(0);
    expect(calls).toEqual(["begin", "end"]);

    // Already released: nothing more to give back.
    await retention.setRunningReplies(0);
    expect(calls).toEqual(["begin", "end"]);
  });

  it("re-asks after the platform releases the grant on its own", async () => {
    const { plugin, calls } = fakePlugin();
    const retention = createBackgroundRetention(plugin);
    await retention.setRunningReplies(1);
    await retention.setRunningReplies(0);
    // The next burst asks again.
    await retention.setRunningReplies(1);
    expect(calls).toEqual(["begin", "end", "begin"]);
  });

  it("does nothing when the platform has no such plugin", async () => {
    const retention = createBackgroundRetention(null);
    // Every call is a no-op, and none of them throws.
    await expect(retention.setRunningReplies(3)).resolves.toBeUndefined();
    await expect(retention.setRunningReplies(0)).resolves.toBeUndefined();
  });

  it("swallows a rejected grant rather than failing the chat", async () => {
    const { plugin, calls } = fakePlugin({ fail: true });
    const retention = createBackgroundRetention(plugin);
    await expect(retention.setRunningReplies(1)).resolves.toBeUndefined();
    expect(calls).toEqual(["begin"]);
    // A failed begin is not remembered, so the next attempt asks again.
    await retention.setRunningReplies(0);
    await retention.setRunningReplies(1);
    expect(calls).toEqual(["begin", "begin"]);
  });

  it("uses an injected plugin instead of the window global", () => {
    const { plugin } = fakePlugin();
    expect(nativeBackgroundPlugin(plugin)).toBe(plugin);
  });
});
