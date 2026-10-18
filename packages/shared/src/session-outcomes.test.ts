import { describe, expect, it } from "vitest";
import { latestSessionOutcomes } from "./session-outcomes.js";
import type { AppNotification } from "./types/workspace.js";

function notification(overrides: Partial<AppNotification>): AppNotification {
  return {
    id: "notification-1",
    kind: "task.completed",
    sessionId: "session-1",
    sessionTitle: "Session",
    turnId: "turn-1",
    createdAt: "2026-09-04T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

describe("latestSessionOutcomes", () => {
  it("reads the newest unfinished terminal result per session", () => {
    expect(
      latestSessionOutcomes([
        notification({ id: "done-1", sessionId: "session-1" }),
        notification({ id: "failed-1", kind: "task.failed", sessionId: "session-2" }),
        notification({
          id: "failed-2",
          kind: "task.failed",
          sessionId: "session-3",
          readAt: "2026-09-04T10:05:00.000Z",
        }),
      ]),
    ).toEqual({ "session-1": "completed", "session-2": "failed" });
  });

  it("does not turn a pending prompt into a completed badge", () => {
    // A reminder is not an outcome: the session is waiting, it did not finish.
    expect(
      latestSessionOutcomes([
        notification({
          id: "ask-1",
          kind: "prompt.ask",
          requestId: "request-1",
          sessionId: "session-1",
        }),
        notification({
          id: "perm-1",
          kind: "prompt.permission",
          requestId: "request-2",
          sessionId: "session-2",
        }),
      ]),
    ).toEqual({});
  });

  it("keeps the latest terminal result behind a newer prompt row", () => {
    expect(
      latestSessionOutcomes([
        notification({
          id: "ask-1",
          kind: "prompt.ask",
          requestId: "request-1",
          sessionId: "session-1",
        }),
        notification({
          id: "failed-1",
          kind: "task.failed",
          sessionId: "session-1",
          createdAt: "2026-09-04T09:00:00.000Z",
        }),
      ]),
    ).toEqual({ "session-1": "failed" });
  });
});
