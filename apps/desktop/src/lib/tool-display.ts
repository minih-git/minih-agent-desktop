/**
 * The desktop's view of the shared tool presentation (see
 * `packages/shared/src/tool-presentation.ts`).
 *
 * The rules moved to `packages/shared` so the phone timeline reads a tool call
 * the same way this transcript does, and so a burst of calls folds the same way
 * on both. This module stays as the desktop's import path: a re-export, not a
 * second implementation, so there is exactly one source of truth.
 */
export {
  formatToolDuration,
  formatToolValue,
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  getToolSummaryKey,
  getToolSummaryValue,
  isAskToolName,
  isDelegationStartTool,
  delegationLifecycleKind,
  type DelegationLifecycleKind,
  type ToolAction,
} from "@minih-agent/shared";
