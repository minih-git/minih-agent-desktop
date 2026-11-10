/**
 * The task card: what a steward proposes, and how a proposal becomes a Mandate
 * (ADR bot-sessions-and-steward §3).
 *
 * A card is a *proposal*. It becomes authorization only when the person
 * confirms it, and the confirmation freezes exactly what was proposed. That
 * gives this module three jobs and no fourth:
 *
 * 1. **Normalize a proposal** into the shape a person can read and approve:
 *    bounded text, deduplicated criteria, the always-asked actions already
 *    merged in, and the normalized repository identity.
 * 2. **Freeze it** into a `Mandate` with the requester, the person's own words
 *    and a task identity — once, and only after a confirmation.
 * 3. **Refuse** anything that would let a proposal become a grant: a missing or
 *    `inherit` permission mode, an unknown action, an oversized card, or a
 *    second confirmation of an already-frozen card.
 *
 * There is deliberately no "amend a confirmed card" path. Widening scope is a
 * new card with a new `taskId`.
 */

import {
  ALWAYS_MUST_ASK,
  BOT_MUST_ASK,
  MAX_MANDATE_BOUNDARIES,
  MAX_MANDATE_BOUNDARY_CHARS,
  MAX_MANDATE_CRITERIA,
  MAX_MANDATE_CRITERION_TEXT_CHARS,
  MAX_MANDATE_GOAL_CHARS,
  MAX_MANDATE_ID_CHARS,
  MAX_MANDATE_POLICY_VERSION_CHARS,
  MAX_MANDATE_REPO_REF_CHARS,
  MAX_MANDATE_SOURCE_UTTERANCE_CHARS,
  MANDATE_PERMISSION_MODES,
  MANDATE_RISKS,
  MANDATE_VERSION,
  decodeMandate,
  normalizeRepoOrigin,
  unionMustAsk,
  type BotMustAsk,
  type Mandate,
  type MandateCriterion,
  type MandatePermissionMode,
  type MandateRisk,
} from "./bot-session.js";

/** A card as the steward proposes it, before anyone has confirmed it. */
export type TaskCardDraft = {
  goal: string;
  criteria: Array<{ id?: string; text: string }>;
  boundaries?: string[];
  repo?: { origin: string; ref?: string };
  permissionMode?: MandatePermissionMode;
  mustAsk?: BotMustAsk[];
  risk?: MandateRisk;
};

export type TaskCardDecision = "proposed" | "confirmed";

export type TaskCardError =
  | "goal"
  | "criteria"
  | "boundaries"
  | "permission-mode"
  | "must-ask"
  | "risk"
  | "repo"
  | "already-confirmed";

export type TaskCardResult =
  | { ok: true; draft: TaskCardDraft; card: TaskCardFields }
  | { ok: false; error: TaskCardError; message: string };

/** What a card looks like once normalized, before it is tied to a person. */
export type TaskCardFields = {
  goal: string;
  criteria: MandateCriterion[];
  boundaries: string[];
  repo?: { origin: string; ref?: string };
  permissionMode: MandatePermissionMode;
  mustAsk: BotMustAsk[];
  risk: MandateRisk;
};

const DEFAULT_RISK: MandateRisk = "medium";

function clampText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * Normalize one proposed card.
 *
 * Refusals are named rather than merged into "invalid", because the steward
 * has to tell the person which part of their request it could not express.
 * Omitting `permissionMode` is a refusal, not a default: a default would let a
 * card carry authority nobody chose.
 */
export function normalizeTaskCard(draft: TaskCardDraft): TaskCardResult {
  const goal = clampText(draft.goal, MAX_MANDATE_GOAL_CHARS);
  if (!goal) {
    return { ok: false, error: "goal", message: "A task card needs a one-sentence goal." };
  }
  if (draft.permissionMode === undefined) {
    return {
      ok: false,
      error: "permission-mode",
      message:
        "A task card must state its permission mode (`auto`, `accept-edits`, or `ask`); a card never inherits one.",
    };
  }
  if (!(MANDATE_PERMISSION_MODES as readonly string[]).includes(draft.permissionMode)) {
    return {
      ok: false,
      error: "permission-mode",
      message: `\`${String(draft.permissionMode)}\` is not a permission a card can ask for.`,
    };
  }
  const rawCriteria = Array.isArray(draft.criteria) ? draft.criteria : [];
  if (rawCriteria.length === 0) {
    return {
      ok: false,
      error: "criteria",
      message: "A task card needs at least one acceptance criterion the person can check.",
    };
  }
  if (rawCriteria.length > MAX_MANDATE_CRITERIA) {
    return {
      ok: false,
      error: "criteria",
      message: `A task card accepts at most ${MAX_MANDATE_CRITERIA} criteria.`,
    };
  }
  const criteria: MandateCriterion[] = [];
  for (const [index, entry] of rawCriteria.entries()) {
    const text = clampText(entry?.text, MAX_MANDATE_CRITERION_TEXT_CHARS);
    if (!text) {
      return {
        ok: false,
        error: "criteria",
        message: `Criterion ${index + 1} has no text.`,
      };
    }
    // The id is the steward's handle for one criterion; when it omits one the
    // position is the only stable name, so derive it rather than invent a uuid
    // the person cannot correlate with the card they read.
    const id =
      clampText(entry?.id, MAX_MANDATE_ID_CHARS) ?? `c${index + 1}`;
    if (criteria.some((existing) => existing.id === id)) {
      return { ok: false, error: "criteria", message: `Duplicate criterion id \`${id}\`.` };
    }
    criteria.push({ id, text });
  }
  const rawBoundaries = Array.isArray(draft.boundaries) ? draft.boundaries : [];
  if (rawBoundaries.length > MAX_MANDATE_BOUNDARIES) {
    return {
      ok: false,
      error: "boundaries",
      message: `A task card accepts at most ${MAX_MANDATE_BOUNDARIES} boundaries.`,
    };
  }
  const boundaries: string[] = [];
  for (const entry of rawBoundaries) {
    const text = clampText(entry, MAX_MANDATE_BOUNDARY_CHARS);
    if (!text) {
      return { ok: false, error: "boundaries", message: "A boundary has no text." };
    }
    boundaries.push(text);
  }
  const rawMustAsk = Array.isArray(draft.mustAsk) ? draft.mustAsk : [];
  const unknown = rawMustAsk.filter((item) => !(BOT_MUST_ASK as readonly string[]).includes(item));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: "must-ask",
      message: `Unknown must-ask action(s): ${unknown.map(String).join(", ")}.`,
    };
  }
  const risk = draft.risk ?? DEFAULT_RISK;
  if (!(MANDATE_RISKS as readonly string[]).includes(risk)) {
    return { ok: false, error: "risk", message: `\`${String(risk)}\` is not a known risk level.` };
  }
  let repo: { origin: string; ref?: string } | undefined;
  if (draft.repo !== undefined) {
    const origin = normalizeRepoOrigin(draft.repo?.origin);
    if (!origin) {
      return {
        ok: false,
        error: "repo",
        message: "`repo.origin` is not a recognizable git remote (host/owner/name).",
      };
    }
    repo = { origin };
    if (draft.repo?.ref !== undefined) {
      const ref = clampText(draft.repo.ref, MAX_MANDATE_REPO_REF_CHARS);
      if (!ref) {
        return { ok: false, error: "repo", message: "`repo.ref` is malformed." };
      }
      repo.ref = ref;
    }
  }
  const fields: TaskCardFields = {
    goal,
    criteria,
    boundaries,
    permissionMode: draft.permissionMode,
    // Nobody can switch these off, so they are merged in before a person ever
    // reads the card — the card states what will happen, not what was asked.
    mustAsk: unionMustAsk(rawMustAsk),
    risk,
    ...(repo ? { repo } : {}),
  };
  return { ok: true, draft, card: fields };
}

export type FreezeInput = {
  card: TaskCardFields;
  taskId: string;
  /** The person's own words, kept for review; bounded, never trusted as policy. */
  sourceUtterance: string;
  requestedBy: { hostId: string; deviceId?: string };
  createdAt: string;
  policyVersion: string;
};

/**
 * Freeze a normalized card into the authorization of record.
 *
 * This is the only way a `Mandate` is produced, and it demands a person
 * (`requestedBy`) and the exact words they used. The result is validated by the
 * same decoder the receiver uses, so a card that could not be delivered is
 * refused here instead of at dispatch.
 */
export function freezeTaskCard(input: FreezeInput):
  | { ok: true; mandate: Mandate }
  | { ok: false; error: TaskCardError; message: string } {
  const sourceUtterance = clampText(input.sourceUtterance, MAX_MANDATE_SOURCE_UTTERANCE_CHARS);
  if (!sourceUtterance) {
    return {
      ok: false,
      error: "goal",
      message: "A confirmed card needs the request it came from so the person can review it.",
    };
  }
  const policyVersion = clampText(input.policyVersion, MAX_MANDATE_POLICY_VERSION_CHARS);
  if (!policyVersion) {
    return { ok: false, error: "goal", message: "A card needs a policy version." };
  }
  const candidate: Mandate = {
    version: MANDATE_VERSION,
    taskId: input.taskId,
    goal: input.card.goal,
    criteria: input.card.criteria,
    boundaries: input.card.boundaries,
    ...(input.card.repo ? { repo: input.card.repo } : {}),
    permissionMode: input.card.permissionMode,
    mustAsk: unionMustAsk(input.card.mustAsk),
    risk: input.card.risk,
    requestedBy: {
      kind: "user",
      hostId: input.requestedBy.hostId,
      ...(input.requestedBy.deviceId ? { deviceId: input.requestedBy.deviceId } : {}),
    },
    sourceUtterance,
    createdAt: input.createdAt,
    policyVersion,
  };
  const decoded = decodeMandate(candidate);
  return decoded.ok
    ? { ok: true, mandate: decoded.mandate }
    : { ok: false, error: "goal", message: decoded.reason };
}

/**
 * A card the steward keeps between turns.
 *
 * The reason this is a value and not "whatever the model remembers" is that a
 * person may confirm a card turns later, and the confirmed text must still be
 * the text they were shown.
 */
export type DraftedCard = {
  /** Stable handle the person's answer refers to. */
  draftId: string;
  status: TaskCardDecision;
  card: TaskCardFields;
  sourceUtterance: string;
  /** Present exactly after confirmation; immutable afterwards. */
  mandate?: Mandate;
};

/**
 * Confirm a drafted card.
 *
 * A card can be confirmed exactly once. Confirming a different card is a new
 * draft, never an edit — that is what keeps "what did I approve" answerable.
 */
export function confirmTaskCard(
  drafted: DraftedCard,
  input: Omit<FreezeInput, "card">,
): { ok: true; drafted: DraftedCard } | { ok: false; error: TaskCardError; message: string } {
  if (drafted.status === "confirmed" || drafted.mandate) {
    return {
      ok: false,
      error: "already-confirmed",
      message:
        "This card was already confirmed. Widen the task with a new card; a confirmed authorization is never rewritten.",
    };
  }
  const frozen = freezeTaskCard({ ...input, card: drafted.card });
  if (!frozen.ok) return frozen;
  return {
    ok: true,
    drafted: { ...drafted, status: "confirmed", mandate: frozen.mandate },
  };
}

/** One-line summary a person can read in the transcript, and the steward can echo. */
export function describeTaskCard(card: TaskCardFields): string {
  const lines = [
    `goal: ${card.goal}`,
    ...card.criteria.map((criterion) => `  [${criterion.id}] ${criterion.text}`),
    ...(card.boundaries.length > 0
      ? [`boundaries: ${card.boundaries.join("; ")}`]
      : []),
    `permission: ${card.permissionMode}`,
    `must ask: ${card.mustAsk.join(", ") || "—"}${ALWAYS_MUST_ASK.every((item) => card.mustAsk.includes(item)) ? "" : " (unexpected)"}`,
    `risk: ${card.risk}`,
    ...(card.repo ? [`repo: ${card.repo.origin}${card.repo.ref ? `@${card.repo.ref}` : ""}`] : []),
  ];
  return lines.join("\n");
}
