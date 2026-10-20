import {
  compareMatches,
  fuzzyMatchCommand,
  type FuzzyMatch,
  type SessionSummary,
} from "@minih-agent/shared";
import { isRemoteSession } from "../../../lib/remote-session-safety";
import { listableSessions } from "../../../lib/session-origin";
import { normalizeProjectPath, type SessionMeta } from "../../../lib/sidebar-preferences";
import { sessionArchived } from "../../../lib/sidebar-session-groups";

/**
 * The sessions the Composer's `#` trigger may offer as a target (D673).
 *
 * A target exists so the model can hand work to that conversation with the
 * session tools, so this list follows the same rule `SessionList` reports:
 * local, Agent-mode, not archived, and in the caller's own project. The current
 * session is never a target of itself, and a session an automation owns is
 * entered from the Scheduled page, so it is not offered here either.
 *
 * Pure, so the filter, the order and the cap are unit tested away from React.
 */

/** Rows one `#` query may list; the rest stay out of the menu. */
export const MAX_SESSION_TARGET_ITEMS = 50;

export type SessionTargetCandidate = {
  session: SessionSummary;
  /** Title match, for the highlight ranges the row paints. */
  match: FuzzyMatch;
};

/**
 * The project whose sessions the trigger lists: the open session's own project,
 * or — on the empty home, before any session exists — the project the user has
 * selected there. `null` means "the sessions with no project", which is what a
 * temporary session belongs to.
 */
export function sessionTargetProjectPath({
  sessions,
  activeSessionId,
  activeProjectPath,
}: {
  sessions: readonly SessionSummary[];
  activeSessionId?: string | null;
  activeProjectPath?: string | null;
}): string | null {
  const active = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId)
    : undefined;
  return normalizeProjectPath(active ? active.projectPath : activeProjectPath);
}

/**
 * The target candidates for one query, newest first.
 *
 * An empty query lists the most recently updated sessions; a query keeps the
 * ones whose title matches it (case-insensitively, as a substring or a
 * subsequence) and carries the ranges the row highlights. Order stays by
 * `updatedAt` either way, so a session never moves because a query was typed
 * unless it stops matching at all.
 */
export function sessionTargetCandidates({
  sessions,
  sessionMeta,
  activeSessionId,
  activeProjectPath,
  query,
}: {
  sessions: readonly SessionSummary[];
  sessionMeta: Record<string, SessionMeta>;
  activeSessionId?: string | null;
  activeProjectPath?: string | null;
  query: string;
}): SessionTargetCandidate[] {
  const projectPath = sessionTargetProjectPath({
    sessions,
    activeSessionId,
    activeProjectPath,
  });
  const trimmed = query.trim();
  const matched: SessionTargetCandidate[] = [];
  for (const session of listableSessions(sessions)) {
    if (session.id === activeSessionId) continue;
    if (isRemoteSession(session)) continue;
    if (session.mode !== "agent") continue;
    if (sessionArchived(session, sessionMeta[session.id])) continue;
    if (normalizeProjectPath(session.projectPath) !== projectPath) continue;
    const match = trimmed ? fuzzyMatchCommand(trimmed, session.title) : { score: 0, ranges: [] };
    if (!match) continue;
    matched.push({ session, match });
  }
  matched.sort((left, right) => {
    const delta = sessionUpdatedAt(right.session) - sessionUpdatedAt(left.session);
    if (delta !== 0) return delta;
    return compareMatches(
      { score: left.match.score, text: left.session.title },
      { score: right.match.score, text: right.session.title },
    );
  });
  return matched.slice(0, MAX_SESSION_TARGET_ITEMS);
}

/** Newest first; an unparsable timestamp sorts last rather than first. */
function sessionUpdatedAt(session: Pick<SessionSummary, "updatedAt">): number {
  const parsed = Date.parse(session.updatedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The draft text one accepted target contributes: its chip token, plus the one
 * space that lets the user keep typing after the chip.
 *
 * A whitespace character the draft already has at that position is not doubled;
 * otherwise the chip is followed by exactly one space, including at the end of
 * the draft, and the caret lands after it.
 */
export function sessionTargetChipInsert(token: string, nextChar: string | undefined): string {
  return nextChar !== undefined && /\s/.test(nextChar) ? token : `${token} `;
}
