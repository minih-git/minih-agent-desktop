import type { SessionSummary } from "@minih-agent/shared";

/**
 * Where a session came from (ADR persisted-session-origin).
 *
 * The host stores the origin on the session row and reports it on every
 * summary. `user` is the person opening a conversation; the other four name the
 * creator. A summary from an older host has no `origin` at all, which is the
 * same thing as one the person opened.
 */
export const SESSION_ORIGINS = ["user", "agent", "plugin", "task", "scheduled"] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

function isSessionOrigin(value: unknown): value is SessionOrigin {
  return typeof value === "string" && (SESSION_ORIGINS as readonly string[]).includes(value);
}

/** The session's origin, with the missing/unknown case read as `user`. */
export function sessionOrigin(
  session: Pick<SessionSummary, "origin"> | null | undefined,
): SessionOrigin {
  return isSessionOrigin(session?.origin) ? session.origin : "user";
}

/**
 * The origins a stored filter selects.
 *
 * A missing list (a preference written before the filter existed), a malformed
 * one, or an empty one means "everything": the sidebar must never open empty
 * because a preference could not be read.
 */
export function normalizeOrigins(raw: unknown): SessionOrigin[] {
  if (!Array.isArray(raw)) return [...SESSION_ORIGINS];
  const selected = SESSION_ORIGINS.filter((origin) => raw.includes(origin));
  return selected.length > 0 ? selected : [...SESSION_ORIGINS];
}

/** True when the filter hides at least one origin, which the menu button shows. */
export function originFilterActive(origins: readonly SessionOrigin[]): boolean {
  return normalizeOrigins(origins).length !== SESSION_ORIGINS.length;
}

/** Whether a session survives the origin filter. */
export function sessionMatchesOrigins(
  session: Pick<SessionSummary, "origin"> | null | undefined,
  origins: readonly SessionOrigin[],
): boolean {
  return normalizeOrigins(origins).includes(sessionOrigin(session));
}

/** The label key of a tag, or null for the origin that shows no tag. */
export function originLabelKey(origin: SessionOrigin): string | null {
  switch (origin) {
    case "agent":
      return "nav.originAgent";
    case "plugin":
      return "nav.originPlugin";
    case "task":
      return "nav.originTask";
    case "scheduled":
      return "nav.originScheduled";
    default:
      return null;
  }
}

/**
 * The tooltip key and its one interpolation.
 *
 * A creator session that no longer exists keeps its tag but loses its title, so
 * the wording has to say so instead of showing an empty pair of quotes.
 */
export function originTooltip(session: Pick<SessionSummary, "origin" | "originSession" | "originTaskId" | "title">): {
  key: string;
  title?: string;
} {
  switch (sessionOrigin(session)) {
    case "agent":
    case "plugin":
    case "task": {
      const source = session.originSession;
      if (!source || !source.available || !source.title) return { key: "nav.originDispatchedByDeleted" };
      return { key: "nav.originDispatchedBy", title: source.title };
    }
    // A run names its task rather than a session; its own title is the task's
    // title, because `scheduled.run` creates the transcript with it.
    case "scheduled":
      return { key: "nav.originScheduledTooltip", title: session.title };
    default:
      return { key: "nav.originUser" };
  }
}