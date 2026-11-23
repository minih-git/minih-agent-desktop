/**
 * The `session.create` keys only Electron main may state.
 *
 * Two kinds of host-side decision travel on that payload, and neither is the
 * page's to make:
 *
 * - where a session came from — the origin columns (ADR persisted-session-origin),
 *   stamped by the `SessionCreate` tool, a plugin's `session/create`, an
 *   employee's task session and a scheduled run;
 * - the delegate role it acts in (ADR session-create-model-and-role), stamped by
 *   `SessionCreate({ agent })`.
 *
 * A renderer payload passes through {@link withoutSessionOrigin} first, which
 * drops every one of them, so the sidebar tag can never be something the page
 * invented and a page can never put a role's prompt in a session.
 */
export const SESSION_ORIGIN_KEYS = ["origin", "originSessionId", "originTaskId"] as const;

/** The origin columns plus the delegate role: everything a page may not state. */
export const TRUSTED_SESSION_CREATE_KEYS: readonly string[] = [
  ...SESSION_ORIGIN_KEYS,
  "agentName",
];

/** A copy of a renderer-supplied create input without the trusted keys. */
export function withoutSessionOrigin(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const copy = { ...(input as Record<string, unknown>) };
  for (const key of TRUSTED_SESSION_CREATE_KEYS) delete copy[key];
  return copy;
}