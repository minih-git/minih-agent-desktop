export const DEFAULT_VISIBLE_PROJECT_SESSION_COUNT = 5;

/**
 * Visible count for one project group. An absent entry is the initial page; a
 * value at or below the initial page is normalized so a stale record from a
 * shrunk group can never hide rows.
 */
function visibleCountFor(counts: Record<string, number>, projectKey: string): number {
  const count = counts[projectKey];
  return typeof count === "number" && count > DEFAULT_VISIBLE_PROJECT_SESSION_COUNT
    ? count
    : DEFAULT_VISIBLE_PROJECT_SESSION_COUNT;
}

/**
 * One page of a project group's conversation list. Only the visible rows are
 * built, so a click adds one page instead of mounting the whole history.
 */
export function projectSessionPage<T>(
  sessions: T[],
  counts: Record<string, number>,
  projectKey: string,
): {
  visibleSessions: T[];
  hiddenCount: number;
  loadMoreCount: number;
  collapseAvailable: boolean;
} {
  const visibleCount = visibleCountFor(counts, projectKey);
  const visibleSessions = sessions.slice(0, visibleCount);
  const hiddenCount = Math.max(sessions.length - visibleSessions.length, 0);

  return {
    visibleSessions,
    hiddenCount,
    // The label states what this click adds, not the whole remainder.
    loadMoreCount: Math.min(DEFAULT_VISIBLE_PROJECT_SESSION_COUNT, hiddenCount),
    collapseAvailable: visibleCount > DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
  };
}

/**
 * One "load more" step: the next page, never past the group's own session count
 * and never backwards, so a group whose sessions shrank keeps its current rows.
 */
export function showMoreProjectSessions(
  counts: Record<string, number>,
  projectKey: string,
  sessionCount: number,
): Record<string, number> {
  const current = visibleCountFor(counts, projectKey);
  const next = Math.min(
    current + DEFAULT_VISIBLE_PROJECT_SESSION_COUNT,
    Math.max(sessionCount, current),
  );

  return { ...counts, [projectKey]: next };
}

/** Folding a project drops its page state, so reopening starts at the initial page. */
export function resetProjectSessionPage(
  counts: Record<string, number>,
  projectKey: string,
): Record<string, number> {
  if (!(projectKey in counts)) return counts;

  const next = { ...counts };
  delete next[projectKey];
  return next;
}
