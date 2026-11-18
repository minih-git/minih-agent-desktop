import type { ProjectMemory } from "./filesystem.js";

/** Shared public types grouped by the owning application domain. */
/**
 * Durable inbox families. `task.*` names a settled turn; `prompt.*` names an
 * interactive request the runtime is blocked on, so a reminder survives a
 * missed toast, a hidden window, or a restart. `plugin.*` is a row a plugin
 * delivered (schema v43): it belongs to a plugin, not to a conversation.
 */
export type AppNotificationKind =
  | "task.completed"
  | "task.failed"
  | "prompt.ask"
  | "prompt.permission"
  | "prompt.plan"
  | "plugin.alert"
  | "plugin.digest";

export type AppNotification = {
  id: string;
  kind: AppNotificationKind;
  /** The conversation this row points at; null for a plugin row. */
  sessionId: string | null;
  /** The conversation's title at delivery time; null for a plugin row. */
  sessionTitle: string | null;
  /** Present for settled-turn rows only. */
  turnId?: string;
  /** Present for prompt rows; the runtime's id for the pending request. */
  requestId?: string;
  /** Present for prompt rows that ask about one tool. */
  toolName?: string;
  errorCode?: string;
  /** Present for plugin rows only: which plugin delivered this row. */
  pluginId?: string;
  /** A plugin row's own headline and text. */
  title?: string;
  body?: string;
  /** What activating a plugin row opens, as the plugin's JSON payload. */
  linkJson?: string;
  /** The plugin's own id for the event, so a retry lands on this row. */
  dedupeKey?: string;
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
