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
 * The bell is a per-conversation surface (D664). A conversation that finished
 * five turns is one place to go back to, not five identical rows: the newest
 * notification represents it, and the row's unread state is the conversation's
 * unread state.
 *
 * Both the renderer popover and the shell badge use these two projections so
 * the badge number, the list length, and the taskbar overlay always agree.
 * Rows that name no conversation (plugin rows) have no place in either.
 */
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