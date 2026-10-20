import { describe, expect, it } from "vitest";

import type { HostStatus } from "./host-status.js";
import { StreamSupervisor, type StreamState, type StreamSupervisorOptions } from "./stream-supervisor.js";

const policy = { baseDelayMs: 100, maxDelayMs: 800, maxAttempts: 3, jitterRatio: 0.5 };

type Harness = {
  supervisor: StreamSupervisor;
  states: StreamState[];
  delays: number[];
  opens: () => number;
  closes: () => number;
};

/**
 * `onOpen` runs inside the default `openStream`, after the open is counted, so
 * a test can make a stream behave like a healthy one (`noteActivity()`) or stop
 * the loop at a chosen point.
 */
type HarnessOptions = Partial<StreamSupervisorOptions> & {
  onOpen?: (supervisor: StreamSupervisor) => void;
};

function harness(overrides: HarnessOptions = {}): Harness {
  const { onOpen, ...supervisorOptions } = overrides;
  const states: StreamState[] = [];
  const delays: number[] = [];
  let opens = 0;
  let closes = 0;
  const holder: { supervisor?: StreamSupervisor } = {};
  const supervisor = new StreamSupervisor({
    openStream: async () => {
      opens += 1;
      if (holder.supervisor) onOpen?.(holder.supervisor);
    },
    closeStream: () => {
      closes += 1;
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    policy,
    onState: (state) => states.push(state),
    ...supervisorOptions,
  });
  holder.supervisor = supervisor;
  return { supervisor, states, delays, opens: () => opens, closes: () => closes };
}

describe("StreamSupervisor", () => {
  it("reopens at once after a fresh snapshot, without spending a retry", async () => {
    // A stream that stays open until it is closed: this is what lets the test
    // observe a deliberate reopen rather than a drop.
    let release: (() => void) | null = null;
    let opens = 0;
    const delays: number[] = [];
    const supervisor = new StreamSupervisor({
      openStream: () =>
        new Promise<void>((resolve) => {
          opens += 1;
          release = resolve;
        }),
      closeStream: () => {
        release?.();
        release = null;
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
      policy,
    });
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    supervisor.start();
    await tick();
    expect(opens).toBe(1);

    // The snapshot moved the cursor: the open stream is behind it.
    supervisor.reopen();
    await tick();

    expect(opens).toBe(2);
    // No backoff and no probe: a reopen is not a drop.
    expect(delays).toEqual([]);
    expect(supervisor.retryAttempts).toBe(0);
    supervisor.stop();
    await supervisor.settled();
  });


  it("retries with a growing jittered backoff and then gives up", async () => {
    const h = harness();
    h.supervisor.start();
    await h.supervisor.settled();

    expect(h.opens()).toBe(4);
    expect(h.delays).toEqual([75, 150, 300]);
    expect(h.supervisor.state).toBe("exhausted");
    expect(h.states.at(-1)).toBe("exhausted");
  });

  it("stops for good when the probe reports a revoked credential", async () => {
    const h = harness({ probe: async (): Promise<HostStatus> => ({ kind: "revoked" }) });
    h.supervisor.start();
    await h.supervisor.settled();

    expect(h.opens()).toBe(1);
    expect(h.delays).toEqual([]);
    expect(h.supervisor.state).toBe("revoked");
  });

  it("keeps retrying while the host is only offline or unreachable", async () => {
    const statuses: HostStatus[] = [
      { kind: "offline" },
      { kind: "error", code: "REMOTE_CONNECTION_FAILED", message: "offline" },
    ];
    let probes = 0;
    const h = harness({
      probe: async (): Promise<HostStatus> => statuses[Math.min(probes++, statuses.length - 1)]!,
    });
    h.supervisor.start();
    await h.supervisor.settled();

    expect(h.opens()).toBe(4);
    expect(probes).toBe(4);
    expect(h.supervisor.state).toBe("exhausted");
  });

  it("closes the open stream on pause and opens no further one until resume", async () => {
    const h = harness();
    h.supervisor.start();
    h.supervisor.pause();
    await Promise.resolve();

    // `start()` reaches its first open before a caller can pause, so one stream
    // may already be open — what matters is that pause closes it and holds.
    const opensWhilePaused = h.opens();
    expect(h.closes()).toBe(1);
    expect(h.supervisor.state).toBe("paused");

    await Promise.resolve();
    expect(h.opens()).toBe(opensWhilePaused);

    h.supervisor.resume();
    await h.supervisor.settled();
    expect(h.opens()).toBeGreaterThan(opensWhilePaused);
  });

  it("pauses an open stream and resumes it from the transport cursor", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      openStream: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    h.supervisor.start();
    await Promise.resolve();
    expect(h.supervisor.state).toBe("open");

    h.supervisor.pause();
    expect(h.closes()).toBe(1);
    release?.();
    await Promise.resolve();
    expect(h.supervisor.state).toBe("paused");

    h.supervisor.resume();
    await Promise.resolve();
    expect(h.supervisor.state).toBe("open");
    h.supervisor.stop();
  });

  it("stops the loop and never reopens after stop", async () => {
    const h = harness();
    h.supervisor.start();
    h.supervisor.stop();
    await h.supervisor.settled();

    expect(h.opens()).toBe(1);
    expect(h.supervisor.state).toBe("stopped");
    expect(h.closes()).toBeGreaterThan(0);
  });

  it("treats a thrown stream error as a drop", async () => {
    let calls = 0;
    const h = harness({
      openStream: async () => {
        calls += 1;
        throw new Error("stream failed");
      },
    });
    h.supervisor.start();
    await h.supervisor.settled();

    expect(calls).toBe(4);
    expect(h.supervisor.state).toBe("exhausted");
  });

  it("starting twice keeps a single loop", async () => {
    const h = harness();
    h.supervisor.start();
    h.supervisor.start();
    await h.supervisor.settled();
    expect(h.opens()).toBe(4);
  });

  it("never exhausts while every drop follows a stream that delivered an event", async () => {
    // A phone that changes networks all day delivers events between drops; the
    // retry budget must belong to the current outage, not to the session.
    let healthy = 0;
    const h = harness({
      onOpen: (supervisor) => {
        supervisor.noteActivity();
        healthy += 1;
        if (healthy >= policy.maxAttempts * 2) supervisor.stop();
      },
    });
    h.supervisor.start();
    await h.supervisor.settled();

    expect(h.opens()).toBe(policy.maxAttempts * 2);
    expect(h.states).not.toContain("exhausted");
    expect(h.supervisor.state).toBe("stopped");
    // Every wait is the first step of a fresh budget, never a growing one.
    expect(new Set(h.delays)).toEqual(new Set([75]));
  });

  it("still exhausts after maxAttempts drops that delivered nothing", async () => {
    let firstOpen = true;
    const h = harness({
      onOpen: (supervisor) => {
        if (!firstOpen) return;
        firstOpen = false;
        supervisor.noteActivity();
      },
    });
    h.supervisor.start();
    await h.supervisor.settled();

    // One healthy open resets the budget; the failures that follow still count.
    expect(h.opens()).toBe(policy.maxAttempts + 1);
    expect(h.supervisor.state).toBe("exhausted");
  });

  it("reopens the stream on start() after exhausted, with a fresh budget", async () => {
    const h = harness();
    h.supervisor.start();
    await h.supervisor.settled();
    expect(h.supervisor.state).toBe("exhausted");
    expect(h.opens()).toBe(policy.maxAttempts + 1);

    // The Reconnect control: `start()` is no longer a no-op after a terminal
    // state, and the new loop gets the whole budget back.
    h.supervisor.start();
    expect(h.supervisor.state).toBe("open");
    expect(h.opens()).toBe(policy.maxAttempts + 2);
    expect(h.supervisor.retryAttempts).toBe(0);
    await h.supervisor.settled();
    expect(h.opens()).toBe((policy.maxAttempts + 1) * 2);
  });

  it("restarts an exhausted supervisor when the page becomes visible again", async () => {
    const h = harness();
    h.supervisor.start();
    await h.supervisor.settled();
    expect(h.supervisor.state).toBe("exhausted");

    h.supervisor.onVisible();
    expect(h.supervisor.state).toBe("open");
    expect(h.opens()).toBe(policy.maxAttempts + 2);
    h.supervisor.stop();
  });

  it("does not park an exhausted supervisor in paused", async () => {
    const h = harness();
    h.supervisor.start();
    await h.supervisor.settled();
    expect(h.supervisor.state).toBe("exhausted");

    // The old failure mode: pause() then resume() left the state at "paused"
    // and released no waiter, so no stream could ever reopen.
    h.supervisor.pause();
    expect(h.supervisor.state).toBe("exhausted");
    h.supervisor.resume();
    expect(h.supervisor.state).toBe("exhausted");

    h.supervisor.onVisible();
    expect(h.supervisor.state).toBe("open");
    h.supervisor.stop();
  });

  it("never restarts a revoked supervisor from the visibility path", async () => {
    const h = harness({ probe: async (): Promise<HostStatus> => ({ kind: "revoked" }) });
    h.supervisor.start();
    await h.supervisor.settled();
    expect(h.supervisor.state).toBe("revoked");

    h.supervisor.onVisible();
    await Promise.resolve();
    expect(h.opens()).toBe(1);
    expect(h.supervisor.state).toBe("revoked");
  });
});
