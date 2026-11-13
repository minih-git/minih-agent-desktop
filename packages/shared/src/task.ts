/**
 * Tasks under an employee (ADR bot-sessions-and-steward §7).
 *
 * A task is one thing an employee is doing: it has its own session (so it has a
 * transcript, a project and one workspace), its own start and end, and it hangs
 * under the employee that owns it. The employee row stays a container and a
 * profile; it no longer runs turns of its own.
 *
 * Three vocabularies meet here and must never be conflated:
 * - `stage` answers "who is holding this" (`bot-session.ts`);
 * - the ledger's delivery `status` answers "did the turn finish";
 * - `origin` answers "who started it" — the steward's card or the person
 *   typing directly into the employee's workbench.
 *
 * This module is pure: shapes, bounds and the two derivations the renderer and
 * the host must agree on (a task title from a first utterance, and whether a
 * stage counts as "in progress"). The host owns the written row.
 */

import type { TaskStage } from "./bot-session.js";
import type { SessionMessageStatus } from "./session-collaboration.js";

/** Who started the task. */
export const TASK_ORIGINS = ["steward", "direct"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export const MAX_TASK_TITLE_CHARS = 200;
export const MAX_TASK_SOURCE_UTTERANCE_CHARS = 4_096;
export const MAX_TASK_BRANCH_CHARS = 255;

/** The written stage of a task nobody has picked up yet. */
export const TASK_INITIAL_STAGE: TaskStage = "queued";

export function isTaskOrigin(value: unknown): value is TaskOrigin {
  return typeof value === "string" && (TASK_ORIGINS as readonly string[]).includes(value);
}

/** One task row as the host stores and returns it. */
export type TaskView = {
  id: string;
  /** The employee that owns this task. */
  employeeSessionId: string;
  /** The task's own session, which owns the transcript. */
  sessionId: string;
  title: string;
  origin: TaskOrigin;
  projectPath?: string;
  /** The branch the task asked for (`repo.ref` on a card), when it asked. */
  branch?: string;
  /** The branch its worktree was created on, once the workspace is ready. */
  workspaceBranch?: string;
  stage: TaskStage;
  /** The ledger delivery the steward's card dispatched, when there was one. */
  deliveryId?: string;
  sourceUtterance?: string;
  createdAt: string;
  archivedAt?: string;
  /** The latest progress the employee reported, for the sidebar and the list. */
  latestProgress?: string;
  /** Short identifier shown in the task session's header, e.g. `#37`. */
  shortId: string;
  /** Where the task is in preparing the folder it works in. */
  workspaceStatus: TaskWorkspaceStatus;
  /** Why the preparation failed, in words the person can act on. */
  workspaceError?: string;
  /** The ref its branch was created from, e.g. `refs/remotes/origin/main`. */
  baseRef?: string;
  /** True when `baseRef` was fetched from the project's remote. */
  baseRemote?: boolean;
  /** How its work will reach the project. Decided by the host, not the client. */
  deliveryMode?: TaskDeliveryMode;
  /**
   * The status of the ledger delivery bound to this task, read from the same
   * row the host settles (ADR 0239).
   *
   * The stage answers "who is holding this"; the delivery status answers "did
   * the turn finish". `interrupted` is the one status the stage vocabulary has
   * no word for, because it is not a stage at all: the application stopped
   * while the work was in flight, and nothing will resume it on its own.
   */
  deliveryStatus?: SessionMessageStatus;
};

/**
 * A task's workspace, as the host prepares it (employee mode 0.5 slice 2).
 *
 * `none` is not a failure: a task without a repository works in its session's
 * own folder. `preparing` is the only state in which no turn may start.
 */
export const TASK_WORKSPACE_STATUSES = ["none", "preparing", "ready", "failed"] as const;
export type TaskWorkspaceStatus = (typeof TASK_WORKSPACE_STATUSES)[number];

/**
 * How a task's work reaches the project. `pr` needs a GitHub remote, `local`
 * merges back into the project (ADR 0329), and `none` means there is no
 * repository to deliver to. This slice records the decision; delivering is the
 * completion card's job.
 */
export const TASK_DELIVERY_MODES = ["pr", "local", "none"] as const;
export type TaskDeliveryMode = (typeof TASK_DELIVERY_MODES)[number];

/** The refusal `task.archive` returns while the workspace still holds work. */
export const TASK_WORKSPACE_UNSAVED = "WORKSPACE_HAS_UNSAVED_WORK";
/**
 * The refusal for "nobody could tell": a git failure while counting commits (the
 * project's branch was renamed, the repository is damaged, the command timed
 * out). It asks the same question as {@link TASK_WORKSPACE_UNSAVED}, because
 * archiving on an unknown answer would delete work.
 */
export const TASK_WORKSPACE_UNSAVED_UNKNOWN = "WORKSPACE_UNSAVED_UNKNOWN";

export type TaskList = { tasks: TaskView[] };

/**
 * Task tone in the sidebar and the list. Orange means a person is holding it
 * up, blue means it is being worked on, grey means nothing is happening.
 */
export type TaskTone = "attention" | "busy" | "idle";

/** Stages that mean "the person has to do something for this to move". */
const PERSON_STAGES: ReadonlySet<TaskStage> = new Set<TaskStage>(["person/answer", "person/accept"]);

/** Stages that mean work is actually happening. */
const ACTIVE_STAGES: ReadonlySet<TaskStage> = new Set<TaskStage>([
  "working",
  "queued",
  "waiting",
  "blocked",
  "failed",
]);

export function taskTone(stage: TaskStage | null | undefined): TaskTone {
  if (!stage) return "idle";
  if (PERSON_STAGES.has(stage)) return "attention";
  if (ACTIVE_STAGES.has(stage)) return "busy";
  return "idle";
}

/** Whether the task is still being worked on, as opposed to sitting still. */
export function taskInProgress(stage: TaskStage | null | undefined): boolean {
  return stage === "working" || stage === "queued" || stage === "waiting";
}

/**
 * The title a task gets from its first words.
 *
 * A title is what the sidebar and the task header show, so it is one short
 * line: the first sentence, collapsed whitespace, bounded. An empty utterance
 * gets no title, and the caller supplies its own fallback rather than this
 * module inventing one.
 */
export function taskTitleFromUtterance(utterance: string): string {
  const collapsed = utterance.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  const firstSentence = collapsed.split(/(?<=[.!?。！？；;])\s*/)[0] ?? collapsed;
  const chars = Array.from(firstSentence);
  if (chars.length <= MAX_TASK_TITLE_CHARS) return firstSentence;
  return `${chars.slice(0, MAX_TASK_TITLE_CHARS).join("").trimEnd()}…`;
}

/** A request to start one task under one employee. */
export type TaskCreateRequest = {
  employeeSessionId: string;
  title: string;
  origin: TaskOrigin;
  /** The repository the task works in; defaults to the employee's own. */
  projectPath?: string | null;
  branch?: string | null;
  /** The person's own words, kept for the audit and the task header. */
  sourceUtterance?: string | null;
  /** The ledger delivery that authorizes a steward-dispatched task. */
  deliveryId?: string | null;
};

export type TaskCreateResult = {
  task: TaskView;
  session: Record<string, unknown>;
};

export type TaskListRequest = {
  employeeSessionId?: string;
  includeArchived?: boolean;
  /** Creation-time floor in epoch milliseconds. */
  since?: number | null;
};

export type TaskGetRequest = { taskId: string };
export type TaskArchiveRequest = {
  taskId: string;
  /**
   * The person's second click after [`TASK_WORKSPACE_UNSAVED`]: discard the
   * uncommitted files and unpushed commits and archive anyway.
   */
  discard?: boolean;
};
export type TaskArchiveResult = { task: TaskView; archivedAt: string };
/** Re-run a failed workspace preparation; the host answers with the row. */
export type TaskWorkspaceRetryRequest = { taskId: string };
export type TaskWorkspaceRetryResult = { task: TaskView };

/**
 * Whether the task's work was cut off by the application stopping (ADR 0239's
 * startup fence).
 *
 * It is read from the delivery, never stored on the task: the fence marks the
 * delivery once, and a person who starts the task again gets a *new* delivery,
 * so the answer cannot go stale.
 */
export function isTaskInterrupted(task: Pick<TaskView, "deliveryStatus"> | null | undefined): boolean {
  return task?.deliveryStatus === "interrupted";
}

/**
 * Start an interrupted task again.
 *
 * Restarting is the person's decision, taken with the same authority as the
 * click that first dispatched the work: the host writes a new delivery from the
 * same sender with the same mandate, re-points the task at it and leaves it
 * `queued`, and Main starts it through the ordinary dispatch.
 */
export type TaskRestartRequest = { taskId: string };
export type TaskRestartResult = { task: TaskView };

/** Exactly what changed, and for whom: every surface refetches on this alone. */
export type TasksChangedEvent = {
  employeeSessionId: string;
  taskId?: string;
  reason: "created" | "stage" | "archived";
};
