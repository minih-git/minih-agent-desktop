import type { LearnedMemoryCurationOp, LearnedMemoryRevision } from "@minih-agent/shared";

/**
 * Pure decisions for "recently curated" (ADR learned-memory-consolidation §3).
 *
 * The dialog is thin around these, so what matters is testable without a DOM:
 * how a batch reads, which operation a batch actually was, and when an undo was
 * refused because the note moved.
 */

/** The error code a refused call carries, whichever layer reported it. */
function errorCode(error: unknown): string {
  const withCode = error as { errorCode?: unknown; data?: { errorCode?: unknown } } | null;
  const code = withCode?.errorCode ?? withCode?.data?.errorCode;
  return typeof code === "string" ? code : "";
}

/**
 * A note that changed after the pass: the undo changed nothing, and the user
 * has to be told why rather than have the note quietly rewritten.
 */
export function undoConflict(error: unknown): boolean {
  return errorCode(error) === "MEMORY_UNDO_CONFLICT";
}

/** The window the block summarizes, in days. */
export const CURATION_WINDOW_DAYS = 7;

/**
 * The title line. A count of zero is not "0 changes": the block says what it is
 * and that nothing happened, which is easier to read than a bare number.
 */
export function curationTitle(changes: number): string {
  const one = changes === 1;
  return one
    ? "memory.curationSummaryOne"
    : changes === 0
      ? "memory.curationSummaryNone"
      : "memory.curationSummary";
}

/**
 * What one undo reverses, in the terms the reminder names: a merge records a
 * row for the new note and one per archived target, and all of them are one
 * "merged".
 */
export type CurationKind = "activate" | "merge" | "replace" | "reword";

/** One batch: the rows one undo would reverse. */
export type CurationBatch = {
  batchId: string;
  kind: CurationKind;
  rows: LearnedMemoryRevision[];
  createdAt: number;
  undone: boolean;
};

/**
 * Group the flat rows into batches, newest first, and name each batch by the
 * operation the user will recognize: an activation, a merge, a replace, or a
 * rewrite. A merge records one row for the new note and one per archived
 * target; all of them are "merged", so the first recognized kind wins.
 */
export function groupCurationBatches(records: LearnedMemoryRevision[]): CurationBatch[] {
  const byBatch = new Map<string, CurationBatch>();
  for (const record of records) {
    const existing = byBatch.get(record.batchId);
    if (existing) {
      existing.rows.push(record);
      existing.createdAt = Math.min(existing.createdAt, record.createdAt);
      existing.undone = existing.undone && record.undoneAt !== undefined;
      continue;
    }
    byBatch.set(record.batchId, {
      batchId: record.batchId,
      kind: batchOp(record.op),
      rows: [record],
      createdAt: record.createdAt,
      undone: record.undoneAt !== undefined,
    });
  }
  return [...byBatch.values()]
    .map((batch) => ({
      ...batch,
      // An activation and a rewrite are the note's own row; a merge or a
      // replace is recognized from its archive rows.
      kind: batch.rows.some((row) => row.op === "merge_archive")
        ? ("merge" as const)
        : batch.rows.some((row) => row.op === "replace_archive")
          ? ("replace" as const)
          : batch.kind,
      rows: [...batch.rows].sort((a, b) => a.id - b.id),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function batchOp(op: LearnedMemoryCurationOp): CurationKind {
  switch (op) {
    case "merge_new":
    case "merge_archive":
      return "merge";
    case "replace_archive":
      return "replace";
    case "activate":
      return "activate";
    default:
      return "reword";
  }
}

/** Whether the block has anything to show at all. */
export function showsCuration(records: LearnedMemoryRevision[] | null): boolean {
  return records !== null && groupCurationBatches(records).length > 0;
}
