import type { ConfigSyncPendingApproval } from "@minih-agent/shared";

/** One side of a merge conflict, as reported by the Host. */
type ConflictGroup = Extract<ConfigSyncApprovalGroup, { kind: "conflict" }>;

/**
 * A pending approval, or the two sides of one merge conflict folded into a
 * single decision. The Host keeps both conflict candidates because each one is
 * a digest-bound approval; the interface offers one choice instead of asking
 * the user to approve a side and dismiss its sibling separately.
 */
export type ConfigSyncApprovalGroup =
  | { kind: "single"; key: string; approval: ConfigSyncPendingApproval }
  | {
      kind: "conflict";
      key: string;
      baseId: string;
      label: string;
      mappingKey?: string;
      local?: ConfigSyncPendingApproval;
      remote?: ConfigSyncPendingApproval;
    };

/** Pairs conflict candidates by `conflict.baseId`, keeping first-seen order. */
export function groupConfigSyncApprovals(
  approvals: readonly ConfigSyncPendingApproval[],
): ConfigSyncApprovalGroup[] {
  const groups = new Map<string, ConfigSyncApprovalGroup>();
  for (const approval of approvals) {
    const conflict = approval.conflict;
    if (!conflict) {
      groups.set(`approval:${approval.id}`, {
        kind: "single",
        key: `approval:${approval.id}`,
        approval,
      });
      continue;
    }
    const key = `conflict:${approval.domain}:${conflict.baseId}`;
    const existing = groups.get(key);
    const group: ConflictGroup =
      existing?.kind === "conflict"
        ? existing
        : {
            kind: "conflict",
            key,
            baseId: conflict.baseId,
            label: approval.label,
            ...(approval.mappingKey === undefined ? {} : { mappingKey: approval.mappingKey }),
          };
    if (conflict.side === "local") group.local = approval;
    else group.remote = approval;
    // Either side may carry the folder mapping the user has to resolve.
    group.mappingKey ??= approval.mappingKey;
    groups.set(key, group);
  }
  return [...groups.values()];
}
