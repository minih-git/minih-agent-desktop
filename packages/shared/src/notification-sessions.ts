import type { AppNotification } from "./types/workspace.js";

/**
 * The bell is a per-conversation surface (D664). A conversation that finished
 * five turns is one place to go back to, not five identical rows: the newest
 * notification represents it, and the row's unread state is the conversation's
 * unread state.
 *
 * Both the renderer popover and the shell badge use these two projections so
 * the badge number, the list length, and the taskbar overlay always agree.
 */
export function mergeNotificationsBySession(
  notifications: AppNotification[],
): AppNotification[] {
  const seen = new Set<string>();
  const rows: AppNotification[] = [];
  for (const notification of notifications) {
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
    if (!notification.readAt) sessions.add(notification.sessionId);
  }
  return sessions;
}

export function unreadSessionCount(notifications: AppNotification[]): number {
  return unreadSessionIds(notifications).size;
}
