import { describe, expect, it } from "vitest";

import { createPullTracker, PULL_TRIGGER_PX } from "./pull-to-refresh.js";

describe("createPullTracker", () => {
  it("arms only a single finger that starts at the top of the list", () => {
    const tracker = createPullTracker();

    // A second finger is a pinch, and a scrolled list is being scrolled.
    tracker.start({ touches: 2, scrollTop: 0, clientY: 100 });
    expect(tracker.armed).toBe(false);
    tracker.start({ touches: 1, scrollTop: 40, clientY: 100 });
    expect(tracker.armed).toBe(false);
    tracker.start({ touches: 1, scrollTop: 0, clientY: 100 });
    expect(tracker.armed).toBe(true);
  });

  it("reports the threshold while pulling and fires on release", () => {
    const tracker = createPullTracker();
    tracker.start({ touches: 1, scrollTop: 0, clientY: 100 });

    expect(tracker.move({ clientY: 100 + PULL_TRIGGER_PX - 1 })).toBe(false);
    expect(tracker.move({ clientY: 100 + PULL_TRIGGER_PX })).toBe(true);

    expect(tracker.end({ clientY: 100 + PULL_TRIGGER_PX })).toBe(true);
    expect(tracker.armed).toBe(false);
  });

  it("does not fire a short drag or an upward one", () => {
    const short = createPullTracker();
    short.start({ touches: 1, scrollTop: 0, clientY: 300 });
    expect(short.end({ clientY: 310 })).toBe(false);

    const upward = createPullTracker();
    upward.start({ touches: 1, scrollTop: 0, clientY: 300 });
    expect(upward.end({ clientY: 40 })).toBe(false);
  });

  it("never fires without an arm, and forgets a cancelled gesture", () => {
    const tracker = createPullTracker();
    // A release that never had a matching start is not a pull.
    expect(tracker.end({ clientY: 400 })).toBe(false);

    tracker.start({ touches: 1, scrollTop: 0, clientY: 100 });
    tracker.cancel();
    expect(tracker.armed).toBe(false);
    expect(tracker.end({ clientY: 400 })).toBe(false);
  });
});