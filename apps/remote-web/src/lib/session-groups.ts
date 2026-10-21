/**
 * The two layers of navigation, as pure functions (spec §17.2, §17.3).
 *
 * The desktop sidebar leads with projects and lists each project's sessions
 * under it; the phone used to flatten that into one list with collapsible
 * headings, which made choosing a session a reading exercise. §17 splits it into
 * two pages, and this module is the arithmetic behind both:
 *
 * - `summarizeProjects` turns `session/list` + `project/list` into the cards of
 *   S5: how many sessions a project holds, how many need the user, how many are
 *   running, and when it last moved.
 * - `projectSessions` is S5b: one project's sessions in the order the page shows
 *   them (newest first within a section, and the sections themselves are the
 *   screen's job).
 *
 * Both take the state of a session as a function rather than reading it here,
 * because "needs your answer" and "finished but not looked at" depend on what
 * this device has seen (`session-state.ts`) and on what the Host reported. That
 * keeps this file pure and testable without a store.
 *
 * Sessions without a `projectId`, and sessions whose project has left the
 * catalog or was archived, land in one trailing "Other" card, so nothing ever
 * disappears.
 */
import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";

import type { SessionStateView } from "./session-state.js";

/** The key used for the trailing "Other" card; never collides with a project id. */
export const UNGROUPED_KEY = "__other__";

export type ProjectSummary = {
  /** The Host project id, or `UNGROUPED_KEY` for the trailing card. */
  key: string;
  /** Absent for "Other", which is not a project. */
  projectId?: string;
  /** The project label, or `null` for "Other" (the screen localizes it). */
  label: string | null;
  /** True for the trailing "Other" card. */
  other: boolean;
  total: number;
  /** Sessions in the two attention states. */
  waiting: number;
  running: number;
  /** Newest `updatedAt` among the project's sessions, absent when it has none. */
  lastActivity?: string;
};

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Newest activity first, then newest created, then id — stable across refreshes. */
function byRecentActivity(left: RacpSession, right: RacpSession): number {
  const byUpdated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  const byCreated = timestamp(right.createdAt) - timestamp(left.createdAt);
  if (byCreated !== 0) return byCreated;
  return left.id.localeCompare(right.id);
}

/**
 * How far down the page a card belongs. One comparator rather than four
 * branches: a project with no session has no newest session either, so the last
 * band falls out of the same comparison.
 *
 * "Other" is pinned to its own band, below everything: a stray session parked
 * there must never push a real project down the page.
 */
function bandOf(summary: ProjectSummary): number {
  if (summary.other) return 4;
  if (summary.waiting > 0) return 0;
  if (summary.running > 0) return 1;
  return 2;
}

/**
 * One card per project the phone should show, ordered the way §17.2 states:
 * something waiting first, then something running, then by recent activity, and
 * a project with no session last.
 *
 * A project with no session is shown on purpose, unlike §8.6's empty heading: it
 * is now a destination with an action (start a session there) rather than a
 * title the user cannot act on. Archived projects stay out, and their sessions
 * fall into "Other".
 */
export function summarizeProjects(
  sessions: readonly RacpSession[],
  projects: readonly RacpProjectSummary[],
  state: (session: RacpSession) => SessionStateView,
): ProjectSummary[] {
  const visible = new Map(projects.filter((project) => !project.archived).map((project) => [project.id, project]));
  const byKey = new Map<string, ProjectSummary>();
  const other: ProjectSummary = { key: UNGROUPED_KEY, label: null, other: true, total: 0, waiting: 0, running: 0 };
  const buckets = new Map<string, RacpSession[]>();

  for (const session of sessions) {
    const project = session.projectId ? visible.get(session.projectId) : undefined;
    const key = project ? project.id : UNGROUPED_KEY;
    const list = buckets.get(key);
    if (list) list.push(session);
    else buckets.set(key, [session]);
  }

  for (const project of visible.values()) {
    byKey.set(project.id, {
      key: project.id,
      projectId: project.id,
      label: project.label,
      other: false,
      total: 0,
      waiting: 0,
      running: 0,
    });
  }
  byKey.set(UNGROUPED_KEY, other);

  for (const [key, list] of buckets) {
    const summary = byKey.get(key);
    if (!summary) continue;
    list.sort(byRecentActivity);
    summary.total = list.length;
    summary.lastActivity = list[0]?.updatedAt;
    for (const session of list) {
      const view = state(session);
      if (view === "approval" || view === "input") summary.waiting += 1;
      else if (view === "running") summary.running += 1;
    }
  }

  const summaries = [...byKey.values()].filter((summary) => summary.other ? summary.total > 0 : true);
  summaries.sort((left, right) => {
    const band = bandOf(left) - bandOf(right);
    if (band !== 0) return band;
    const byActivity = timestamp(right.lastActivity) - timestamp(left.lastActivity);
    if (byActivity !== 0) return byActivity;
    const byLabel = (left.label ?? "").localeCompare(right.label ?? "");
    if (byLabel !== 0) return byLabel;
    return left.key.localeCompare(right.key);
  });
  return summaries;
}

/** One project's sessions, newest first — the order inside every section. */
export function projectSessions(sessions: readonly RacpSession[], projectId: string): RacpSession[] {
  return sessions.filter((session) => session.projectId === projectId).sort(byRecentActivity);
}

/**
 * The project a new session would go under, when the choice needs no dialog.
 * Also what decides whether the project list is skipped on the way to its
 * sessions (spec §17.3): one usable project means one destination, not a list
 * with one row.
 */
export function soleProjectForNewSession(projects: readonly RacpProjectSummary[]): RacpProjectSummary | null {
  const usable = projects.filter((project) => !project.archived);
  return usable.length === 1 ? usable[0]! : null;
}
