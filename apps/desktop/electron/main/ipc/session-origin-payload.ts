/**
 * The provenance keys a `session.create` payload may carry.
 *
 * The host stores where a session came from (ADR persisted-session-origin) and
 * only Electron main may state it: the `SessionCreate` tool, a plugin's
 * `session/create`, an employee's task session and a scheduled run each stamp
 * their own. A renderer payload passes through this function first, which drops
 * the keys, so the sidebar tag can never be something the page invented.
 */
export const SESSION_ORIGIN_KEYS = ["origin", "originSessionId", "originTaskId"] as const;

/** A copy of a renderer-supplied create input without its provenance keys. */
export function withoutSessionOrigin(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const copy = { ...(input as Record<string, unknown>) };
  for (const key of SESSION_ORIGIN_KEYS) delete copy[key];
  return copy;
}