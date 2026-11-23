import type { SessionSummary } from "@minih-agent/shared";

/**
 * Whether a summary is a scheduled task's run transcript.
 *
 * `scheduledRun` is derived from `task_runs` (issue #1291) and is kept for hosts
 * that predate the stored origin (ADR persisted-session-origin). Lists use the
 * stored `origin` instead: that one survives the pruning of a task's run rows.
 * What still depends on this flag is reuse — see `sessionIsReusableEmpty` — and
 * the desktop tray, whose native menus have no room for the tag.
 */
export function isAutomationSession(
  session: Pick<SessionSummary, "scheduledRun"> | null | undefined,
): boolean {
  return session?.scheduledRun === true;
}

/**
 * The sessions a hand-off may be addressed to.
 *
 * Not a listing rule: the sidebar, search and the activity feed list an
 * automation transcript like any other conversation now that its row carries
 * the origin tag. What this keeps out is *addressing* — the composer's target
 * list offers conversations the person owns, not a task's output.
 */
export function listableSessions<T extends Pick<SessionSummary, "scheduledRun">>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => !isAutomationSession(session));
}

/**
 * Whether a session is an employee rather than a conversation the person
 * switched to.
 *
 * A bot is a session (ADR bot-sessions-and-steward §1), but it is entered from
 * the sidebar's employee group. Two rows for one employee — one that can be
 * renamed and buried like a chat, one that carries its status — is exactly the
 * "a bot looks like a chat" failure the ADR refuses, so the ordinary lists drop
 * it and the employee group owns it.
 */
export function isEmployeeSession(
  session: Pick<SessionSummary, "role"> | null | undefined,
): boolean {
  return session?.role === "bot";
}
