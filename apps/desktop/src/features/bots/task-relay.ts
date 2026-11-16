import type { TaskOverlap, TaskView } from "@minih-agent/shared";
type Translate = (key: string, options?: Record<string, unknown>) => string;

export function shortLabel(id: string | undefined): string {
  if (!id) return "";
  return id.split("-")[0].slice(0, 6);
}



/** Where a task sits in its chain; a task in no chain is 1 of 1. */
export function relayPosition(task: TaskView): { step: number; total: number; isLast: boolean } {
  const total = Math.max(task.relayTotal ?? 1, 1);
  const step = Math.min(Math.max(task.relayStep ?? 1, 1), total);
  return { step, total, isLast: step >= total };
}

/**
 * The chains among a batch of tasks, first step to last.
 *
 * A batch is one turn's cards; a chain is the ordered subset of them. Grouping
 * here rather than in the summary card keeps "one chain is one row" a fact about
 * the data instead of a rendering trick.
 */
export function chainRows(tasks: readonly TaskView[]): {
  chain: TaskView[];
  lonely: TaskView[];
} {
  const byParent = new Map<string, TaskView>();
  for (const task of tasks) {
    if (task.relayParentTaskId) byParent.set(task.relayParentTaskId, task);
  }
  const childIds = new Set(byParent.values().map((task) => task.id).filter(Boolean));
  const chains: TaskView[][] = [];
  const lonely: TaskView[] = [];
  for (const task of tasks) {
    // A chain is walked from its head: the step nobody follows.
    if (task.relayParentTaskId && tasks.some((other) => other.id === task.relayParentTaskId)) {
      continue;
    }
    const chain: TaskView[] = [task];
    let next = byParent.get(task.id);
    while (next) {
      chain.push(next);
      next = byParent.get(next.id);
    }
    if (chain.length > 1) chains.push(chain);
    else if (!childIds.has(task.id)) lonely.push(task);
  }
  return { chain: chains.flat(), lonely };
}

/** Ordered chain rows, each with its short labels, for the summary card. */
export function chainLines(
  tasks: readonly TaskView[],
  translate: Translate,
): { ids: string[]; text: string }[] {
  const { chain } = chainRows(tasks);
  const heads = chain.filter(
    (task) => !task.relayParentTaskId || !chain.some((other) => other.id === task.relayParentTaskId),
  );
  const rows: { ids: string[]; text: string }[] = [];
  for (const head of heads) {
    const ids: string[] = [];
    let cursor: TaskView | undefined = head;
    while (cursor) {
      ids.push(cursor.id);
      const current: TaskView = cursor;
      cursor = chain.find((task) => task.relayParentTaskId === current.id);
    }
    if (ids.length < 2) continue;
    rows.push({
      ids,
      text: translate("bots.completion.chainTitle", {
        chain: ids.map((id) => `#${shortLabel(id)}`).join(" → "),
      }),
    });
  }
  return rows;
}

/**
 * The dock's one-line hint about other tasks in the same repository.
 *
 * A warning, never a refusal: a person who is told can still decide the two
 * changes are unrelated. A read that failed says so — "nobody else touches this
 * file" and "nobody could tell" lead to opposite decisions.
 */
export function overlapHint(overlap: TaskOverlap | null, translate: Translate): string | null {
  if (!overlap) return null;
  if (!overlap.readable) return translate("bots.card.overlapUnreadable");
  if (overlap.tasks.length === 0) return null;
  const shown = overlap.tasks.slice(0, 3).map((task) =>
    translate("bots.card.overlapRow", {
      shortId: task.shortId,
      count: task.fileCount,
    }),
  );
  const rest = overlap.tasks.length - shown.length;
  if (rest > 0) {
    shown.push(translate("bots.completion.overlapMore", { count: rest }));
  }
  return translate("bots.card.overlapOthers", {
    count: overlap.tasks.length,
    list: shown.join("、"),
  });
}

/**
 * The completion card's rows: which files two tasks both change.
 *
 * Only the shared paths are named, capped by the host, because the person is
 * looking for the collision and not for either task's full change list.
 */
export function overlapRows(
  overlap: TaskOverlap | null,
  translate: Translate,
): { key: string; text: string }[] {
  if (!overlap) return [];
  if (!overlap.readable) {
    return [{ key: "unreadable", text: translate("bots.completion.overlapUnreadable", { reason: "" }) }];
  }
  return overlap.intersections.map((entry) => ({
    key: entry.taskId,
    text: translate("bots.completion.overlapSame", {
      shortId: entry.shortId,
      files: entry.files.join("、"),
    }),
  }));
}

/**
 * What a blocked relay step says, or null for any other kind of blocker.
 *
 * Two ways a step loses its predecessor — abandoned, or its branch is gone — and
 * both offer the same two decisions: start from main, or drop it.
 */
export function relayBlockerText(
  blocker: { reason?: string; parent?: string } | null | undefined,
  translate: Translate,
): string | null {
  if (!blocker) return null;
  if (blocker.reason === "relay-orphaned") {
    return translate("bots.blocked.relayOrphaned", { shortId: blocker.parent ?? "" });
  }
  if (blocker.reason === "relay-base") {
    return translate("bots.blocked.relayBase", { shortId: blocker.parent ?? "" });
  }
  return null;
}

/** Whether a blocked card is a relay step whose predecessor cannot be continued. */
export function isRelayBlocked(blocker: { reason?: string } | null | undefined): boolean {
  return blocker?.reason === "relay-orphaned" || blocker?.reason === "relay-base";
}

/** One row of a batch summary: a whole chain, or a single task. */
export type BatchRow = {
  /** The tasks this row covers, first step to last (one entry for a single task). */
  tasks: TaskView[];
  /** True when the row is a chain, so it is handed on rather than merged whole. */
  chain: boolean;
};

/**
 * The summary card's rows, in the order the batch was proposed.
 *
 * A chain occupies one row: three steps of one change are one decision, and
 * three rows inviting three merges is exactly the mistake the relay exists to
 * avoid. A row sits where its first task sat in the merge order.
 */
export function batchRows(
  tasks: readonly TaskView[],
  order: readonly TaskView[],
): BatchRow[] {
  const byParent = new Map<string, TaskView>();
  for (const task of tasks) {
    if (task.relayParentTaskId) byParent.set(task.relayParentTaskId, task);
  }
  const rows: BatchRow[] = [];
  const placed = new Set<string>();
  for (const task of order) {
    if (placed.has(task.id)) continue;
    const chain: TaskView[] = [];
    // A row is anchored at the head of its chain; a middle step whose head is
    // already placed contributes nothing.
    if (!task.relayParentTaskId || !tasks.some((other) => other.id === task.relayParentTaskId)) {
      chain.push(task);
      let cursor = byParent.get(task.id);
      while (cursor) {
        chain.push(cursor);
        cursor = byParent.get(cursor.id);
      }
    }
    const covered = chain.length > 0 ? chain : [task];
    for (const step of covered) placed.add(step.id);
    rows.push({ tasks: covered, chain: covered.length > 1 });
  }
  return rows;
}

/** The label of one summary row: 「#a → #b」 for a chain, 「#a」 for a task. */
export function rowLabel(row: BatchRow): string {
  return row.tasks.map((task) => `#${task.shortId}`).join(" → ");
}