import type { FinishTurn } from "./plans";

/**
 * The cancellation contract every abort path shares.
 *
 * A cancelled turn still ends with a terminal runtime event that carries no
 * failure: the runtime simply stops the reply. The only thing separating an
 * interruption from a completion is the reason recorded *before* the cancel
 * request leaves — [`finishTurn`](./plans.ts) reads it through
 * `peekAbortReason`, and Agent Host reads it through `markAborting`. The
 * in-app Stop and the quit path therefore share these two functions instead
 * of each restating the rules. A running turn that ends because the app is
 * closing must never settle as `completed`: that would also file a
 * `task.completed` notification for work the user never received.
 */
export type TurnFinalizeDeps = {
  finishTurn: FinishTurn;
};

export type TurnInterruptDeps = TurnFinalizeDeps & {
  /** Freeze the turn's terminal reason; a turn that no longer owns its session locks nothing. */
  lockAbortReason: (sessionId: string, turnId: string | null | undefined) => void;
  /** Let Agent Host read the following `agent_end` as interrupted. */
  markAborting?: (sessionId: string) => void;
};

/**
 * Record the interruption before the cancel request is issued. Both records
 * are synchronous on purpose: a terminal event arriving while the cancel RPC
 * is in flight must find the reason already frozen.
 *
 * Agent Host learns the session is cancelling even when the turn identity is
 * not known yet (a Stop pressed while the runtime is still admitting the
 * prompt); the reason itself can only be frozen for a named turn.
 */
export function markTurnInterrupted(
  { lockAbortReason, markAborting }: TurnInterruptDeps,
  sessionId: string,
  turnId: string | null | undefined,
): void {
  const id = sessionId.trim();
  if (!id) return;
  markAborting?.(id);
  const turn = String(turnId ?? "").trim();
  if (turn) lockAbortReason(id, turn);
}

/**
 * Settle the turn an interruption marked. `finishTurn` joins an existing
 * finalization, so this is safe after the terminal event already settled the
 * turn, and it keeps the durable row from staying `running` if that event
 * never lands.
 */
export function settleInterruptedTurn(
  { finishTurn }: TurnFinalizeDeps,
  sessionId: string,
  turnId: string | null | undefined,
): Promise<void> {
  const id = sessionId.trim();
  const turn = String(turnId ?? "").trim();
  if (!id || !turn) return Promise.resolve();
  return finishTurn(id, "aborted", "TURN_ABORTED", { turnId: turn });
}
