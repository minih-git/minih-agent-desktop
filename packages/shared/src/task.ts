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
  branch?: string;
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
};

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
export type TaskArchiveRequest = { taskId: string };
export type TaskArchiveResult = { task: TaskView; archivedAt: string };

/** Exactly what changed, and for whom: every surface refetches on this alone. */
export type TasksChangedEvent = {
  employeeSessionId: string;
  taskId?: string;
  reason: "created" | "stage" | "archived";
};
