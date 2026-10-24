/**
 * Choosing a session's model (R7, spec §15.2/§15.3).
 *
 * Two placements, one list: the new-session sheet picks the model a session
 * starts on, and the session-info sheet changes it while the session is idle.
 * The list is metadata the Host sent through `model/list` — provider and model
 * names, thinking levels, whether the model reads images, which entry is the
 * Host's default — and nothing else, so there is no credential for this module
 * to leak even by accident.
 */
import { nearestSupportedThinkingLevel, THINKING_LEVELS, type ThinkingLevel, type RacpModelSummary } from "@minih-agent/shared";

/** What the picker row shows when no choice has been made or none can be. */
export type ModelChoice =
  | { kind: "host-default" }
  | { kind: "model"; model: RacpModelSummary }
  | { kind: "unavailable"; reason: string };

export function modelKey(model: Pick<RacpModelSummary, "providerId" | "modelId">): string {
  return `${model.providerId}/${model.modelId}`;
}

/** "Claude Sonnet 5 · Anthropic", or the Host default's own wording. */
export function describeModel(model: RacpModelSummary): string {
  return `${model.label} · ${model.providerLabel}`;
}

/**
 * Which model a new session should start on.
 *
 * A stored choice wins as long as the Host still offers it — the user picked it
 * on purpose — and otherwise the Host's default is used rather than nothing, so
 * a model removed on the computer never turns into a failed creation.
 */
export function resolveNewSessionModel(
  models: readonly RacpModelSummary[],
  chosenKey: string | null,
): ModelChoice {
  if (chosenKey) {
    const chosen = models.find((model) => modelKey(model) === chosenKey);
    if (chosen) return { kind: "model", model: chosen };
  }
  const fallback = models.find((model) => model.isDefault) ?? models[0];
  return fallback ? { kind: "model", model: fallback } : { kind: "host-default" };
}

/**
 * Whether the model of a running session may be changed.
 *
 * The desktop refuses to switch the model under a running turn, and the phone
 * shows that reason instead of a control that would be rejected. A decision
 * waiting on the user counts as running: the turn has not ended.
 */
export function modelSwitchBlockedReason(input: {
  running: boolean;
  hasPendingDecision: boolean;
}): string | null {
  if (input.running) return "model.locked.running";
  if (input.hasPendingDecision) return "model.locked.decision";
  return null;
}

/** The thinking levels a chosen model offers, with the Host's default first. */
export function thinkingLevelsFor(model: RacpModelSummary): string[] {
  const levels = [...model.thinkingLevels];
  const preferred = model.defaultThinkingLevel;
  if (!preferred || !levels.includes(preferred)) return levels;
  return [preferred, ...levels.filter((level) => level !== preferred)];
}

/** Whether `value` is one of the canonical levels the desktop understands. */
export function isThinkingLevel(value: string | null | undefined): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * A model's levels in canonical order, for a picker.
 *
 * `thinkingLevelsFor` puts the Host's default first because that is what a
 * caller offering one shortcut wants; a list the reader scans should instead
 * read off → max, so a level is always in the same place.
 */
export function orderedThinkingLevels(model: RacpModelSummary): ThinkingLevel[] {
  const offered = new Set(model.thinkingLevels);
  return THINKING_LEVELS.filter((level) => offered.has(level));
}

/**
 * The level this session is on, for display.
 *
 * A session that recorded no level follows the model's default, and a model
 * with neither shows nothing rather than an invented `off`.
 */
export function effectiveThinkingLevel(
  model: Pick<RacpModelSummary, "thinkingLevels" | "defaultThinkingLevel"> | null | undefined,
  stored: string | null | undefined,
): string | null {
  const value = stored?.trim() ?? "";
  if (value) return value;
  if (!model) return null;
  if (model.defaultThinkingLevel) return model.defaultThinkingLevel;
  return model.thinkingLevels[0] ?? null;
}

/**
 * The level to send with a model switch, or `null` when none has to be sent.
 *
 * A level the new model still offers is kept by leaving the field out — the
 * session keeps it. When it is gone, the new model's own default wins, and only
 * a model that has no default falls back to the desktop's nearest-supported
 * walk (`nearestSupportedThinkingLevel`), so both clients answer the same way.
 */
export function thinkingLevelOnModelSwitch(
  model: Pick<RacpModelSummary, "thinkingLevels" | "defaultThinkingLevel">,
  current: string | null | undefined,
): string | null {
  const value = current?.trim() ?? "";
  if (!value) return null;
  const levels = model.thinkingLevels;
  if (levels.length === 0 || levels.includes(value)) return null;
  const preferred = model.defaultThinkingLevel;
  if (isThinkingLevel(preferred) && levels.includes(preferred)) return preferred;
  if (isThinkingLevel(value)) {
    return nearestSupportedThinkingLevel(
      value,
      levels.filter((level): level is ThinkingLevel => isThinkingLevel(level)),
    );
  }
  // A level outside the canonical ladder (a Host with its own vocabulary): the
  // best answer is the new model's first level, not a guess at a neighbour.
  return levels[0] ?? null;
}
