/**
 * Leaving a session whose device credential no longer works
 * (ADR mobile-redesign D5, bug B8).
 *
 * The session screen renders a "forget this computer and pair again" action when
 * a session is revoked, but the route that reaches that screen never passed the
 * handler, so the action was not drawn and the user was stuck on a screen that
 * could do nothing.
 *
 * The order matters and is the reason this is a function rather than two lines
 * in the screen: leaving must not wait for network work, and a failed forget
 * must be reported rather than swallowed. The credential is what blocks the
 * user, so a failure is worth the reason text.
 */

export type LeaveOutcome = { ok: true } | { ok: false; reason: string };

export type LeaveRevokedSessionOptions = {
  hostId: string;
  /** Drops the stored credential for the computer. */
  forget: (hostId: string) => Promise<void>;
  /** Moves the user off the dead end. Called before `forget` resolves. */
  onLeft: () => void;
};

export async function leaveRevokedSession(
  options: LeaveRevokedSessionOptions,
): Promise<LeaveOutcome> {
  options.onLeft();
  try {
    await options.forget(options.hostId);
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}