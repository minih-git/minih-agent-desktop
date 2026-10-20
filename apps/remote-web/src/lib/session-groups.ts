/**
 * The session list grouped by project (D666 follow-up).
 *
 * The desktop sidebar leads with projects and lists each project's sessions
 * under it, both ordered by most recent activity; the phone had a flat list
 * with no way to tell which project a session belongs to. This module is the
 * pure half: given the sessions and the project catalog, it produces the groups
 * the screen renders.
 *
 * Sessions without a `projectId`, and sessions whose project is no longer in the
 * catalog, land in one trailing "Other" group, so nothing ever disappears
 * because its project was archived or renamed away.
 */
import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";

/** The id used for the trailing group; never collides with a Host project id. */
export const UNGROUPED_KEY = "__other__";

export type SessionGroup = {
  /** `UNGROUPED_KEY`, or the Host project id. */
  key: string;
  /** Project label, or `null` for the "Other" group (the screen localizes it). */
  label: string | null;
  sessions: RacpSession[];
};

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Most recent activity first, then newest created, then id — the sidebar's order
 * for the rows inside one project.
 */
function byRecentActivity(left: RacpSession, right: RacpSession): number {
  const byUpdated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  const byCreated = timestamp(right.createdAt) - timestamp(left.createdAt);
  if (byCreated !== 0) return byCreated;
  return left.id.localeCompare(right.id);
}

/**
 * The same order without the id tiebreak, for comparing two groups: the group
 * order must not depend on which session id happens to sort first, or the label
 * fallback below could never run.
 */
function byRecencyOnly(left: RacpSession, right: RacpSession): number {
  const byUpdated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  return timestamp(right.createdAt) - timestamp(left.createdAt);
}

/**
 * Group `sessions` under `projects`, each group's sessions ordered the way the
 * desktop sidebar orders them, and the groups themselves ordered by their most
 * recent session. A project with no session is not shown: an empty group adds a
 * heading the user cannot act on, and the sidebar hides those too.
 */
export function groupSessionsByProject(
  sessions: readonly RacpSession[],
  projects: readonly RacpProjectSummary[],
): SessionGroup[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const grouped = new Map<string, SessionGroup>();
  const other: SessionGroup = { key: UNGROUPED_KEY, label: null, sessions: [] };

  for (const session of sessions) {
    const project = session.projectId ? byId.get(session.projectId) : undefined;
    if (!project) {
      other.sessions.push(session);
      continue;
    }
    const existing = grouped.get(project.id);
    if (existing) {
      existing.sessions.push(session);
    } else {
      grouped.set(project.id, { key: project.id, label: project.label, sessions: [session] });
    }
  }

  const groups = [...grouped.values()];
  for (const group of groups) group.sessions.sort(byRecentActivity);
  groups.sort((left, right) => {
    const byRecent = byRecencyOnly(left.sessions[0]!, right.sessions[0]!);
    if (byRecent !== 0) return byRecent;
    const byLabel = (left.label ?? "").localeCompare(right.label ?? "");
    if (byLabel !== 0) return byLabel;
    return left.key.localeCompare(right.key);
  });
  if (other.sessions.length > 0) {
    other.sessions.sort(byRecentActivity);
    groups.push(other);
  }
  return groups;
}

/** The project a new session would go under, when the choice needs no dialog. */
export function soleProjectForNewSession(
  projects: readonly RacpProjectSummary[],
): RacpProjectSummary | null {
  const usable = projects.filter((project) => !project.archived);
  return usable.length === 1 ? usable[0]! : null;
}
