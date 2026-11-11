import type { BotListItem, BotStatusPoint, TaskStage } from "@minih-agent/shared";

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
 * clicks, so both read as one state ("等你"). `blocked` and `failed` are the
 * worker's own problems and share one quieter tone, because the person's next
 * action is the same: look at it. `waiting` is a trigger the person configured
 * earlier, so it reads as queued rather than as a demand now.
 */
const STAGE_TONES: Record<TaskStage, BotStatusTone> = {
  "person/answer": "attention",
  "person/accept": "attention",
  blocked: "blocked",
  failed: "blocked",
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

export function sortBots(bots: readonly BotListItem[]): BotListItem[] {
  return [...bots].sort(
    (left, right) =>
      TONE_ORDER[botStatusView(left.status).tone] - TONE_ORDER[botStatusView(right.status).tone],
  );
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
