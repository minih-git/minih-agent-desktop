import type { ProjectMemory } from "./filesystem.js";

/** Shared public types grouped by the owning application domain. */
/**
 * Durable inbox families. `task.*` names a settled turn; `prompt.*` names an
 * interactive request the runtime is blocked on, so a reminder survives a
 * missed toast, a hidden window, or a restart.
 */
export type AppNotificationKind =
  | "task.completed"
  | "task.failed"
  | "prompt.ask"
  | "prompt.permission"
  | "prompt.plan";

export type AppNotification = {
  id: string;
  kind: AppNotificationKind;
  sessionId: string;
  sessionTitle: string;
  /** Present for settled-turn rows only. */
  turnId?: string;
  /** Present for prompt rows; the runtime's id for the pending request. */
  requestId?: string;
  /** Present for prompt rows that ask about one tool. */
  toolName?: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string | null;
};

export type NotificationListResult = {
  notifications: AppNotification[];
  unreadCount: number;
};

export type RemoteWorkspace = { hostKey: string; path: string };

export type ProjectWorkspace = {
  remote?: RemoteWorkspace;
  path: string;
  name: string;
  /** Best-effort git branch from .git/HEAD when available. */
  branch?: string;
};

export type ProjectRecord = {
  id: number;
  path: string;
  name: string;
  pinned: boolean;
  createdAt: number;
  lastOpenedAt: number;
};

export type ProjectGroupRoot = {
  path: string;
  name: string;
  position: number;
};

export type ProjectGroupRecord = {
  remote?: RemoteWorkspace;
  id: string;
  name: string;
  primaryPath: string;
  roots: ProjectGroupRoot[];
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  lastOpenedAt: number;
  /** True for a compatibility projection of an old single-folder project. */
  legacy?: boolean;
  /** Previously removed roots remain suppressed from legacy projections. */
  detachedPaths?: string[];
};

export type ProjectGroupContext = {
  remote?: RemoteWorkspace;
  groupId: string;
  roots: ProjectGroupRoot[];
  instructions: string;
  memory: ProjectMemory;
};

/**
 * `authKind` for a provider row whose credential is a vendor-account OAuth
 * login rather than a pasted API key. Shared so main, the sidecar runtime and
 * the renderer all branch on the same spelling.
 */
