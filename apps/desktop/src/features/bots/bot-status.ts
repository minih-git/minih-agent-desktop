import type { BotListItem, BotStatusPoint, TaskStage, TaskTone, TaskView } from "@minih-agent/shared";
import { taskTone } from "@minih-agent/shared";

/**
 * The sidebar's status dot for one employee (ADR bot-sessions-and-steward §4).
 *
 * The host derives `stage` from structured records; this module only decides
 * which of six readable states the person sees and how loud each one is. The
 * load-bearing rule is the ADR's: **only `person/*` stages disturb the person**,
 * so everything else stays quiet (machine's problem or worker's) and exactly
 * one tone — `attention` — is allowed to be visually loud.
 */
export type BotStatusTone =
  | "attention"
  | "busy"
  | "queued"
  | "blocked"
  | "idle"
  | "offline";

/** The stage an employee is in, or `null` when it has nothing in flight. */
export type BotStageView = { kind: "idle" } | { kind: "stage"; stage: TaskStage } | { kind: "offline" };

export type BotStatusView = {
  tone: BotStatusTone;
  /** i18n key of the short word shown beside the dot. */
  labelKey: string;
  /** Whether this state is the one the person has to act on. */
  attention: boolean;
};

/**
 * Stage → sidebar tone.
 *
 * `person/answer` and `person/accept` both hold the work until the person
 * clicks, so both read as one state ("等你"). `blocked` and `failed` joined them
 * in slice 4a: a stuck task is exactly as much something the person has to act on
 * as a question is, and calling it the employee's own quieter business is why a
 * blocked task could sit there unnoticed. Only `person/*` used to disturb the
 * person; the ADR's rule now says a stuck task does too.
 *
 * `waiting` is a trigger the person configured earlier, so it still reads as
 * queued rather than as a demand now.
 */
const STAGE_TONES: Record<TaskStage, BotStatusTone> = {
  "person/answer": "attention",
  "person/accept": "attention",
  blocked: "attention",
  failed: "attention",
  queued: "queued",
  waiting: "queued",
  working: "busy",
};

/** Map a host status point onto what the sidebar renders. */
export function botStatusView(status: BotStatusPoint | undefined): BotStatusView {
  if (!status) return { tone: "idle", labelKey: "bots.status.idle", attention: false };
  if (status.kind === "offline") {
    return { tone: "offline", labelKey: "bots.status.offline", attention: false };
  }
  if (status.kind === "idle") {
    return { tone: "idle", labelKey: "bots.status.idle", attention: false };
  }
  const tone = STAGE_TONES[status.stage] ?? "idle";
  return {
    tone,
    labelKey: `bots.status.${tone}`,
    attention: tone === "attention",
  };
}

/**
 * Order employees the way a supervisor reads a team: whoever is waiting on the
 * person first, then blockers, then the busiest, and the quiet ones last.
 * Ties keep the host's order (newest activity first), so a stable sort is what
 * keeps the list from reshuffling on every status event.
 */
const TONE_ORDER: Record<BotStatusTone, number> = {
  attention: 0,
  blocked: 1,
  busy: 2,
  queued: 3,
  idle: 4,
  offline: 5,
};

/**
 * Whether this employee is the steward — the person's default entry point.
 *
 * Read from the definition, never from the name: the person can rename her.
 */
export function isStewardBot(bot: BotListItem): boolean {
  return bot.profile?.definition === "steward";
}

export function sortBots(bots: readonly BotListItem[]): BotListItem[] {
  return [...bots].sort((left, right) => {
    // The steward is always the first row. Her status is "what the board is
    // doing", not "an employee waiting for work", so ordering her by tone put an
    // idle steward under three busy employees and hid the door the person came
    // in through. Everyone else is still ordered by tone.
    const stewardOrder = Number(isStewardBot(right)) - Number(isStewardBot(left));
    if (stewardOrder !== 0) return stewardOrder;
    return (
      TONE_ORDER[botStatusView(left.status).tone] - TONE_ORDER[botStatusView(right.status).tone]
    );
  });
}

/**
 * Whether a session is the steward — the one employee that proposes task cards
 * (ADR bot-sessions-and-steward §2). A plain bot has no `TaskCard` tool, so its
 * session can never have a draft to show; rendering the dock there would only
 * add an empty region above the composer.
 */
export function isStewardSession(
  session: { role?: string; botProfile?: { definition?: string } } | null | undefined,
): boolean {
  return session?.role === "bot" && session.botProfile?.definition === "steward";
}

/** Initials for the avatar fallback: first character of the name. */
export function botInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0] ?? "?";
  return first.toLocaleUpperCase();
}

/** Where a task sits in a list, as one of three tones (ADR §7). */
export function taskStatusTone(task: Pick<TaskView, "stage">): TaskTone {
  return taskTone(task.stage);
}

/**
 * One employee's status dot, from the tasks it holds (ADR
 * bot-sessions-and-steward §7).
 *
 * An employee no longer runs turns of its own: what it is doing is what its
 * open tasks are doing. Waiting on the person wins over being busy, being busy
 * wins over everything else, and no open task means idle.
 */
export function botStatusFromTasks(tasks: readonly Pick<TaskView, "stage">[]): BotStatusPoint {
  const first = (wanted: readonly TaskStage[]) =>
    tasks.find((task) => wanted.includes(task.stage))?.stage;
  // The same order the host's `task_status_point` uses, and for the same reason:
  // whatever the person has to act on comes first, however it stopped. A blocked
  // or failed task joined this group in slice 4a.
  const waiting = first(["person/answer", "person/accept", "blocked", "failed"]);
  if (waiting) return { kind: "stage", stage: waiting };
  const busy = first(["working", "queued", "waiting"]);
  if (busy) return { kind: "stage", stage: busy };
  return { kind: "idle" };
}
