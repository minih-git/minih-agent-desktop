import { describe, expect, it, vi } from "vitest";

import type { DirectChatFailure } from "./control.js";
import {
  MODEL_REFRESH_THROTTLE_MS,
  createModelRefresher,
  shouldRefreshModels,
} from "./model-refresh.js";

describe("deciding whether to refresh the model catalog", () => {
  it("refreshes when nothing has been read yet", () => {
    expect(shouldRefreshModels({ lastStartedAt: null, now: 1_000 })).toBe(true);
  });

  it("stays quiet inside the throttle window", () => {
    expect(
      shouldRefreshModels({
        lastStartedAt: 1_000,
        now: 1_000 + MODEL_REFRESH_THROTTLE_MS - 1,
      }),
    ).toBe(false);
    expect(shouldRefreshModels({ lastStartedAt: 1_000, now: 1_000 + MODEL_REFRESH_THROTTLE_MS })).toBe(true);
  });

  it("never starts a second read while one is outstanding", () => {
    expect(shouldRefreshModels({ lastStartedAt: 1_000, now: 999_999, inFlight: true })).toBe(false);
  });
});

describe("the model refresher", () => {
  const failure: DirectChatFailure = { kind: "transport", message: "offline" };

  it("reads once, then throttles the next moment", async () => {
    let clock = 10_000;
    const refresh = vi.fn(async () => ({ ok: true as const }));
    const onRefreshed = vi.fn();
    const refresher = createModelRefresher({ refresh, now: () => clock, onRefreshed });

    await expect(refresher.request()).resolves.toEqual({ ok: true, refreshed: true });
    expect(onRefreshed).toHaveBeenCalledTimes(1);

    clock += 1_000;
    await expect(refresher.request()).resolves.toEqual({
      ok: true,
      refreshed: false,
      skipped: "throttled",
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    clock += MODEL_REFRESH_THROTTLE_MS;
    await expect(refresher.request()).resolves.toEqual({ ok: true, refreshed: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not start a second read while the first is outstanding", async () => {
    let release: (value: { ok: true }) => void = () => {};
    const refresh = vi.fn(
      async () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        }),
    );
    const refresher = createModelRefresher({ refresh, now: () => 0 });

    const first = refresher.request();
    await expect(refresher.request()).resolves.toEqual({
      ok: true,
      refreshed: false,
      skipped: "in-flight",
    });
    release({ ok: true });
    await expect(first).resolves.toEqual({ ok: true, refreshed: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports a failed read instead of swallowing it, and keeps the cache", async () => {
    const onFailure = vi.fn();
    const onRefreshed = vi.fn();
    const refresher = createModelRefresher({
      refresh: async () => ({ ok: false as const, failure }),
      now: () => 0,
      onFailure,
      onRefreshed,
    });

    await expect(refresher.request()).resolves.toEqual({ ok: false, failure });
    expect(onFailure).toHaveBeenCalledWith(failure);
    // Nothing was written, so the screens keep the catalog they already had.
    expect(onRefreshed).not.toHaveBeenCalled();
  });
});