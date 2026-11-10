/**
 * Task stage derivation (ADR bot-sessions-and-steward §4).
 *
 * A delivery's ledger `status` answers "did the turn finish". A *stage* answers
 * the only other question a person supervising several employees acts on:
 * "who is holding this right now". They are separate vocabularies on purpose,
 * and neither is derived from the other.
 *
 * The table below is the order of the dsh stage table: first match wins. The
 * one rule that decides whether a stage may disturb the person is that only
 * `person/*` does — everything else is either the machine's problem or the
 * worker's, and both are shown without a notification.
 *
 * This module is pure: no clock, no storage, no network. The host owns the
 * written value and its monotonic sequence; this only computes what that value
 * should be from records the host already has.
 */

import type { TaskReport, TaskStage } from "./bot-session.js";

/** What the ledger knows about one delivery when a stage is computed. */
export type StageInputs = {
  /** Ledger delivery status. */
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  /** The worker's latest structured report, if it ever reported. */
  report?: TaskReport | null;
  /**
   * The worker is inside a turn that is blocked on a permission card or a
   * structured question — the host knows this from the turn, not from text.
   */
  waitingOnPerson?: boolean;
  /** The task finished and the person has not accepted the result yet. */
  awaitingAcceptance?: boolean;
  /** The delivery is held back by a person-configured trigger or a schedule. */
  waitingForTrigger?: boolean;
  /** The repository lock is held by another task on the same origin. */
  repositoryBusy?: boolean;
};

/**
 * Derive the stage, first match wins.
 *
 * Read the rows top to bottom; the first one that is true is the answer. A
 * later row never overrides an earlier one, which is what keeps a person-owned
 * stage visible above a mechanical one: a delivery that is blocked *and* waiting
 * for an answer is reported as waiting for the answer.
 */
export function deriveStage(input: StageInputs): TaskStage {
  // 1. Waiting for a person to answer a question or an approval.
  if (input.waitingOnPerson) return "person/answer";
  // 2. Waiting for a person to accept finished work.
  if (input.awaitingAcceptance) return "person/accept";
  // 3. Blocked or failed.
  //    A worker's own "blocked" is its stage; a failed turn is the machine's.
  if (input.report === "failed" || input.status === "failed") return "failed";
  if (input.report === "blocked") return "blocked";
  // 4. Queued, machine-bound, or held by another task on the same repository.
  if (
    input.report === "waiting" ||
    input.repositoryBusy ||
    input.status === "queued" ||
    input.status === "interrupted"
  ) {
    return "queued";
  }
  // 5. Waiting for a trigger the person configured.
  if (input.waitingForTrigger) return "waiting";
  // 6. Working. `ready` and `dropped` are ends of work the person still has to
  //    accept, which the caller signals with `awaitingAcceptance`; without that
  //    signal there is nothing left running, so the task is not `working`.
  if (input.report === "progress" || input.status === "running") return "working";
  return "waiting";
}

/**
 * The report a stage implies, so a caller that only has a stage can still write
 * a consistent ledger row.
 */
export function reportForStage(stage: TaskStage): TaskReport {
  switch (stage) {
    case "person/answer":
      return "waiting";
    case "person/accept":
      return "ready";
    case "blocked":
    case "failed":
      return "failed";
    case "queued":
      return "waiting";
    case "waiting":
      return "waiting";
    case "working":
      return "progress";
  }
}
