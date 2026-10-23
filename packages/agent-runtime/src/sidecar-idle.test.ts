import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECLAIM_POLICY,
  reclaimPolicyFromEnv,
  selectReclaimableRuntimes,
} from "./sidecar-idle.js";

const policy = { idleMs: 1_000, maxIdle: 2 };
const now = 1_000_000;

describe("idle runtime reclaim", () => {
  it("reclaims a runtime whose last activity is past the idle window", () => {
    expect(
      selectReclaimableRuntimes(
        [
          { sessionId: "old", lastActivity: now - 5_000, busy: false },
          { sessionId: "fresh", lastActivity: now - 10, busy: false },
        ],
        now,
        policy,
      ),
    ).toEqual(["old"]);
  });

  it("never reclaims a runtime that can still resume", () => {
    expect(
      selectReclaimableRuntimes(
        [
          { sessionId: "running", lastActivity: now - 600_000, busy: true },
          { sessionId: "idle", lastActivity: now - 600_000, busy: false },
        ],
        now,
        policy,
      ),
    ).toEqual(["idle"]);
  });

  it("keeps at most maxIdle idle runtimes, dropping the least recently used", () => {
    const runtimes = [
      { sessionId: "a", lastActivity: now - 900, busy: false },
      { sessionId: "b", lastActivity: now - 700, busy: false },
      { sessionId: "c", lastActivity: now - 500, busy: false },
      { sessionId: "d", lastActivity: now - 300, busy: false },
    ];
    expect(selectReclaimableRuntimes(runtimes, now, policy)).toEqual(["a", "b"]);
  });

  it("does nothing without a clock that ever passes the window", () => {
    expect(
      selectReclaimableRuntimes([{ sessionId: "a", lastActivity: now, busy: false }], now, policy),
    ).toEqual([]);
  });

  it("reads a shortened window from the environment for measurements", () => {
    expect(reclaimPolicyFromEnv({ MINIH_AGENT_IDLE_RUNTIME_SECONDS: "2" })).toEqual({
      idleMs: 2_000,
      maxIdle: DEFAULT_RECLAIM_POLICY.maxIdle,
    });
    expect(reclaimPolicyFromEnv({ MINIH_AGENT_MAX_IDLE_RUNTIMES: "0" })).toEqual({
      idleMs: DEFAULT_RECLAIM_POLICY.idleMs,
      maxIdle: 0,
    });
    expect(reclaimPolicyFromEnv({})).toEqual(DEFAULT_RECLAIM_POLICY);
  });
});