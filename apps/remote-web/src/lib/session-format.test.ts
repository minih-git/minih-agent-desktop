import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatRelativeTime,
  groupSessionsByDate,
  resolveConnectionBanner,
  resolveTurnStatusDisplay,
} from "./session-format.js";

describe("formatRelativeTime", () => {
  const baseTime = new Date("2026-03-31T12:00:00Z").getTime();

  it("handles just now", () => {
    expect(formatRelativeTime(baseTime - 30 * 1000, baseTime)).toBe("justNow");
  });

  it("handles minutes", () => {
    expect(formatRelativeTime(baseTime - 5 * 60 * 1000, baseTime)).toBe("5m");
  });

  it("handles hours", () => {
    expect(formatRelativeTime(baseTime - 3 * 3600 * 1000, baseTime)).toBe("3h");
  });

  it("handles yesterday", () => {
    expect(formatRelativeTime(baseTime - 25 * 3600 * 1000, baseTime)).toBe("yesterday");
  });

  it("handles days within a week", () => {
    expect(formatRelativeTime(baseTime - 4 * 24 * 3600 * 1000, baseTime)).toBe("4d");
  });

  it("handles invalid dates", () => {
    expect(formatRelativeTime("invalid-date")).toBe("");
  });
});

describe("groupSessionsByDate", () => {
  const now = new Date("2026-03-31T15:00:00Z").getTime();

  it("groups sessions into today, yesterday, pastWeek, and earlier", () => {
    const sessions = [
      { id: "s1", updatedAt: "2026-03-31T14:00:00Z" }, // today
      { id: "s2", updatedAt: "2026-03-30T10:00:00Z" }, // yesterday
      { id: "s3", updatedAt: "2026-03-27T08:00:00Z" }, // pastWeek
      { id: "s4", updatedAt: "2026-03-01T00:00:00Z" }, // earlier
    ];

    const groups = groupSessionsByDate(sessions, now);
    expect(groups.map((g) => g.key)).toEqual(["today", "yesterday", "pastWeek", "earlier"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["s1"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["s2"]);
    expect(groups[2].items.map((i) => i.id)).toEqual(["s3"]);
    expect(groups[3].items.map((i) => i.id)).toEqual(["s4"]);
  });

  it("omits empty groups", () => {
    const sessions = [{ id: "s1", updatedAt: "2026-03-31T14:00:00Z" }];
    const groups = groupSessionsByDate(sessions, now);
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe("today");
  });
});

describe("formatCountdown", () => {
  it("formats countdown seconds into mm:ss", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(600)).toBe("10:00");
  });
});

describe("resolveConnectionBanner", () => {
  it("resolves failure highest priority", () => {
    const banner = resolveConnectionBanner("retrying", {
      failure: { message: "Network error" },
      operationKey: "turn/start",
    });
    expect(banner.type).toBe("failure");
    expect(banner.message).toBe("Network error");
  });

  it("resolves exhausted and retrying streams", () => {
    expect(resolveConnectionBanner("exhausted").type).toBe("exhausted");
    expect(resolveConnectionBanner("retrying").type).toBe("retrying");
    expect(resolveConnectionBanner("open").type).toBe("none");
  });
});

describe("resolveTurnStatusDisplay", () => {
  it("resolves stopping", () => {
    expect(resolveTurnStatusDisplay("running", true)).toEqual({
      statusType: "running",
      labelKey: "session.stopping",
      isStopping: true,
    });
  });

  it("resolves waiting approval and input", () => {
    expect(resolveTurnStatusDisplay("waiting_permission", false, "approval")).toEqual({
      statusType: "decision",
      labelKey: "session.waitingApproval",
    });
    expect(resolveTurnStatusDisplay("waiting_permission", false, "input")).toEqual({
      statusType: "decision",
      labelKey: "session.waitingInput",
    });
  });

  it("resolves normal running", () => {
    expect(resolveTurnStatusDisplay("running", false)).toEqual({
      statusType: "running",
      labelKey: "session.turn.running",
    });
  });

  it("returns null for idle", () => {
    expect(resolveTurnStatusDisplay("idle", false)).toBeNull();
  });
});

describe("resolveTurnStatusDisplay outcomes", () => {
  it("names a failed turn instead of showing nothing", () => {
    // The status arrives as `failed` and had no branch at all: a failed turn
    // rendered no outcome in the header while the banner explained it below.
    expect(resolveTurnStatusDisplay("failed", false)).toEqual({
      statusType: "error",
      labelKey: "session.turn.failedStatus",
    });
  });

  it("names a canceled turn", () => {
    expect(resolveTurnStatusDisplay("canceled", false)).toEqual({
      statusType: "muted",
      labelKey: "session.turn.canceled",
    });
  });
});
