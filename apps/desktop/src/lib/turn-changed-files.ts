import type { ReviewChangeStatus, UiMessage } from "@minih-agent/shared";
import { reviewChangeFromMessage } from "./workspace-review.ts";

export const TURN_CHANGES_VISIBLE_LIMIT = 12;
export const TURN_CHANGES_RELAXED_LIMIT = 4;
export type TurnChangedFile = {
  path: string;
  status: ReviewChangeStatus;
  additions: number;
  deletions: number;
  rolledBack: boolean;
  snapshotIds: string[];
};
export type TurnChangesSummary = {
  files: TurnChangedFile[];
  directoryCount: number;
  additions: number;
  deletions: number;
};

/** Aggregate only durable workspace review evidence, never current Git state. */
export function summarizeTurnChanges(tools: readonly UiMessage[]): TurnChangesSummary {
  const byPath = new Map<string, TurnChangedFile>();
  const created = new Set<string>();
  for (const message of tools) {
    const change = reviewChangeFromMessage(message);
    if (!change) continue;
    const rolledBack = change.state === "rolledBack";
    if (change.status === "added") created.add(change.path);
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, { path: change.path, status: change.status,
        additions: change.additions, deletions: change.deletions,
        rolledBack, snapshotIds: [change.snapshotId] });
      continue;
    }
    existing.additions += change.additions;
    existing.deletions += change.deletions;
    existing.rolledBack &&= rolledBack;
    existing.snapshotIds.push(change.snapshotId);
    existing.status = change.status === "deleted" ? "deleted" : created.has(change.path) ? "added" : "modified";
  }
  const files = [...byPath.values()];
  return {
    files,
    directoryCount: new Set(files.map(({ path }) => path.slice(0, Math.max(0, path.lastIndexOf("/"))))).size,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}
