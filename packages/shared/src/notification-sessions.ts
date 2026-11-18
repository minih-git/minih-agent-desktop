import type { PluginViewMeta, PluginViewPlacement } from "./types/plugins.js";
import type { AppNotification } from "./types/workspace.js";

/**
 * A row that belongs to one conversation. `plugin.*` rows (schema v43) name a
 * plugin instead, so every per-session projection on this file skips them.
 */
export type SessionNotification = AppNotification & { sessionId: string };

export function isSessionNotification(
  notification: AppNotification,
): notification is SessionNotification {
  return typeof notification.sessionId === "string" && notification.sessionId !== "";
}

/**
 * The dedupe key the host reserves for the row that stands for the plugin
 * digests it folded away. A plugin cannot claim it (`notify.center` rejects it
 * at the write boundary), so the renderer may read the row as host-authored:
 * its `body` is the decimal number of hidden rows, and its `title` belongs to
 * the plugin the rows came from.
 */
export const PLUGIN_NOTIFICATION_OVERFLOW_KEY = "__minih_notify_overflow__";

/** A row a plugin delivered: it names its plugin and no conversation. */
export type PluginNotification = AppNotification & { pluginId: string };

export function isPluginNotification(
  notification: AppNotification,
): notification is PluginNotification {
  return (
    notification.kind.startsWith("plugin.") &&
    typeof notification.pluginId === "string" &&
    notification.pluginId !== ""
  );
}

/**
 * What activating a plugin row may open. `view` is already resolved against the
 * views this host registered for that plugin, so a row that points at another
 * plugin's view (or at one the plugin no longer contributes) resolves to null
 * and the row becomes read-only. `command` is only the id the row asked for:
 * the live command registry, not the row, decides whether it exists and who
 * owns it.
 */
export type PluginNotificationTarget =
  | {
      kind: "view";
      pluginId: string;
      viewId: string;
      ref: string;
      placement: PluginViewPlacement;
      icon?: string;
    }
  | { kind: "command"; pluginId: string; commandId: string };

/**
 * Resolve a plugin row's `linkJson` — `{ "view": "<id>" }` or
 * `{ "command": "<id>" }` — against the rows this host currently offers.
 *
 * Main validates the same payload when the plugin writes it; this is the second
 * check, at activation time, against what is registered *now*: a plugin can be
 * disabled, updated, or replaced between delivery and the click, and a
 * notification must never open a target its own plugin no longer declares.
 */
export function pluginNotificationTarget(
  notification: AppNotification,
  views: readonly PluginViewMeta[],
): PluginNotificationTarget | null {
  if (!isPluginNotification(notification)) return null;
  const raw = notification.linkJson;
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [kind, value] = entries[0];
  if (typeof value !== "string" || value === "") return null;

  if (kind === "view") {
    const view = views.find(
      (item) => item.pluginId === notification.pluginId && item.viewId === value,
    );
    if (!view) return null;
    return {
      kind: "view",
      pluginId: notification.pluginId,
      viewId: view.viewId,
      ref: view.ref,
      placement: view.placement,
      ...(view.icon ? { icon: view.icon } : {}),
    };
  }
  if (kind === "command") {
    return { kind: "command", pluginId: notification.pluginId, commandId: value };
  }
  return null;
}

/**
 * How many rows an overflow row stands for, or null when this row is not one.
 * A malformed count is not a number worth showing, so the caller keeps the raw
 * body in that case.
 */
export function collapsedNotificationCount(
  notification: AppNotification,
): number | null {
  if (notification.dedupeKey !== PLUGIN_NOTIFICATION_OVERFLOW_KEY) return null;
  const count = Number.parseInt((notification.body ?? "").trim(), 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

/**
 * The bell is a per-conversation surface (D664). A conversation that finished
 * five turns is one place to go back to, not five identical rows: the newest
 * notification represents it, and the row's unread state is the conversation's
 * unread state.
 *
 * Plugin rows (schema v43) belong to no conversation, so each one is its own
 * destination and stays a row of its own. Host order (newest first) decides
 * where the two families interleave, which is why this is one pass and not two
 * lists concatenated.
 *
 * The renderer popover, its badge, and the shell badge all use these
 * projections so the badge number, the list length, and the taskbar overlay
 * always agree.
 */
export function bellNotifications(
  notifications: AppNotification[],
): AppNotification[] {
  const seen = new Set<string>();
  const rows: AppNotification[] = [];
  for (const notification of notifications) {
    if (isSessionNotification(notification)) {
      if (seen.has(notification.sessionId)) continue;
      seen.add(notification.sessionId);
    }
    rows.push(notification);
  }
  return rows;
}

/**
 * Unread destinations the bell and the OS badge must show: every conversation
 * with at least one unread row, plus every unread plugin row.
 */
export function unreadNotificationCount(
  notifications: AppNotification[],
): number {
  let count = 0;
  for (const notification of notifications) {
    if (!notification.readAt && !isSessionNotification(notification)) count += 1;
  }
  return count + unreadSessionIds(notifications).size;
}

/** Conversations with at least one unread row, whatever the newest row says. */
export function unreadSessionIds(
  notifications: AppNotification[],
): Set<string> {
  const sessions = new Set<string>();
  for (const notification of notifications) {
    if (!notification.readAt && isSessionNotification(notification)) {
      sessions.add(notification.sessionId);
    }
  }
  return sessions;
}

export function unreadSessionCount(notifications: AppNotification[]): number {
  return unreadSessionIds(notifications).size;
}

/** The conversation rows only, newest first, one per conversation. */
export function mergeNotificationsBySession(
  notifications: AppNotification[],
): SessionNotification[] {
  const seen = new Set<string>();
  const rows: SessionNotification[] = [];
  for (const notification of notifications) {
    if (!isSessionNotification(notification)) continue;
    if (seen.has(notification.sessionId)) continue;
    seen.add(notification.sessionId);
    rows.push(notification);
  }
  return rows;
}