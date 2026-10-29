import { describe, expect, it } from "vitest";

import { createForegroundRefresh } from "./foreground-refresh.js";

/** A timer host that records the callbacks instead of waiting for them. */
function fakeTimers() {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    timers,
    schedule: (callback: () => void, ms: number) => {
      const handle = next++;
      timers.set(handle, { callback, ms });
      return handle;
    },
    cancel: (handle: number) => {
      timers.delete(handle);
    },
    fire: () => {
      for (const timer of [...timers.values()]) timer.callback();
    },
  };
}

describe("createForegroundRefresh", () => {
  it("only starts the timer on the first report: the rows just probed themselves", () => {
    const clock = fakeTimers();
    let refreshes = 0;
    const schedule = createForegroundRefresh({
      refresh: () => {
        refreshes += 1;
      },
      intervalMs: 30_000,
      ...clock,
    });

    schedule.visible();
    expect(refreshes).toBe(0);
    expect(clock.timers.size).toBe(1);

    clock.fire();
    expect(refreshes).toBe(1);
  });

  it("refreshes once per return even when both foreground sources fire", () => {
    const clock = fakeTimers();
    let refreshes = 0;
    const schedule = createForegroundRefresh({
      refresh: () => {
        refreshes += 1;
      },
      intervalMs: 30_000,
      ...clock,
    });

    schedule.visible();
    schedule.hidden();
    // A real return: page visibility and the native app state both report it.
    schedule.visible();
    schedule.visible();
    expect(refreshes).toBe(1);
  });

  it("stops asking while the app is in the background", () => {
    const clock = fakeTimers();
    let refreshes = 0;
    const schedule = createForegroundRefresh({
      refresh: () => {
        refreshes += 1;
      },
      intervalMs: 30_000,
      ...clock,
    });

    schedule.visible();
    schedule.hidden();
    expect(clock.timers.size).toBe(0);
    clock.fire();
    expect(refreshes).toBe(0);
  });

  it("stops for good after dispose", () => {
    const clock = fakeTimers();
    let refreshes = 0;
    const schedule = createForegroundRefresh({
      refresh: () => {
        refreshes += 1;
      },
      intervalMs: 30_000,
      ...clock,
    });

    schedule.visible();
    schedule.dispose();
    expect(clock.timers.size).toBe(0);

    schedule.visible();
    expect(clock.timers.size).toBe(0);
    clock.fire();
    expect(refreshes).toBe(0);
  });
});