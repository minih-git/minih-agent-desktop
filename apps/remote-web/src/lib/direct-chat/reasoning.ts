/**
 * Thinking effort for a direct-chat turn (spec §19.12).
 *
 * The gateway is the only authority on what it supports: `/api/models` carries
 * `reasoning_levels` per model, and a level it never named is a request it may
 * refuse. So the screen offers exactly what the gateway declared, "default"
 * (send nothing) always available, and a level that outlived its model is
 * dropped instead of sent.
 *
 * The levels are the gateway's words — `none`, `minimal`, `low`, `medium`,
 * `high`, `xhigh`, `max`, `ultra`, `persistent` — and each is sent verbatim as
 * `reasoning_effort`. They are deliberately not mapped onto the desktop ladder,
 * which says `off` and knows no `ultra` or `persistent`.
 */
import {
  MINIH_ROUTER_REASONING_LEVELS,
  type MinihRouterModel,
  type MinihRouterReasoningLevel,
} from "@minih-agent/shared";

/**
 * The levels this model declared, in the gateway's own order.
 *
 * Empty when the gateway declared none (`reasoning_levels: []`), or is too old
 * to send the field at all. Either way there is no picker and no parameter: an
 * empty declaration is not a promise of any level.
 */
export function reasoningLevelsOf(
  model: MinihRouterModel | null | undefined,
): MinihRouterReasoningLevel[] {
  const declared = new Set<string>(model?.reasoningLevels ?? []);
  return MINIH_ROUTER_REASONING_LEVELS.filter((level) => declared.has(level));
}

/**
 * The level to send for this model, or `null` for "send nothing".
 *
 * `null` is also the answer for a saved level the model no longer offers: the
 * gateway would either refuse the request or silently downgrade it, and a
 * request that says what the user did not choose is worse than a default one.
 */
export function reasoningLevelFor(
  model: MinihRouterModel | null | undefined,
  saved: string | null | undefined,
): MinihRouterReasoningLevel | null {
  const value = saved?.trim() ?? "";
  if (!value) return null;
  return reasoningLevelsOf(model).find((level) => level === value) ?? null;
}

/**
 * Whether a saved level is still offered by the model it will be sent with.
 *
 * The screen uses this to tell the user why its picker snapped back to
 * "default" after a model change, instead of changing it silently.
 */
export function reasoningLevelSurvives(
  model: MinihRouterModel | null | undefined,
  saved: string | null | undefined,
): boolean {
  const value = saved?.trim() ?? "";
  return value !== "" && reasoningLevelFor(model, value) !== null;
}

/**
 * The hint the "default" row can carry: which level the gateway itself uses.
 *
 * Only a default the gateway also declares is worth showing — otherwise the row
 * would name an option the picker cannot offer.
 */
export function gatewayDefaultLevel(
  model: MinihRouterModel | null | undefined,
): MinihRouterReasoningLevel | null {
  const declared = model?.defaultReasoningLevel;
  if (!declared) return null;
  return reasoningLevelsOf(model).includes(declared) ? declared : null;
}