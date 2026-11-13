import { isTaskInterrupted, type BotListItem, type TaskView } from "@minih-agent/shared";

/**
 * The board of tasks, as the secretary reads it (employee mode 0.5 slice 3).
 *
 * Two consumers share this one derivation:
 *
 * - the `TaskStatus` tool, which she calls when she wants the ledger;
 * - the standing brief Main attaches to every one of her turns, which is the
 *   same content compressed — she must not have to remember what happened, and
 *   she must not read a whole conversation to find out.
 *
 * The brief is generated per turn and injected per turn: it is never written to
 * the transcript, so it does not accumulate, does not enter a compaction
 * summary, and cannot go stale.
 */

/** How many characters of brief Main attaches to one steward turn. */
export const BRIEFING_LIMIT_CHARS = 1_500;

/** "Just finished" means finished within this window. */
export const JUST_FINISHED_MS = 24 * 60 * 60 * 1_000;

export type TaskBoard = { tasks: readonly TaskView[]; employees: readonly BotListItem[] };

export type TaskGroupKey = "waiting" | "active" | "finished" | "stopped";

export type TaskGroup = {
  key: TaskGroupKey;
  /** What the group is called in the text a model reads. */
  label: string;
  tasks: TaskView[];
};

const LABELS: Record<TaskGroupKey, string> = {
  waiting: "waiting on you",
  active: "in progress",
  finished: "just finished (24h)",
  stopped: "failed or interrupted",
};

/** One employee's display name, falling back to the id a task carries. */
export function employeeName(board: TaskBoard, employeeSessionId: string): string {
  const employee = board.employees.find((entry) => entry.sessionId === employeeSessionId);
  return employee?.profile?.name?.trim() || employee?.title?.trim() || employeeSessionId;
}

function finishedRecently(task: TaskView, now: number): boolean {
  const at = task.deliveryUpdatedAt ? Date.parse(task.deliveryUpdatedAt) : Number.NaN;
  // A task with no delivery timestamp is reported rather than hidden: the
  // steward's job is to tell the person what to look at, and an unreadable clock
  // is not evidence that a task is old.
  return Number.isNaN(at) || now - at <= JUST_FINISHED_MS;
}

/**
 * Sort one task into the group the person would look in.
 *
 * The order matters: an interrupted delivery first (it is not moving and nobody
 * was told), then the stage vocabulary. A task that finished and is still
 * waiting for acceptance counts as "just finished" only while it is recent;
 * once it is old it is what it always was — waiting on the person.
 */
function groupOf(task: TaskView, now: number): TaskGroupKey {
  if (isTaskInterrupted(task)) return "stopped";
  if (task.stage === "failed" || task.stage === "blocked") return "stopped";
  if (task.stage === "person/answer") return "waiting";
  if (task.stage === "person/accept") return finishedRecently(task, now) ? "finished" : "waiting";
  return "active";
}

/** The open tasks, grouped in the order a supervisor reads them. */
export function groupTasks(board: TaskBoard, now: number = Date.now()): TaskGroup[] {
  const grouped: Record<TaskGroupKey, TaskView[]> = {
    waiting: [], active: [], finished: [], stopped: [],
  };
  for (const task of board.tasks) {
    if (task.archivedAt) continue;
    grouped[groupOf(task, now)].push(task);
  }
  return (["waiting", "active", "finished", "stopped"] as const).map((key) => ({
    key,
    label: LABELS[key],
    tasks: grouped[key],
  }));
}

/** The last path segment of a task's repository, or nothing. */
export function repoName(task: Pick<TaskView, "projectPath">): string | null {
  const path = task.projectPath?.trim();
  if (!path) return null;
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

/** The stage a row shows, including the state the stage vocabulary has no word for. */
export function stageWord(task: TaskView): string {
  return isTaskInterrupted(task) ? "interrupted" : task.stage;
}

function row(board: TaskBoard, task: TaskView): string {
  const parts = [
    employeeName(board, task.employeeSessionId),
    task.title,
    repoName(task) ?? "no repository",
    stageWord(task),
    task.origin,
    // The id `SessionSend` needs for a follow-up, so a row can be acted on.
    `taskId=${task.id}`,
  ];
  return `- ${parts.join(" · ")}`;
}

/**
 * The full board, for the `TaskStatus` tool.
 *
 * `employeeSessionId` narrows it to one employee; nothing else is filtered,
 * because "what is going on" must include the tasks the person dispatched
 * themselves (`origin=direct`) — the steward knows about those and does not act
 * on them, and a board that hid them would make her report incomplete.
 */
export function describeTaskBoard(
  board: TaskBoard,
  options: { now?: number; employeeSessionId?: string } = {},
): string {
  const now = options.now ?? Date.now();
  const wanted = options.employeeSessionId?.trim() || undefined;
  const scoped: TaskBoard = wanted
    ? { ...board, tasks: board.tasks.filter((task) => task.employeeSessionId === wanted) }
    : board;
  const groups = groupTasks(scoped, now);
  const open = groups.reduce((total, group) => total + group.tasks.length, 0);
  if (open === 0) {
    return wanted
      ? `No open tasks for ${employeeName(board, wanted)}.`
      : "No open task is on the board.";
  }
  const employees = new Set(
    scoped.tasks.filter((task) => !task.archivedAt).map((task) => task.employeeSessionId),
  );
  const counts = groups.map((group) => `${group.tasks.length} ${group.label}`).join(", ");
  const lines = [
    `${open} open task${open === 1 ? "" : "s"} across ${employees.size} employee${
      employees.size === 1 ? "" : "s"
    }: ${counts}.`,
  ];
  for (const group of groups) {
    if (group.tasks.length === 0) continue;
    lines.push("", `${group.label}:`);
    for (const task of group.tasks) lines.push(row(board, task));
  }
  return lines.join("\n");
}

/**
 * The standing brief, as it is attached to one steward turn.
 *
 * Deliberately small: the counts, then only the rows she may have to act on
 * (waiting, stopped, just finished). Everything still moving is a count, because
 * "a task is progressing" is not news and the person did not ask to be told.
 * The block is delimited and states what it is, so a model cannot mistake it for
 * a message from the person.
 */
export function stewardBriefing(board: TaskBoard, now: number = Date.now()): string {
  const groups = groupTasks(board, now);
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group])) as Record<
    TaskGroupKey,
    TaskGroup
  >;
  const total = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  const header = [
    `[Host briefing · generated for this turn, not a message from the person]`,
    `Open tasks: ${total} (${groups
      .map((group) => `${group.tasks.length} ${group.label}`)
      .join(", ")}).`,
  ];
  const detail: string[] = [];
  for (const key of ["waiting", "stopped", "finished"] as const) {
    const tasks = byKey[key].tasks;
    if (tasks.length === 0) continue;
    detail.push(`${byKey[key].label}:`);
    for (const task of tasks) detail.push(row(board, task));
  }
  if (detail.length === 0) {
    detail.push("Nothing is waiting on the person and nothing stopped.");
  }
  const trailer = "[/Host briefing]";
  let text = [...header, "", ...detail, "", trailer].join("\n");
  if (text.length > BRIEFING_LIMIT_CHARS) {
    // Cut whole lines, never mid-row: a truncated id would be a wrong id.
    const budget = BRIEFING_LIMIT_CHARS - header.join("\n").length - trailer.length - 32;
    const kept: string[] = [];
    let used = 0;
    for (const line of detail) {
      if (used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    kept.push("(more — call TaskStatus for the full board)");
    text = [...header, "", ...kept, "", trailer].join("\n");
  }
  return text;
}

/** The answer when the host cannot be read at all. */
export function unreadableBriefing(reason: string): string {
  return [
    "[Host briefing · generated for this turn, not a message from the person]",
    // A read that failed is reported as a gap, never as an empty board: "no
    // tasks" and "cannot tell" lead to opposite advice.
    `The task list could not be read right now (${reason}), so this brief is ` +
      "incomplete. Do not claim a task is finished, running or waiting until " +
      "TaskStatus can read the board.",
    "[/Host briefing]",
  ].join("\n");
}

/** The two host reads the board is made of, in one place. */
export type BoardReader = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

/**
 * Read the board: every open task, and the employees whose names the rows need.
 *
 * Two host calls, both bounded (`task.list` caps at 500 rows, `bot.list` at 200
 * employees), and neither is available to the model's own process: `task.*` and
 * `bot.*` stay out of the sidecar's proxy allowlist, so this runs in Main.
 */
export async function readTaskBoard(call: BoardReader): Promise<TaskBoard> {
  const [listed, bots] = await Promise.all([
    call<{ tasks?: TaskView[] }>("task.list", { includeArchived: false }),
    call<{ bots?: BotListItem[] }>("bot.list", {}),
  ]);
  return { tasks: listed?.tasks ?? [], employees: bots?.bots ?? [] };
}

/**
 * The brief Main attaches to one steward turn, or the "cannot read" block.
 *
 * A failure never blocks the turn: the person's message is answered either way,
 * and the block states what is missing so the model does not invent a board.
 */
export async function buildStewardBriefing(call: BoardReader): Promise<string> {
  try {
    return stewardBriefing(await readTaskBoard(call));
  } catch (error) {
    return unreadableBriefing(error instanceof Error ? error.message : String(error));
  }
}