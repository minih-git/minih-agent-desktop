import { describe, expect, it } from "vitest";
import {
  PLUGIN_NOTIFICATION_OVERFLOW_KEY,
  bellNotifications,
  collapsedNotificationCount,
  mergeNotificationsBySession,
  pluginNotificationTarget,
  unreadNotificationCount,
  unreadSessionCount,
  unreadSessionIds,
} from "./notification-sessions.js";
import type { PluginViewMeta } from "./types/plugins.js";
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
  it("leaves a plugin row out of the per-conversation projection", () => {
    const rows: AppNotification[] = [
      notification({
        id: "plugin-1",
        kind: "plugin.alert",
        sessionId: null,
        sessionTitle: null,
        turnId: undefined,
        pluginId: "acme.ci",
        title: "Build failed",
        dedupeKey: "event-1",
      }),
      notification({ id: "a1", sessionId: "a" }),
    ];
    // The plugin row is retained by the store, but it names no conversation:
    // it neither adds a bell row nor makes a session look unread.
    expect(mergeNotificationsBySession(rows).map((row) => row.id)).toEqual(["a1"]);
    expect([...unreadSessionIds(rows)]).toEqual(["a"]);
    expect(unreadSessionCount(rows)).toBe(1);
    expect(unreadSessionCount([rows[0]])).toBe(0);
  });
});

function pluginNotification(overrides: Partial<AppNotification>): AppNotification {
  return notification({
    id: "plugin-1",
    kind: "plugin.alert",
    sessionId: null,
    sessionTitle: null,
    turnId: undefined,
    pluginId: "acme.ci",
    title: "Build failed",
    dedupeKey: "event-1",
    ...overrides,
  });
}

const views: PluginViewMeta[] = [
  {
    pluginId: "acme.ci",
    viewId: "inbox",
    ref: "acme.ci/inbox",
    title: "CI inbox",
    pluginName: "Acme CI",
    icon: "bell",
    order: 0,
    placement: "sidebar",
  },
  {
    pluginId: "other.plugin",
    viewId: "inbox",
    ref: "other.plugin/inbox",
    title: "Other inbox",
    pluginName: "Other",
    order: 0,
    placement: "panel",
  },
];

describe("bellNotifications", () => {
  it("keeps every plugin row and still folds each conversation once", () => {
    const rows: AppNotification[] = [
      pluginNotification({ id: "plugin-2", dedupeKey: "event-2" }),
      notification({ id: "a2", sessionId: "a" }),
      notification({ id: "b1", sessionId: "b" }),
      pluginNotification({ id: "plugin-1", dedupeKey: "event-1" }),
      notification({ id: "a1", sessionId: "a", readAt: "2026-09-04T09:00:00.000Z" }),
    ];
    // Host order (newest first) is the row order; the plugin rows keep their
    // own place in it instead of being appended as a separate family.
    expect(bellNotifications(rows).map((row) => row.id)).toEqual([
      "plugin-2",
      "a2",
      "b1",
      "plugin-1",
    ]);
  });
});

describe("unreadNotificationCount", () => {
  it("counts unread conversations plus unread plugin rows", () => {
    const rows: AppNotification[] = [
      pluginNotification({ id: "plugin-1" }),
      pluginNotification({
        id: "plugin-2",
        dedupeKey: "event-2",
        readAt: "2026-09-04T10:05:00.000Z",
      }),
      notification({ id: "a1", sessionId: "a" }),
      notification({ id: "a2", sessionId: "a", readAt: "2026-09-04T10:00:00.000Z" }),
      notification({ id: "b1", sessionId: "b", readAt: "2026-09-04T10:00:00.000Z" }),
    ];
    // Conversation a (one unread row) + one unread plugin row.
    expect(unreadNotificationCount(rows)).toBe(2);
    expect(unreadNotificationCount([])).toBe(0);
  });
});

describe("pluginNotificationTarget", () => {
  it("resolves a view the row's own plugin declares", () => {
    expect(
      pluginNotificationTarget(
        pluginNotification({ linkJson: '{"view":"inbox"}' }),
        views,
      ),
    ).toEqual({
      kind: "view",
      pluginId: "acme.ci",
      viewId: "inbox",
      ref: "acme.ci/inbox",
      placement: "sidebar",
      icon: "bell",
    });
  });

  it("refuses a view that belongs to another plugin or is gone", () => {
    // Same view id, different plugin: the row must not open it.
    expect(
      pluginNotificationTarget(
        pluginNotification({ linkJson: '{"view":"inbox"}' }),
        [views[1]],
      ),
    ).toBeNull();
    expect(
      pluginNotificationTarget(
        pluginNotification({ linkJson: '{"view":"removed"}' }),
        views,
      ),
    ).toBeNull();
  });

  it("resolves a command id and leaves ownership to the registry", () => {
    expect(
      pluginNotificationTarget(
        pluginNotification({ linkJson: '{"command":"acme.ci.refresh"}' }),
        views,
      ),
    ).toEqual({
      kind: "command",
      pluginId: "acme.ci",
      commandId: "acme.ci.refresh",
    });
  });

  it("rejects payloads the host never writes", () => {
    for (const linkJson of [
      "{}",
      '{"view":"inbox","command":"acme.ci.refresh"}',
      '{"view":42}',
      '["inbox"]',
      "not json",
      "",
    ]) {
      expect(
        pluginNotificationTarget(pluginNotification({ linkJson }), views),
      ).toBeNull();
    }
    // A conversation row never resolves a plugin target.
    expect(
      pluginNotificationTarget(
        notification({ linkJson: '{"view":"inbox"}' }),
        views,
      ),
    ).toBeNull();
  });
});

describe("collapsedNotificationCount", () => {
  it("reads the folded count of a reserved overflow row", () => {
    expect(
      collapsedNotificationCount(
        pluginNotification({
          kind: "plugin.digest",
          dedupeKey: PLUGIN_NOTIFICATION_OVERFLOW_KEY,
          body: "12",
        }),
      ),
    ).toBe(12);
  });

  it("ignores rows that are not the host's overflow row", () => {
    expect(
      collapsedNotificationCount(pluginNotification({ body: "12" })),
    ).toBeNull();
    expect(
      collapsedNotificationCount(
        pluginNotification({
          dedupeKey: PLUGIN_NOTIFICATION_OVERFLOW_KEY,
          body: "twelve",
        }),
      ),
    ).toBeNull();
    expect(
      collapsedNotificationCount(
        pluginNotification({
          dedupeKey: PLUGIN_NOTIFICATION_OVERFLOW_KEY,
          body: "",
        }),
      ),
    ).toBeNull();
  });
});
