/**
 * Bot sessions and the task mandate (ADR bot-sessions-and-steward).
 *
 * A bot is a durable Agent session with an explicit role and a profile, not a
 * second entity. A task's authorization is a Mandate frozen on the delivery
 * that carries the work. This module owns the shared shape, its bounds, and the
 * invariants both the host and the desktop rely on, so the renderer, Electron
 * main, the plugin gateway, and a later cross-host protocol validate one
 * definition instead of four.
 *
 * Two rules are load-bearing and live here rather than in a caller:
 * - a Mandate asks for permission and never grants it (`mandateCeiling`), and
 * - `observe` is the absence of consent, so a missing flag is never read as
 *   "auto-start" (`normalizeBotProfile`).
 */

import type { PermissionMode } from "./types/permissions.js";

export const SESSION_ROLES = ["user", "bot"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];
export const DEFAULT_SESSION_ROLE: SessionRole = "user";

export const BOT_MUST_ASK = [
  "push",
  "merge",
  "deploy",
  "delete",
  "spend",
  "criteria-change",
] as const;
export type BotMustAsk = (typeof BOT_MUST_ASK)[number];

/**
 * Actions the executing side always requires, regardless of what a card or a
 * profile asks for. They cannot be configured away.
 */
export const ALWAYS_MUST_ASK: readonly BotMustAsk[] = ["deploy", "delete", "spend"];

/** A bot profile is a bounded operating identity, so every field is bounded. */
export const MAX_BOT_NAME_CHARS = 80;
export const MAX_BOT_AVATAR_CHARS = 2_048;
export const MAX_BOT_DUTY_CHARS = 500;
export const MAX_BOT_PROFILE_BYTES = 8 * 1_024;

export type BotProfile = {
  name: string;
  avatar?: string;
  duty?: string;
  /** Display and routing intent only; never proof of locality or authority. */
  homeHostId?: string | null;
  permissionMode: PermissionMode;
  mustAsk: BotMustAsk[];
  /**
   * Consent gate: a bot records what it would do and starts nothing until the
   * person switches this off. Required in a stored profile.
   */
  observe: boolean;
};

export const MANDATE_VERSION = 1;

export const MAX_MANDATE_BYTES = 32_768;
export const MAX_MANDATE_GOAL_CHARS = 2_048;
export const MAX_MANDATE_SOURCE_UTTERANCE_CHARS = 4_096;
export const MAX_MANDATE_CRITERIA = 12;
export const MAX_MANDATE_CRITERION_TEXT_CHARS = 500;
export const MAX_MANDATE_BOUNDARIES = 12;
export const MAX_MANDATE_BOUNDARY_CHARS = 300;
export const MAX_MANDATE_ID_CHARS = 128;
export const MAX_MANDATE_REPO_ORIGIN_CHARS = 512;
export const MAX_MANDATE_REPO_REF_CHARS = 256;
export const MAX_MANDATE_POLICY_VERSION_CHARS = 64;

export const MANDATE_PERMISSION_MODES = ["auto", "accept-edits", "ask"] as const;
export type MandatePermissionMode = (typeof MANDATE_PERMISSION_MODES)[number];

export const MANDATE_RISKS = ["low", "medium", "high"] as const;
export type MandateRisk = (typeof MANDATE_RISKS)[number];

export type MandateCriterion = { id: string; text: string };

export type MandateRepo = { origin: string; ref?: string };

export type MandateRequester = {
  kind: "user";
  hostId: string;
  deviceId?: string;
};

/** The frozen authorization of one task. Immutable once confirmed. */
export type Mandate = {
  version: number;
  taskId: string;
  goal: string;
  criteria: MandateCriterion[];
  boundaries: string[];
  repo?: MandateRepo;
  permissionMode: MandatePermissionMode;
  mustAsk: BotMustAsk[];
  risk: MandateRisk;
  requestedBy: MandateRequester;
  sourceUtterance: string;
  /** Requester clock; display only, never a deadline or a security input. */
  createdAt: string;
  policyVersion: string;
};

/** A bot's derived task stage. Only `person/*` is worth disturbing the person. */
export const TASK_STAGES = [
  "person/answer",
  "person/accept",
  "blocked",
  "failed",
  "queued",
  "waiting",
  "working",
] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/** Six-value worker report (dsh `Report`); `dropped` is a clean end. */
export const TASK_REPORTS = [
  "progress",
  "waiting",
  "ready",
  "blocked",
  "failed",
  "dropped",
] as const;
export type TaskReport = (typeof TASK_REPORTS)[number];

const PERMISSION_RANK: Record<PermissionMode, number> = {
  inherit: 0,
  ask: 1,
  "accept-edits": 2,
  auto: 3,
};

export function isSessionRole(value: unknown): value is SessionRole {
  return typeof value === "string" && (SESSION_ROLES as readonly string[]).includes(value);
}

export function isBotMustAsk(value: unknown): value is BotMustAsk {
  return typeof value === "string" && (BOT_MUST_ASK as readonly string[]).includes(value);
}

export function isMandatePermissionMode(value: unknown): value is MandatePermissionMode {
  return (
    typeof value === "string" && (MANDATE_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export function isMandateRisk(value: unknown): value is MandateRisk {
  return typeof value === "string" && (MANDATE_RISKS as readonly string[]).includes(value);
}

export function isTaskStage(value: unknown): value is TaskStage {
  return typeof value === "string" && (TASK_STAGES as readonly string[]).includes(value);
}

export function isTaskReport(value: unknown): value is TaskReport {
  return typeof value === "string" && (TASK_REPORTS as readonly string[]).includes(value);
}

/** Only a person-owned stage may raise a notification or an unread mark. */
export function stageNeedsPerson(stage: TaskStage | null | undefined): boolean {
  return stage === "person/answer" || stage === "person/accept";
}

/** Deduplicated `mustAsk` union with the actions nobody can switch off. */
export function unionMustAsk(
  ...lists: ReadonlyArray<readonly BotMustAsk[] | undefined | null>
): BotMustAsk[] {
  const seen = new Set<BotMustAsk>(ALWAYS_MUST_ASK);
  for (const list of lists) {
    for (const item of list ?? []) {
      if (isBotMustAsk(item)) {
        seen.add(item);
      }
    }
  }
  return BOT_MUST_ASK.filter((item) => seen.has(item));
}

/**
 * The narrower of two permission modes.
 *
 * `inherit` is not a capability, so a side that only says "inherit" contributes
 * nothing and the other side decides. The result is never wider than either
 * concrete input, which is what makes a Mandate an ask rather than a grant.
 */
export function narrowPermission(
  left: PermissionMode | null | undefined,
  right: PermissionMode | null | undefined,
): PermissionMode {
  const concrete = [left, right].filter(
    (mode): mode is PermissionMode => typeof mode === "string" && mode !== "inherit",
  );
  if (concrete.length === 0) {
    return "inherit";
  }
  return concrete.reduce((narrowest, mode) =>
    PERMISSION_RANK[mode] < PERMISSION_RANK[narrowest] ? mode : narrowest,
  );
}

/**
 * Effective permission of a delivery carrying a Mandate: the minimum of the
 * card, the ceiling the host grants the source, and the bot's own ceiling.
 */
export function mandateCeiling(input: {
  mandate?: Pick<Mandate, "permissionMode"> | null;
  sourceCeiling?: PermissionMode | null;
  botCeiling?: PermissionMode | null;
}): PermissionMode {
  return narrowPermission(
    input.mandate?.permissionMode ?? null,
    narrowPermission(input.sourceCeiling ?? null, input.botCeiling ?? null),
  );
}

function trimmed(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (text.length === 0) {
    return undefined;
  }
  return text.length > limit ? text.slice(0, limit) : text;
}

function boundedId(value: unknown, limit: number): string | undefined {
  const text = trimmed(value, limit);
  // Identifiers travel into query strings and file names; anything outside this
  // set is refused instead of escaped, so one value cannot mean two things.
  return text && /^[A-Za-z0-9._:/-]+$/.test(text) ? text : undefined;
}

/**
 * One stored-form validator: a profile is accepted only when it is complete.
 *
 * Returns `null` for anything unusable, so a caller can decide between "no
 * profile" and an error. `observe` and `permissionMode` are required: a stored
 * profile that omitted them would otherwise be read as auto-start.
 */
export function normalizeBotProfile(value: unknown): BotProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const name = trimmed(raw.name, MAX_BOT_NAME_CHARS);
  const permissionMode = raw.permissionMode;
  if (!name || typeof permissionMode !== "string") {
    return null;
  }
  const avatar = trimmed(raw.avatar, MAX_BOT_AVATAR_CHARS);
  const duty = trimmed(raw.duty, MAX_BOT_DUTY_CHARS);
  const homeHostId = typeof raw.homeHostId === "string" ? boundedId(raw.homeHostId, 128) : undefined;
  const mustAsk = Array.isArray(raw.mustAsk)
    ? Array.from(new Set(raw.mustAsk.filter(isBotMustAsk)))
    : [];
  const profile: BotProfile = {
    name,
    permissionMode: permissionMode as PermissionMode,
    mustAsk: unionMustAsk(mustAsk),
    observe: raw.observe !== false,
  };
  if (avatar) {
    profile.avatar = avatar;
  }
  if (duty) {
    profile.duty = duty;
  }
  if (homeHostId) {
    profile.homeHostId = homeHostId;
  }
  return profile;
}

/**
 * The normalized git remote identity used for repository matching.
 *
 * `git@github.com:Owner/Repo.git`, `ssh://git@github.com/owner/repo` and
 * `https://github.com/owner/repo.git/` all mean `github.com/owner/repo`, so two
 * machines cannot believe they run different projects for the same repository.
 * Returns `undefined` when the value is not a recognizable remote.
 */
export function normalizeRepoOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let text = value.trim();
  if (!text) {
    return undefined;
  }
  text = text.replace(/^[a-z+]+:\/\//i, "");
  text = text.replace(/^[^@/]+@/, "");
  text = text.replace(/^([^/:]+):(?!\/\/)/, "$1/");
  text = text.replace(/^\/*/, "").replace(/\/+$/, "");
  text = text.replace(/\.git$/i, "");
  const segments = text.split("/");
  if (segments.length < 3) {
    return undefined;
  }
  const [host, owner, ...rest] = segments;
  const repo = rest.join("/");
  if (!host || !owner || !repo) {
    return undefined;
  }
  // Only the host is case-insensitive. Git repositories are case-sensitive,
  // so folding the owner or name would merge two different projects.
  const normalized = `${host.toLowerCase()}/${owner}/${repo}`;
  if (normalized.length > MAX_MANDATE_REPO_ORIGIN_CHARS) {
    return undefined;
  }
  return normalized;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export type MandateDecodeResult =
  | { ok: true; mandate: Mandate }
  | { ok: false; reason: string };

/**
 * Validate an untrusted Mandate exactly and strictly.
 *
 * A stored or received Mandate that does not satisfy every invariant is
 * refused rather than repaired: repairing authorization would let a caller
 * change scope by writing something nearly valid, and a version this code does
 * not know must never be reinterpreted under version-1 rules.
 */
export function decodeMandate(value: unknown): MandateDecodeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "mandate must be an object" };
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== MANDATE_VERSION) {
    return { ok: false, reason: `unsupported mandate version: ${String(raw.version)}` };
  }
  const taskId = boundedId(raw.taskId, MAX_MANDATE_ID_CHARS);
  if (!taskId) {
    return { ok: false, reason: "taskId is missing or malformed" };
  }
  const goal = trimmed(raw.goal, MAX_MANDATE_GOAL_CHARS);
  if (!goal) {
    return { ok: false, reason: "goal is required" };
  }
  const sourceUtterance = trimmed(raw.sourceUtterance, MAX_MANDATE_SOURCE_UTTERANCE_CHARS);
  if (!sourceUtterance) {
    return { ok: false, reason: "sourceUtterance is required" };
  }
  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    return { ok: false, reason: "criteria must contain at least one entry" };
  }
  if (raw.criteria.length > MAX_MANDATE_CRITERIA) {
    return { ok: false, reason: `criteria exceeds ${MAX_MANDATE_CRITERIA} entries` };
  }
  const criteria: MandateCriterion[] = [];
  for (const entry of raw.criteria) {
    const record = entry as Record<string, unknown> | null;
    const id = boundedId(record?.id, MAX_MANDATE_ID_CHARS);
    const text = trimmed(record?.text, MAX_MANDATE_CRITERION_TEXT_CHARS);
    if (!id || !text) {
      return { ok: false, reason: "each criterion needs an id and text" };
    }
    if (criteria.some((existing) => existing.id === id)) {
      return { ok: false, reason: `duplicate criterion id: ${id}` };
    }
    criteria.push({ id, text });
  }
  if (raw.boundaries !== undefined && !Array.isArray(raw.boundaries)) {
    return { ok: false, reason: "boundaries must be an array" };
  }
  const boundaries = (raw.boundaries as unknown[] | undefined) ?? [];
  if (boundaries.length > MAX_MANDATE_BOUNDARIES) {
    return { ok: false, reason: `boundaries exceeds ${MAX_MANDATE_BOUNDARIES} entries` };
  }
  const normalizedBoundaries: string[] = [];
  for (const entry of boundaries) {
    const text = trimmed(entry, MAX_MANDATE_BOUNDARY_CHARS);
    if (!text) {
      return { ok: false, reason: "each boundary needs text" };
    }
    normalizedBoundaries.push(text);
  }
  if (!isMandatePermissionMode(raw.permissionMode)) {
    return { ok: false, reason: "permissionMode must be auto, accept-edits, or ask" };
  }
  if (!isMandateRisk(raw.risk)) {
    return { ok: false, reason: "risk must be low, medium, or high" };
  }
  if (raw.mustAsk !== undefined && !Array.isArray(raw.mustAsk)) {
    return { ok: false, reason: "mustAsk must be an array" };
  }
  const mustAskRaw = (raw.mustAsk as unknown[] | undefined) ?? [];
  if (!mustAskRaw.every(isBotMustAsk)) {
    return { ok: false, reason: "mustAsk contains an unknown action" };
  }
  if (raw.repo !== undefined && (typeof raw.repo !== "object" || raw.repo === null)) {
    return { ok: false, reason: "repo must be an object" };
  }
  const repo = raw.repo as Record<string, unknown> | undefined;
  const requester = raw.requestedBy as Record<string, unknown> | null | undefined;
  if (requester?.kind !== "user") {
    return { ok: false, reason: "requestedBy.kind must be user" };
  }
  const hostId = boundedId(requester.hostId, MAX_MANDATE_ID_CHARS);
  if (!hostId) {
    return { ok: false, reason: "requestedBy.hostId is required" };
  }
  const deviceId =
    requester.deviceId === undefined ? undefined : boundedId(requester.deviceId, MAX_MANDATE_ID_CHARS);
  if (requester.deviceId !== undefined && !deviceId) {
    return { ok: false, reason: "requestedBy.deviceId is malformed" };
  }
  const createdAt = trimmed(raw.createdAt, 64);
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, reason: "createdAt must be an RFC3339 timestamp" };
  }
  const policyVersion = trimmed(raw.policyVersion, MAX_MANDATE_POLICY_VERSION_CHARS);
  if (!policyVersion) {
    return { ok: false, reason: "policyVersion is required" };
  }
  let mandateRepo: MandateRepo | undefined;
  if (repo !== undefined) {
    const origin = normalizeRepoOrigin(repo.origin);
    if (!origin) {
      return { ok: false, reason: "repo.origin is not a recognizable remote" };
    }
    mandateRepo = { origin };
    if (repo.ref !== undefined) {
      const ref = boundedId(repo.ref, MAX_MANDATE_REPO_REF_CHARS);
      if (!ref) {
        return { ok: false, reason: "repo.ref is malformed" };
      }
      mandateRepo.ref = ref;
    }
  }
  const mandate: Mandate = {
    version: MANDATE_VERSION,
    taskId,
    goal,
    criteria,
    boundaries: normalizedBoundaries,
    permissionMode: raw.permissionMode,
    mustAsk: unionMustAsk(mustAskRaw as BotMustAsk[]),
    risk: raw.risk,
    requestedBy: { kind: "user", hostId, ...(deviceId ? { deviceId } : {}) },
    sourceUtterance,
    createdAt,
    policyVersion,
    ...(mandateRepo ? { repo: mandateRepo } : {}),
  };
  if (utf8Bytes(JSON.stringify(mandate)) > MAX_MANDATE_BYTES) {
    return { ok: false, reason: `encoded mandate exceeds ${MAX_MANDATE_BYTES} bytes` };
  }
  return { ok: true, mandate };
}

/** Encode a validated Mandate for storage; refuses an invalid one. */
export function encodeMandate(mandate: Mandate): string {
  const decoded = decodeMandate(mandate);
  if (!decoded.ok) {
    throw new Error(`invalid mandate: ${decoded.reason}`);
  }
  return JSON.stringify(decoded.mandate);
}

/** Parse a stored Mandate; a malformed value decodes to a refusal, never a guess. */
export function parseMandate(raw: unknown): MandateDecodeResult {
  if (typeof raw !== "string") {
    return decodeMandate(raw);
  }
  if (raw.length === 0) {
    return { ok: false, reason: "mandate is empty" };
  }
  try {
    return decodeMandate(JSON.parse(raw));
  } catch {
    return { ok: false, reason: "mandate is not valid JSON" };
  }
}
