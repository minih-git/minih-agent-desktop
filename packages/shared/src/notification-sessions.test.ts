import { describe, expect, it } from "vitest";
import {
  mergeNotificationsBySession,
  unreadSessionCount,
  unreadSessionIds,
} from "./notification-sessions.js";
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

describe("mergeNotificationsBySession", () => {
  it("keeps the newest row per conversation, in host order", () => {
    expect(
      mergeNotificationsBySession([
        notification({ id: "a2", sessionId: "a" }),
        notification({ id: "b1", sessionId: "b" }),
        notification({ id: "a1", sessionId: "a", readAt: "2026-09-04T09:00:00.000Z" }),
      ]).map((row) => row.id),
    ).toEqual(["a2", "b1"]);
  });

  it("counts a conversation as unread when any of its rows is unread", () => {
    const rows = [
      // Newest row already read, an older failure in the same conversation
      // still unread: the conversation stays an unread destination.
      notification({ id: "a2", sessionId: "a", readAt: "2026-09-04T10:01:00.000Z" }),
      notification({ id: "a1", sessionId: "a", kind: "task.failed" }),
      notification({ id: "b1", sessionId: "b", readAt: "2026-09-04T10:02:00.000Z" }),
    ];
    expect([...unreadSessionIds(rows)]).toEqual(["a"]);
    expect(unreadSessionCount(rows)).toBe(1);
  });

  it("lets a pending prompt represent its conversation", () => {
    const rows = [
      notification({ id: "p1", sessionId: "a", kind: "prompt.ask", requestId: "r1" }),
      notification({ id: "a1", sessionId: "a", readAt: "2026-09-04T10:00:00.000Z" }),
    ];
    expect([...unreadSessionIds(rows)]).toEqual(["a"]);
    expect(mergeNotificationsBySession(rows).map((row) => row.id)).toEqual(["p1"]);
  });
});
