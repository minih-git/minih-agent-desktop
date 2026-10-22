import type { Principal, SessionSummary } from "@minih-agent/agent-host";
import type {
  FsEntry,
  FsReadResult,
  RacpModelSummary,
  RacpProjectSummary,
  WorkspaceDiff,
  WorkspaceToolExecute, WorkspaceToolAbort, WorkspaceToolResult, CommandShellOption, WorkspaceFilesRequest,
} from "@minih-agent/shared";

/**
 * Everything the RACP server delegates to the Host besides the Agent Host
 * module: session catalog mutations, projects, workspace reads, terminals.
 * `agent-host-cli` implements these on host-core and its filesystem; a test hands
 * the server fakes. The server itself never touches host-core RPC, a
 * filesystem, or a pty, so the boundary of security §7 holds by construction.
 */
export type SessionCreateInput = {
  title?: string;
  projectId?: string;
  mode?: "agent" | "plan" | "goal";
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  permissionMode?: "ask" | "accept-edits" | "auto";
};

export type SessionConfigureInput = {
  mode?: "agent" | "plan" | "goal";
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  permissionMode?: "ask" | "accept-edits" | "auto";
};

/**
 * The names `session/configure` may carry, for a Host that reports what a
 * remote device changed. Field names only plus their new values; a prompt or
 * transcript can never ride along.
 */
export const SESSION_CONFIGURE_FIELD_ORDER = [
  "mode", "providerId", "modelId", "thinkingLevel", "permissionMode",
] as const;

export interface RacpSessionCatalog {
  list(): Promise<SessionSummary[]>;
  create(input: SessionCreateInput, principal: Principal): Promise<SessionSummary>;
  /**
   * Apply the patch and return the session. `principal` is the device that
   * asked; a Host that reports what a remote device changed uses it, and a
   * Host's own code may omit it (protocol §6.2, ADR 0331 amendment 4).
   */
  configure(sessionId: string, input: SessionConfigureInput, principal?: Principal): Promise<SessionSummary>;
  fork(sessionId: string, input: { title?: string; throughMessageId?: string }): Promise<SessionSummary>;
  rename(sessionId: string, title: string): Promise<void>;
  /** Apply the Host's first-prompt fallback title; false when it was refused. */
  deriveTitle(sessionId: string, title: string): Promise<boolean>;
  /**
   * Delete one idle session.
   *
   * `principal` is the device that asked. A Host that gates an operation by
   * device class reads it here; one that does not can ignore it, which is how
   * `agent-host-cli` behaves (protocol §6.2).
   */
  delete(sessionId: string, principal?: Principal): Promise<void>;
  compact(sessionId: string): Promise<{ accepted: boolean }>;
}

export type ProjectBrowseEntry = { name: string; path: string };

export interface RacpProjectCatalog {
  list(): Promise<RacpProjectSummary[]>;
  /**
   * Canonicalize and validate a Host directory, register it, return its id.
   *
   * `principal` is the device that asked. It is optional because the catalog is
   * also called by a Host's own code; a Host that reports what a remote device
   * did uses it.
   */
  register(path: string, principal?: Principal): Promise<RacpProjectSummary & { path: string }>;
  /** Directories under `path` (or the user's home when omitted), bounded. */
  browse(
    path?: string,
    principal?: Principal,
  ): Promise<{ path: string; parent?: string; entries: ProjectBrowseEntry[] }>;
}

export interface RacpWorkspaceAccess {
  /**
   * The read-only file panel (protocol §6.2). `principal` is the device that
   * asked, so a Host can answer per device class; the RACP server already
   * refuses the operation when the connection's `workspaceRead` is false.
   */
  list(sessionId: string, path: string, principal?: Principal): Promise<{ entries: FsEntry[] }>;
  read(sessionId: string, path: string, principal?: Principal): Promise<FsReadResult>;
  diff(sessionId: string, principal?: Principal): Promise<WorkspaceDiff>;
}

export type TerminalOpenResult = {
  terminalId: string;
  /** Bounded replay ring, base64 (spec §6.2). */
  replay: string;
  cols: number;
  rows: number;
};

export interface RacpTerminalAccess {
  open(
    sessionId: string,
    options: { cols: number; rows: number },
    sink: { output: (data: string) => void; exit: (code: number | null) => void },
  ): Promise<TerminalOpenResult>;
  input(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<void>;
  /** Re-attach a subscriber after a reconnect; returns the replay ring. */
  attach(terminalId: string, sink: { output: (data: string) => void; exit: (code: number | null) => void }): Promise<TerminalOpenResult | null>;
  detach(terminalId: string): void;
}

/**
 * The models this Host offers a remote client (R7, protocol §16.1).
 *
 * Metadata only. The implementation reads the Host's own provider catalog and
 * drops anything it would not print on the desktop's model picker, so this port
 * is the one place a credential could leak, and the one place it is refused.
 */
export interface RacpModelCatalog {
  list(): Promise<RacpModelSummary[]>;
}

/**
 * Where the bytes of an inline `turn/start` attachment go (protocol §10 step 1).
 *
 * The RACP layer validates and sniffs; only this port touches a filesystem. It
 * returns the path the agent runtime reads, relative to the Host data root — the
 * same form the desktop stores an attachment under — so the runtime and a later
 * replay of the transcript read the same bytes.
 */
export interface RacpInlineAttachmentStore {
  store(input: {
    sessionId: string;
    name: string;
    mimeType: string;
    kind: "image" | "file";
    bytes: Uint8Array;
  }): Promise<{ path: string }>;
}

export type RacpHostOperations = {
  sessions: RacpSessionCatalog;
  /**
   * Absent on a Host that cannot describe its models; the operation then answers
   * `CAPABILITY_UNAVAILABLE`, which is what tells a client to fall back to the
   * Host's default instead of guessing.
   */
  models?: RacpModelCatalog;
  projects: RacpProjectCatalog;
  workspace: RacpWorkspaceAccess;
  /**
   * Whether this connection may read the session workspace
   * (`workspace/list|read|diff`, protocol §6.2).
   *
   * The answer is per principal, not per server: the desktop Host offers the
   * read-only file panel to a desktop-class device of the same account and
   * withholds it from a phone. Asking the Host keeps that rule where the device
   * class is known, instead of teaching the server what a form factor is.
   *
   * Absent means the answer the operation catalog implies: every principal that
   * holds `viewer` may read, which is how `agent-host-cli` has always behaved.
   */
  workspaceRead?: (principal: Principal) => boolean;
  terminal?: RacpTerminalAccess;
  workspaceFiles?: { read(input: WorkspaceFilesRequest): Promise<unknown> };
  workspaceTools?: {
    execute(input: WorkspaceToolExecute, owner: { deviceId: string; connectionId: string }): Promise<WorkspaceToolResult>;
    abort(input: WorkspaceToolAbort, owner: { deviceId: string; connectionId: string }): Promise<void>;
    shell(): Promise<CommandShellOption>;
    disconnect(connectionId: string): Promise<void>;
  };
  /**
   * Inline attachments for `turn/start` (`RacpInlineAttachmentStore`).
   *
   * Absent on a Host that cannot put the bytes where the runtime will read them
   * later. The capability then advertises `attachments: false` and the operation
   * answers `CAPABILITY_UNAVAILABLE`, instead of accepting a prompt it would have
   * to drop the attachment from.
   */
  inlineAttachments?: RacpInlineAttachmentStore;
  /** Owner-only: revoke a paired device (spec `session/revoke`). */
  revokeDevice?: (deviceId: string) => Promise<boolean>;
};
