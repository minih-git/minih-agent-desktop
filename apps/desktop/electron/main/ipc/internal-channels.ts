/**
 * IPC channels reserved for Electron main's own calls.
 *
 * They are deliberately absent from `IPC.invoke`, whose values are the
 * renderer's whitelist (the preload refuses any other name), so a page cannot
 * reach them by guessing: main calls the handler map directly. Each channel
 * exists because one field of its payload is a host-side decision that must not
 * come from the renderer.
 */

/**
 * `session.create` with the provenance fields kept (ADR persisted-session-origin).
 *
 * A plugin's `session/create` is the caller: main knows the session whose turn
 * invoked it, stamps `origin: plugin` and that parent, and the renderer's own
 * `sessionCreate` channel strips the same fields instead.
 */
export const SESSION_CREATE_WITH_ORIGIN_CHANNEL =
  "minih-agent-desktop/internal/session-create-with-origin";