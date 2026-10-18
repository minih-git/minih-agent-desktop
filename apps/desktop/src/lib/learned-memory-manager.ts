import type {
  LearnedMemoryEntry,
  LearnedMemoryKind,
  LearnedMemoryListRequest,
  LearnedMemoryScopeKind,
  LearnedMemoryStatus,
} from "@minih-agent/shared";

/**
 * Pure decisions for the learned-memory manager (ADR agent-long-term-memory
 * §3.2). The dialog is thin around these, so the rules that matter — what a
 * request asks for, when an edit conflicts, when Escape closes, and whether
 * the list is empty — are testable without a DOM.
 */

/** What one list read asks for: one scope, optional filters. */
export function managerRequest(options: {
  scope: LearnedMemoryScopeKind;
  projectPath?: string;
  status?: LearnedMemoryStatus | "";
  kind?: LearnedMemoryKind | "";
}): LearnedMemoryListRequest {
  return {
    scope: options.scope,
    // A project scope is filtered by the project the menu was opened from; the
    // user scope needs no path, and passing one would be a scope it did not ask
    // for.
    ...(options.scope === "project" && options.projectPath
      ? { path: options.projectPath }
      : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
  };
}

/** The stable error code a refused call carries, whichever layer reported it. */
export function memoryErrorCode(error: unknown): string {
  const withCode = error as { errorCode?: unknown; data?: { errorCode?: unknown } } | null;
  const code = withCode?.errorCode ?? withCode?.data?.errorCode;
  return typeof code === "string" ? code : "";
}

/**
 * An edit carries the revision it read. When another writer moved past it the
 * host refuses with `MEMORY_REVISION_CONFLICT`, and the manager says so and
 * reloads instead of overwriting what that writer stored.
 */
export function editConflicted(error: unknown): boolean {
  return memoryErrorCode(error) === "MEMORY_REVISION_CONFLICT";
}

/** Escape closes the manager unless a request is in flight. */
export function escapeCloses(key: string, busy: boolean): boolean {
  return key === "Escape" && !busy;
}

/** No entries is a state of its own, not an empty list to render. */
export function showsEmptyState(entries: LearnedMemoryEntry[] | null): boolean {
  return entries !== null && entries.length === 0;
}

/**
 * A note that came from a conversation can open it; one the user wrote in the
 * manager has no session to show.
 */
export function sourceSessionOf(entry: LearnedMemoryEntry): string | undefined {
  const id = entry.sourceSessionId;
  return typeof id === "string" && id ? id : undefined;
}
