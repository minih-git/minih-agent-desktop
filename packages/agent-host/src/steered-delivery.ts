/**
 * The ledger half of an accepted steering delivery (schema v46).
 *
 * `send now` folds a queued delivery into the turn that is already running
 * (ADR 0265). The content is in the transcript from that moment on, but the
 * ledger row still says `queued` unless someone tells it otherwise — and the
 * next drain then starts a second turn for the same content, which is how one
 * completion used to be reported twice.
 *
 * This is the one place that tells the host, so Electron Main and the headless
 * `agent-host-cli` cannot drift.
 */

/** Host-core RPC surface this needs; a Host process or the bridge satisfies it. */
export type SteeredDeliveryHost = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type SteeredDelivery = {
  /** The session whose running turn took the input. */
  sessionId: string;
  /** That turn's host turn id (the id the runtime and `session.collaboration.settle` use). */
  turnId: string;
  /** The ledger row the input carries. */
  sessionMessageId: string;
};

export type SteeredDeliveryLog = (
  level: "info" | "warn",
  message: string,
  data?: Record<string, unknown>,
) => void;

/**
 * Claim the row for the turn that accepted it.
 *
 * A failed claim is not swallowed: it is logged, and the row is failed rather
 * than left `queued`, because `queued` is exactly the state a later drain acts
 * on — it would deliver work the transcript already holds a second time. The
 * failure write only touches a row that is still `queued`, so a row that was
 * claimed or cancelled in the meantime is left alone.
 */
export async function claimSteeredDelivery(
  host: SteeredDeliveryHost,
  delivery: SteeredDelivery,
  log: SteeredDeliveryLog,
): Promise<void> {
  const { sessionId, turnId, sessionMessageId } = delivery;
  try {
    await host.call("session.collaboration.steered", {
      messageId: sessionMessageId,
      sessionId,
      turnId,
    });
    return;
  } catch (error) {
    log("warn", "steered delivery could not be claimed", {
      sessionId,
      turnId,
      messageId: sessionMessageId,
      error: String(error),
    });
  }
  try {
    await host.call("session.collaboration.fail", {
      messageId: sessionMessageId,
      error: `STEERED_CLAIM_FAILED: the delivery was folded into turn ${turnId} but its ledger row could not be updated`,
    });
  } catch (error) {
    log("warn", "steered delivery claim failure could not be recorded", {
      sessionId,
      messageId: sessionMessageId,
      error: String(error),
    });
  }
}