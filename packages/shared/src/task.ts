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
import type { TaskCardDraftView } from "./bot-ipc.js";
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

/** One request a task is waiting on, as the host stores it. */
export type TaskWaitingKind = "ask" | "permission";

/**
 * A structured request a task's session is blocked on (employee mode 0.5 slice
 * 4a).
 *
 * The four surfaces that show a waiting task all render *this*, and never a
 * sentence parsed out of the employee's reply: an employee that ends a turn with
 * "anything else?" did not ask a question the person has to answer.
 */
export type TaskWaiting = {
  requestId: string;
  kind: TaskWaitingKind;
  /** The question, for an `ask`. */
  question?: string;
  /** The options the employee offered, in its own order. */
  options?: string[];
  /** The tool that asked for permission, for a `permission`. */
  toolName?: string;
  /** Why that tool says it needs the person. */
  reason?: string;
  openedAt: string;
};

/**
 * Why a task is stuck.
 *
 * A `TaskReport` writes `where`/`tried`/`suggestion`; the person's own stop
 * writes `reason: "stopped"`; a failed turn has the error its own card shows, so
 * the blocker is empty there.
 */
export type TaskBlocker = {
  status?: "blocked";
  /**
   * `stopped` is the person's own stop, `error` a turn that failed, and
   * `interrupted` the startup fence: the app died while this task's turn was
   * running, so nothing is running now and nothing will resume by itself.
   */
  reason?: "stopped" | "error" | "interrupted" | "delivery";
  /**
   * For `delivery`: which fixed step stopped, and what it said. The card
   * composes the sentence from `reason` and the remote's name, so the words the
   * person reads are translated rather than stored.
   */
  step?: string;
  detail?: string;
  /** The error code of a failed turn, as the runtime settled it. */
  code?: string;
  /** Where it got stuck, in the employee's words. */
  where?: string;
  /** What it already tried before giving up. */
  tried?: string;
  /** What it suggests the person do. */
  suggestion?: string;
  reportedAt?: string;
};

/** One line of the employee's own acceptance check. */
export type TaskAcceptance = {
  /** The criterion, quoted from the card the person confirmed. */
  criterion: string;
  met: boolean;
  /** Why, when a bare ✓ or ✗ would not be enough. */
  note?: string;
};

/**
 * What `TaskReport { status: "ready" }` delivered (employee mode 0.5 slice 4b).
 *
 * It is the employee's own account of the work, which is why it is shown as its
 * own section: the commits and the file count are the host's facts, and the two
 * must not be confused when the person decides whether to accept.
 */
export type TaskResult = {
  status: "ready";
  summary: string;
  acceptance: TaskAcceptance[];
  leftovers: string[];
  reportedAt: string;
};

/** One fixed step of a delivery, and what happened to it. */
export type TaskDeliveryStep = {
  name: string;
  status: "done" | "failed";
  at: string;
  detail?: string;
};

/**
 * What the host did to land the work, in the order it did it.
 *
 * Stored on the task, not inferred: a retry continues at the first step that is
 * not `done`, so the record is also the reason an irreversible command is never
 * run twice.
 */
export type TaskDeliveryState = {
  mode: TaskDeliveryMode;
  steps: TaskDeliveryStep[];
  finishedAt?: string;
  archivedAt?: string;
};

/**
 * Why the merge button is grey.
 *
 * Codes, not sentences: the card translates them, so the same verdict reads in
 * the person's own language. `reasonDetail` carries the one name that matters —
 * which check failed, which remote refused, what `gh` said.
 */
export type TaskDeliveryReason =
  | "pr-unreadable"
  | "pr-missing"
  | "ci-missing"
  | "ci-running"
  | "ci-failed"
  | "conflict"
  | "mergeable-unknown"
  | "review-required"
  | "no-project"
  | "conflict-local"
  | "nothing-to-merge"
  | "preview-failed";

/** The CI summary the card shows beside the verdict. */
export type TaskCheckSummary = {
  total: number;
  passed: number;
  pending: number;
  failed: string[];
};

/** One commit of the task's own work. */
export type TaskChangeCommit = { sha: string; subject: string };

/** What the host itself can prove about the work: its commits and its size. */
export type TaskChanges = {
  commits: TaskChangeCommit[];
  files: number;
  /** True when the list was cut at the card's limit. */
  truncated: boolean;
  /**
   * The steps of a relay chain, first to last, when the merge lands more than
   * one (employee mode 0.5 slice 7). Each entry lists what that step added on top
   * of the step before it.
   */
  steps?: Array<{
    taskId: string;
    shortId: string;
    title: string;
    commits: TaskChangeCommit[];
    files: number;
    truncated: boolean;
  }>;
};

/** Where a step sits in its relay chain, as the completion card needs it. */
export type TaskRelayPosition = {
  /** 1-based position of the task in its chain. */
  step: number;
  /** How many steps the chain has. */
  total: number;
  /** True when this is the last step, the only one that may be merged. */
  isLast: boolean;
};

/**
 * Whether confirming a card should also start its task now.
 *
 * A relay step waits for the step before it (employee mode 0.5 slice 7): its
 * card is already confirmed, its delivery is already written, and starting it
 * early would build the second half of a change on a branch that does not exist
 * yet. `orphaned` waits for the person's own 「改从 main 开工」. Everything else —
 * including every task that is in no chain — starts on the click.
 */
export function taskStartsOnConfirm(
  task: Pick<TaskView, "relayState"> | undefined,
): boolean {
  return task?.relayState !== "waiting" && task?.relayState !== "orphaned";
}

/** What one task's turns cost, when the ledger has it. */
export type TaskUsage = {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  costUsd?: number;
};

/**
 * `task.delivery.check`: everything the completion card renders, read once.
 *
 * The renderer asks again only when the person clicks 刷新 — there is no poll,
 * because a timer over `gh` is a cost nobody asked for.
 */
export type TaskDeliveryCheck = {
  canMerge: boolean;
  reason?: TaskDeliveryReason;
  reasonDetail?: string;
  prUrl?: string;
  checks?: TaskCheckSummary | null;
  changes?: TaskChanges | null;
  elapsedMs?: number;
  usage?: TaskUsage | null;
  /** Where this step sits in its relay chain (employee mode 0.5 slice 7). */
  relay?: TaskRelayPosition;
};

export type TaskAcceptRequest = { taskId: string };
export type TaskAcceptResult = { task: TaskView };

/**
 * The outcome of one 「接受并交给下一棒」 click (employee mode 0.5 slice 7).
 *
 * The host records the handoff and answers with the deliveries Main has to
 * start: the next step was authorized when its card was confirmed, so unlocking
 * it is a dispatch and not a second question. `unlocked` is empty for a step
 * whose successor card has not been confirmed yet — that card starts at its own
 * confirmation, which is when the person is asked.
 */
export type TaskRelayHandoffResult = {
  task: TaskView;
  handedOffAt: string;
  unlocked: Array<{ taskId: string; deliveryId: string }>;
};

/** The outcome of 「改从 main 开工」 on an orphaned step. */
export type TaskRelayDetachResult = { task: TaskView };

/**
 * What other open tasks in this project are changing (slice 7).
 *
 * `readable: false` is not an empty list: "nobody else touches this file" and
 * "nobody could tell" lead to opposite decisions, and the card says which one it
 * is.
 */
export type TaskOverlap = {
  readable: boolean;
  reason?: string;
  tasks: Array<{ taskId: string; shortId: string; title: string; fileCount: number }>;
  intersections: Array<{ taskId: string; shortId: string; title: string; files: string[] }>;
};

export type TaskOverlapRequest = { projectPath: string; taskId?: string };

export type TaskDeliveryMergeRequest = { taskId: string };
/**
 * The outcome of one "accept and merge" click.
 *
 * A failure is not an error the renderer throws: the task has become a blocked
 * card with its own words, so the answer carries it and the card is what the
 * person acts on. `published` says whether the work already left this machine,
 * which is the difference between "nothing happened" and "GitHub has it but
 * another remote does not".
 */
export type TaskDeliveryMergeResult = {
  merged: boolean;
  task?: TaskView;
  failedStep?: string;
  detail?: string;
  published?: boolean;
};

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
  /**
   * When that delivery last moved, so a "just finished" question can be
   * answered: a task row has no `updated_at` of its own.
   */
  deliveryUpdatedAt?: string;
  /**
   * The requests this task's session is blocked on right now, newest last
   * (employee mode 0.5 slice 4a).
   *
   * This is what `stage = "person/answer"` *means*: a question with its options,
   * or the tool a permission was asked for — the employee's own structured
   * words, never a sentence read out of its reply. Every surface (the task's own
   * card, the steward's dock, the sidebar count, the system notification) shows
   * these same entries, and answering one anywhere closes it everywhere.
   */
  waiting?: TaskWaiting[];
  /**
   * Why a stuck task is stuck, as the `TaskReport` that reported it wrote it:
   * where, what it already tried, and what it suggests.
   *
   * Absent is not a failure: a task stopped by the person carries
   * `{ reason: "stopped" }` here, and a failed one has the turn's own error.
   */
  blocker?: TaskBlocker;
  /** How many times this task's stage has moved (the notice key). */
  stageSeq?: number;
  /** When the person accepted the work, if they did. Accepting is not archiving. */
  acceptedAt?: string;
  /** What the employee delivered, in its own words, when it reported `ready`. */
  result?: TaskResult;
  /** The fixed steps the host ran to land this work, and where they stopped. */
  delivery?: TaskDeliveryState;
  /** The card batch this task came from, when one turn proposed several cards. */
  batchId?: string;
  /**
   * The task this one continues from, when it is one step of a relay (employee
   * mode 0.5 slice 7).
   *
   * A relay is how one change is delivered in several steps: a branch cannot be
   * checked out in two worktrees, so each step starts its own branch from the end
   * of the one before it, and only the last step is merged.
   */
  relayParentTaskId?: string;
  /**
   * `waiting` while the step before this one is running, `ready` once it handed
   * off, `orphaned` when it was abandoned without handing off. Absent for a task
   * in no chain.
   */
  relayState?: "waiting" | "ready" | "orphaned";
  /** When this task handed its work to the next step. */
  relayHandoffAt?: string;
  /** This task's position in its chain, 1-based. A task in no chain is 1 of 1. */
  relayStep?: number;
  /** How many steps the chain has. A task in no chain is 1 of 1. */
  relayTotal?: number;
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
]);

export function taskTone(
  stage: TaskStage | null | undefined,
  options: { accepted?: boolean } = {},
): TaskTone {
  if (!stage) return "idle";
  // Accepted work is no longer waiting on the person (employee mode 0.5 slice
  // 4b): they already said it is fine, and the merge is a later, deliberate
  // step. Leaving it orange kept a finished task looking like a demand.
  if (stage === "person/accept" && options.accepted) return "idle";
  if (PERSON_STAGES.has(stage)) return "attention";
  // A stuck task is the person's problem, not the employee's quiet business
  // (employee mode 0.5 slice 4a): it reads as attention here so the sidebar row,
  // the task header's chip and the waiting list say the same thing the employee's
  // dot already says.
  if (stage === "blocked" || stage === "failed") return "attention";
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
  /**
   * `waiting` is the record's own news: a question opened or closed while the
   * stage stayed `person/answer`, so nothing moved but the surfaces have to
   * repaint (employee mode 0.5 slice 4a).
   */
  reason: "created" | "stage" | "waiting" | "archived";
};

/**
 * Whether the task's work was cut off, failed, or reported itself stuck: the
 * cases the blocked card answers (employee mode 0.5 slice 4a).
 *
 * The three say different things and the card shows different sources — a
 * blocker's own words, the turn's error, or "the app restarted" — but the
 * person's next action is the same, so they share one card and one predicate.
 */
export function isTaskStuck(
  task: Pick<TaskView, "stage" | "deliveryStatus"> | null | undefined,
): boolean {
  if (!task) return false;
  return (
    task.stage === "blocked" || task.stage === "failed" || task.deliveryStatus === "interrupted"
  );
}

/** Whether the task is waiting on an answer from the person right now. */
export function isTaskWaitingForAnswer(
  task: Pick<TaskView, "stage" | "waiting"> | null | undefined,
): boolean {
  if (!task) return false;
  return (task.waiting?.length ?? 0) > 0 || task.stage === "person/answer";
}

/**
 * Whether one task counts toward the sidebar's "waiting for you" number.
 *
 * The ADR's rule (amended in slice 4a) is that a task the person has to act on
 * counts, whatever keeps it from moving: a question, a finished piece of work
 * waiting for acceptance, or a task that got stuck. A blocked task used to be
 * only the employee's own problem, which is exactly why it could sit there
 * unnoticed. The number is the *same* predicate in the sidebar, the dock and the
 * tests, so the surfaces cannot disagree about how much is waiting.
 */
export function taskCountsAsWaiting(
  task: Pick<TaskView, "stage" | "deliveryStatus" | "archivedAt" | "acceptedAt">,
): boolean {
  if (task.archivedAt) return false;
  // Accepting is the person's answer to "person/accept": the work is acceptable,
  // so it stops being something they have to act on. The task stays open — its
  // completion card still offers the merge — but the number the sidebar shows is
  // about what needs them now.
  if (task.acceptedAt) return false;
  return task.stage === "person/answer" || task.stage === "person/accept" || isTaskStuck(task);
}

/** How many tasks are waiting on the person, across every employee. */
export function waitingTaskCount(
  tasks: readonly Pick<TaskView, "stage" | "deliveryStatus" | "archivedAt" | "acceptedAt">[],
): number {
  return tasks.filter(taskCountsAsWaiting).length;
}

/**
 * Hand a stuck task's work to somebody else.
 *
 * `reason` is rendered by the caller in the person's own language: the card it
 * ends up on is stored, and a stored row cannot be translated later.
 */
export type TaskReassignRequest = {
  taskId: string;
  reason?: string;
  /** The steward conversation the new card is proposed on; defaults to the host's. */
  stewardSessionId?: string;
};

export type TaskReassignResult = {
  draft: TaskCardDraftView;
  created?: boolean;
  task: TaskView;
};

/**
 * What the hourly inspection found (employee mode 0.5 slice 5).
 *
 * The host decides, deterministically and without a model: a task that is
 * moving is never in this list. Main turns each entry into one system
 * notification, and the steward is woken once with all of them.
 */
export const TASK_INSPECTION_CONDITIONS = [
  "answer-wait",
  "accept-wait",
  "stuck",
  "running-long",
] as const;

export type TaskInspectionCondition = (typeof TASK_INSPECTION_CONDITIONS)[number];

export type TaskInspectionFinding = {
  taskId: string;
  /** Short identifier shown in the task header, e.g. `#37`. */
  shortId: string;
  title: string;
  employeeSessionId: string;
  employeeName: string;
  /** The task's own session, for the viewing-session check before popping. */
  sessionId: string;
  stage: TaskStage;
  condition: TaskInspectionCondition;
  /** How long the task has been in this state, in milliseconds. */
  waitedMs: number;
  /**
   * True for a task the person started in the employee's own workbench: worth
   * telling them about, but not something the steward should intervene in.
   */
  direct: boolean;
  /** When the current state began, RFC3339. */
  since?: string;
};

export type TaskInspectionEvent = {
  findings: TaskInspectionFinding[];
  /** The batch stamp of the inspection that produced them. */
  batch?: number;
};
