import type {
  TaskDeliveryCheck,
  TaskDeliveryReason,
  TaskDeliveryStep,
  TaskUsage,
  TaskView,
} from "@minih-agent/shared";

/**
 * What the completion card decides, without React (employee mode 0.5 slice 4b).
 *
 * The rules are the ones a person can observe, so they live here where a test
 * can hold them: which task shows a completion card, which cards form one batch,
 * what a greyed merge button says, and how the host's numbers are written. The
 * components render; this module decides.
 */

/**
 * Whether the task session shows a completion card.
 *
 * One slot, one card: `person/accept` is the only stage where the work is
 * finished and undecided. A task that was accepted keeps its card (the merge is
 * still reachable from it); a task that stopped shows the blocked card instead,
 * and the two never appear together.
 */
export function showsCompletionCard(task: TaskView | null | undefined): boolean {
  if (!task || task.archivedAt) return false;
  return task.stage === "person/accept";
}

/** Whether the person already said the work is acceptable. */
export function isAccepted(task: TaskView | null | undefined): boolean {
  return Boolean(task?.acceptedAt);
}

/** One batch: a sentence the steward split into several cards. */
export type TaskBatch = {
  batchId: string;
  /** In the order the cards were proposed, which is the order to merge them. */
  tasks: TaskView[];
};

function cardOrder(left: TaskView, right: TaskView): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.shortId.localeCompare(right.shortId)
  );
}

/**
 * The batches whose summary card appears.
 *
 * Three conditions, all of them the design's: **at least two** tasks (one card
 * is not a batch, it is a card), **one batch id** (filled by Main from the turn
 * that proposed them), and **every task finished** — `person/accept`, whether or
 * not it was accepted. A batch with one task still running is not summarised,
 * because the person cannot decide about it yet.
 */
export function taskBatches(tasks: readonly TaskView[]): TaskBatch[] {
  const grouped = new Map<string, TaskView[]>();
  for (const task of tasks) {
    const batch = task.batchId?.trim();
    if (!batch || task.archivedAt || task.stage !== "person/accept") continue;
    const list = grouped.get(batch) ?? [];
    list.push(task);
    grouped.set(batch, list);
  }
  return [...grouped.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([batchId, list]) => ({ batchId, tasks: [...list].sort(cardOrder) }))
    .sort((left, right) => cardOrder(left.tasks[0], right.tasks[0]));
}

/** The tasks a batch summary would act on, in merge order. */
export function batchMergeOrder(batch: TaskBatch): TaskView[] {
  return batch.tasks;
}

/**
 * The i18n key of a greyed merge button's reason.
 *
 * The host answers with a code, never a sentence: the same verdict has to read
 * in the person's own language, and a stored English sentence cannot be
 * translated later.
 */
export function gateReasonKey(reason: TaskDeliveryReason | undefined): string {
  switch (reason) {
    case "pr-missing":
      return "bots.completion.reason.prMissing";
    case "pr-unreadable":
      return "bots.completion.reason.prUnreadable";
    case "ci-missing":
      return "bots.completion.reason.ciMissing";
    case "ci-running":
      return "bots.completion.reason.ciRunning";
    case "ci-failed":
      return "bots.completion.reason.ciFailed";
    case "conflict":
      return "bots.completion.reason.conflict";
    case "mergeable-unknown":
      return "bots.completion.reason.mergeableUnknown";
    case "review-required":
      return "bots.completion.reason.reviewRequired";
    case "no-project":
      return "bots.completion.reason.noProject";
    case "conflict-local":
      return "bots.completion.reason.conflictLocal";
    case "nothing-to-merge":
      return "bots.completion.reason.nothingToMerge";
    case "preview-failed":
      return "bots.completion.reason.previewFailed";
    default:
      return "bots.completion.reason.unknown";
  }
}

/** The one name a reason needs: the failed check, the detail `gh` gave. */
export function gateReasonDetail(check: TaskDeliveryCheck | null | undefined): string {
  if (!check) return "";
  if (check.reason === "ci-failed" && check.checks?.failed.length) {
    return check.checks.failed.join(", ");
  }
  return check.reasonDetail ?? "";
}

/** Whether the merge button may be clicked right now. */
export function canMergeNow(check: TaskDeliveryCheck | null | undefined): boolean {
  return Boolean(check?.canMerge);
}

/**
 * How a delivery's last step is written on the blocked card.
 *
 * `published` is the difference the person needs: before the push nothing left
 * the machine, after it the merge is on GitHub and only another remote is
 * behind. The host says which, the card says it in the person's language.
 */
export function deliveryFailure(
  task: TaskView | null | undefined,
): { step: string; detail: string } | null {
  const blocker = task?.blocker;
  if (!blocker || blocker.reason !== "delivery") return null;
  return { step: blocker.step ?? "", detail: blocker.detail ?? "" };
}

/** Whether the blocked card's 重试 means "run the delivery again". */
export function retryResumesDelivery(task: TaskView | null | undefined): boolean {
  return deliveryFailure(task) !== null;
}

/** The steps a delivery recorded, newest last, for the card's own record. */
export function deliverySteps(task: TaskView | null | undefined): TaskDeliveryStep[] {
  return task?.delivery?.steps ?? [];
}

/** Whole hours and minutes, so the card never prints `0.32 小时`. */
export function elapsedParts(ms: number | undefined): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) };
}

/**
 * The tokens and the money, when the ledger has them.
 *
 * A usage with no reported cost shows tokens only: `$0.00` would be a claim the
 * host cannot make.
 */
export function usageSummary(
  usage: TaskUsage | null | undefined,
): { tokens: number; costUsd?: number } | null {
  if (!usage) return null;
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens === 0 && usage.turns === 0) return null;
  return {
    tokens,
    ...(typeof usage.costUsd === "number" && usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
  };
}

/** `@minih-agent/shared`'s predicate, re-exported so a caller needs one import. */
export { taskCountsAsWaiting } from "@minih-agent/shared";
