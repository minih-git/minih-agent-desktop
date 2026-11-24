/**
 * Minih Router gateway model profile: how one `ModelBinding` follows what the
 * gateway's `/api/models` says about its model.
 *
 * A `minih-router` row is the gateway's client: the operator maintains each
 * model once, in the gateway's own model profile, and the row follows it field
 * by field. Two states exist per field — following the gateway, or pinned by
 * the user — and this module owns the whole decision: which fields a profile
 * declares, whether a stored binding still follows them, and what a merge,
 * a pin or a restore writes.
 *
 * Everything here is pure over a parsed `MinihRouterModel`, so the settings
 * page, the startup sync and their tests share one implementation instead of
 * re-deriving the rules per surface.
 */
import { sortThinkingLevels } from "./model-catalog.js";
import {
  MODEL_SYSTEM_PROMPT_MAX_CHARS,
  type BindingProfileField,
  type BindingProfileSources,
  type ModelBinding,
  type ThinkingLevel,
} from "./types/models.js";
import type { MinihRouterModel, MinihRouterReasoningLevel } from "./minih-router.js";


/** Every binding property a gateway profile can set, in dialog order. */
export const BINDING_PROFILE_FIELDS = [
  "alias",
  "contextWindow",
  "maxTokens",
  "thinkingLevels",
  "defaultThinkingLevel",
  "thinkingProtocol",
  "apiStyle",
  "supportsImages",
  "supportsDocuments",
  "nativeWebSearch",
  "systemPrompt",
  "kind",
] as const satisfies readonly BindingProfileField[];

/** Host-core trims an alias and rejects one longer than this many characters. */
const PROFILE_ALIAS_MAX_CHARS = 60;

/** The desktop's thinking level for one of the gateway's own level names. */
export function bindingThinkingLevel(
  level: MinihRouterReasoningLevel,
): ThinkingLevel | null {
  if (level === "none") return "off";
  // The gateway knows two efforts the desktop ladder does not. Re-mapping them
  // onto a neighbour would ask for something the operator did not configure.
  if (level === "ultra" || level === "persistent") return null;
  return level;
}

/**
 * The enabled ladder a gateway declaration maps to.
 *
 * Empty means "nothing the desktop can send": a model that declares only
 * `ultra` has no level to offer here, which is not the same as declaring that
 * the model cannot think.
 */
export function bindingThinkingLevelsFromRouterModel(
  model: MinihRouterModel,
): ThinkingLevel[] {
  const levels = (model.reasoningLevels ?? [])
    .map(bindingThinkingLevel)
    .filter((level): level is ThinkingLevel => level !== null);
  return sortThinkingLevels(levels);
}

/** The desktop thinking level for the gateway's own default, when it names one. */
export function bindingDefaultThinkingLevelFromRouterModel(
  model: MinihRouterModel,
): ThinkingLevel | null {
  const declared = model.defaultReasoningLevel;
  return declared ? bindingThinkingLevel(declared) : null;
}

/**
 * Whether one field of a stored binding still follows the gateway profile.
 *
 * An explicit marker wins. A record written before the markers existed follows
 * the gateway too, except where its own content can only be a person's answer:
 * a `user` limit marker, a non-empty alias, or a non-empty instruction block.
 * Reading those as the gateway's would silently discard what the user typed.
 */
export function profileFollowsGateway(
  binding: Pick<
    ModelBinding,
    | "alias"
    | "systemPrompt"
    | "contextWindowSource"
    | "maxTokensSource"
    | "profileSources"
  >,
  field: BindingProfileField | "imageGeneration",
): boolean {
  const marked = binding.profileSources?.[field];
  if (marked) return marked === "gateway";
  if (field === "contextWindow") return binding.contextWindowSource !== "user";
  if (field === "maxTokens") return binding.maxTokensSource !== "user";
  if (field === "alias") return !binding.alias?.trim();
  if (field === "systemPrompt") return !binding.systemPrompt?.trim();
  return true;
}

/** How a declared input-modality list answers one capability question. */
function declaredModality(
  model: MinihRouterModel,
  modality: "image" | "pdf",
): boolean | undefined {
  const declared = model.inputModalities;
  // An empty or missing list is the gateway asserting nothing; only a list it
  // actually sent can tell us the model does *not* take an input.
  if (!declared || declared.length === 0) return undefined;
  return declared.includes(modality);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return Object.is(left, right);
}

/**
 * Apply one gateway model profile to one binding.
 *
 * Only fields the gateway declares for this model are touched, and only while
 * they still follow it; a value the operator removed from the profile leaves
 * the local setting exactly as it is. `null` means the binding already matches,
 * so callers write nothing — the sync runs on every start and page open, and a
 * no-op must not become a save.
 */
export function mergeRouterModelProfile(
  binding: ModelBinding,
  model: MinihRouterModel,
): ModelBinding | null {
  const next: ModelBinding = { ...binding };
  const sources: BindingProfileSources = { ...(binding.profileSources ?? {}) };
  let changed = false;

  const follows = (field: BindingProfileField): boolean =>
    profileFollowsGateway(binding, field);

  /** One field the gateway declared, unless the user pinned it. */
  const apply = (field: BindingProfileField, value: unknown): void => {
    if (value === undefined || !follows(field)) return;
    if (!sameValue((next as Record<string, unknown>)[field], value)) {
      (next as Record<string, unknown>)[field] = value;
      changed = true;
    }
    // Recording ownership is itself the point: it is what keeps the next read
    // from re-deciding a legacy record, and what "restore" clears.
    if (sources[field] !== "gateway") {
      sources[field] = "gateway";
      changed = true;
    }
  };

  if (model.contextWindow !== null && follows("contextWindow")) {
    if (next.contextWindow !== model.contextWindow) {
      next.contextWindow = model.contextWindow;
      changed = true;
    }
    // `gateway` rather than `catalog`: models.dev must not replace the number
    // the gateway resolved for its own route.
    if (next.contextWindowSource !== "gateway") {
      next.contextWindowSource = "gateway";
      changed = true;
    }
  }
  if (model.maxOutput !== null && follows("maxTokens")) {
    if (next.maxTokens !== model.maxOutput) {
      next.maxTokens = model.maxOutput;
      changed = true;
    }
    if (next.maxTokensSource !== "gateway") {
      next.maxTokensSource = "gateway";
      changed = true;
    }
  }

  const thinkingLevels = bindingThinkingLevelsFromRouterModel(model);
  // A declaration the desktop ladder cannot express leaves the local ladder
  // alone instead of emptying it.
  apply("thinkingLevels", thinkingLevels.length > 0 ? thinkingLevels : undefined);
  const declaredDefault = bindingDefaultThinkingLevelFromRouterModel(model);
  if (declaredDefault && next.thinkingLevels.includes(declaredDefault)) {
    apply("defaultThinkingLevel", declaredDefault);
  }

  apply("alias", model.displayName ? clampAlias(model.displayName) : undefined);
  apply("thinkingProtocol", model.thinkingProtocol);
  apply("apiStyle", model.apiStyle);
  apply(
    "systemPrompt",
    model.systemPrompt
      ? model.systemPrompt.slice(0, MODEL_SYSTEM_PROMPT_MAX_CHARS)
      : undefined,
  );
  apply("supportsImages", declaredModality(model, "image"));
  apply("supportsDocuments", declaredModality(model, "pdf"));

  if (model.nativeWebSearch !== undefined && follows("nativeWebSearch")) {
    // Absent and `false` are one stored state: the tool stays off. The marker
    // is still written, so a later `true` from the gateway reaches this row.
    const enabled = model.nativeWebSearch;
    if (Boolean(next.nativeWebSearch) !== enabled) {
      if (enabled) next.nativeWebSearch = true;
      else delete next.nativeWebSearch;
      changed = true;
    }
    if (sources.nativeWebSearch !== "gateway") {
      sources.nativeWebSearch = "gateway";
      changed = true;
    }
  }

  if (model.kind !== undefined && follows("kind")) {
    const kind = model.kind === "embedding" ? "embedding" : undefined;
    if (next.kind !== kind) {
      if (kind) next.kind = kind;
      else delete next.kind;
      changed = true;
    }
    if (sources.kind !== "gateway") {
      sources.kind = "gateway";
      changed = true;
    }
  }

  if (!changed) return null;
  if (Object.keys(sources).length > 0) next.profileSources = sources;
  return next;
}

/** Trim, then cap by code point: host-core rejects a longer alias outright. */
function clampAlias(value: string): string {
  const trimmed = value.trim();
  return [...trimmed].slice(0, PROFILE_ALIAS_MAX_CHARS).join("");
}

/**
 * The profile fields one gateway model declares for its model.
 *
 * These are the only fields a merge can write, so they are also the ones the
 * model dialog can mark as following and the ones "restore" can hand back.
 */
export function declaredProfileFields(model: MinihRouterModel): BindingProfileField[] {
  const fields: BindingProfileField[] = [];
  if (model.contextWindow !== null) fields.push("contextWindow");
  if (model.maxOutput !== null) fields.push("maxTokens");
  const levels = bindingThinkingLevelsFromRouterModel(model);
  if (levels.length > 0) fields.push("thinkingLevels");
  const declaredDefault = bindingDefaultThinkingLevelFromRouterModel(model);
  if (declaredDefault && levels.includes(declaredDefault)) fields.push("defaultThinkingLevel");
  if (model.displayName) fields.push("alias");
  if (model.thinkingProtocol) fields.push("thinkingProtocol");
  if (model.apiStyle) fields.push("apiStyle");
  if (model.systemPrompt) fields.push("systemPrompt");
  if (declaredModality(model, "image") !== undefined) fields.push("supportsImages");
  if (declaredModality(model, "pdf") !== undefined) fields.push("supportsDocuments");
  if (model.nativeWebSearch !== undefined) fields.push("nativeWebSearch");
  if (model.kind !== undefined) fields.push("kind");
  return fields;
}

/**
 * Hand every field the gateway declares back to it, and apply the profile now.
 *
 * This is the dialog's "restore" action. It marks the declared fields as
 * following rather than merely dropping the markers: a dropped marker falls
 * back to the historical rule, which treats the alias the user can see on
 * screen as their own answer and would leave it unchanged.
 */
export function restoreRouterProfileFollow(
  binding: ModelBinding,
  model: MinihRouterModel | null | undefined,
): ModelBinding {
  const restored: ModelBinding = { ...binding };
  delete restored.contextWindowSource;
  delete restored.maxTokensSource;
  const declared = model ? declaredProfileFields(model) : [];
  const sources: BindingProfileSources = {};
  for (const field of declared) sources[field] = "gateway";
  // The image designation is a settings entry, not a binding field, so it
  // follows again the moment one of these models is read.
  if (model) sources.imageGeneration = "gateway";
  if (Object.keys(sources).length > 0) restored.profileSources = sources;
  else delete restored.profileSources;
  if (!model) return restored;
  return mergeRouterModelProfile(restored, model) ?? restored;
}

/**
 * Apply the gateway profile to the bindings a row already carries.
 *
 * Only existing bindings are considered, and unchanged ones keep their
 * identity, so a caller can write the list only when something moved. No model
 * is added: this is the startup path, and a model the user removed must not
 * reappear because the app was restarted.
 */
export function mergeRouterModelProfileList(
  bindings: readonly ModelBinding[],
  models: readonly MinihRouterModel[],
): ModelBinding[] | null {
  const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
  let changed = false;
  const next = bindings.map((binding) => {
    const model = byId.get(binding.id.toLowerCase());
    const merged = model ? mergeRouterModelProfile(binding, model) : null;
    if (!merged) return binding;
    changed = true;
    return merged;
  });
  return changed ? next : null;
}

/**
 * Mark every profile field one dialog edit changed as the user's own answer.
 *
 * Called with the binding *before* the patch: the sources map is replaced, not
 * merged, by the caller, so the whole map has to be complete here.
 */
export function pinRouterProfilePatch(
  binding: ModelBinding,
  patch: Partial<ModelBinding>,
): Partial<ModelBinding> {
  const next: Partial<ModelBinding> = { ...patch };
  const sources: BindingProfileSources = { ...(binding.profileSources ?? {}) };
  for (const field of BINDING_PROFILE_FIELDS) {
    if (!(field in patch)) continue;
    // The limits carry their own two markers; adding a third spelling of the
    // same answer would be a second source of truth.
    if (field === "contextWindow" || field === "maxTokens") continue;
    sources[field] = "user";
  }
  if (Object.keys(sources).length > 0) next.profileSources = sources;
  // A limit the dialog did not already mark belongs to the user by definition.
  if ("contextWindow" in patch && next.contextWindowSource !== "user") {
    next.contextWindowSource = "user";
  }
  if ("maxTokens" in patch && next.maxTokensSource !== "user") {
    next.maxTokensSource = "user";
  }
  return next;
}

/** Whether the gateway declares that this model draws images. */
export function routerModelGeneratesImages(model: MinihRouterModel): boolean {
  return (model.outputModalities ?? []).includes("image");
}

/**
 * The ids a router row should designate for image generation, or `null` when
 * nothing changes.
 *
 * Designating is what puts a model in the image picker, so a model the gateway
 * marks as image output is designated the first time it is seen. The rule is
 * additive only: a model whose designation the user removed carries the pinned
 * marker and is never re-added, and a model the gateway stops marking keeps the
 * designation, because taking it away would break image generation that works.
 */
export function planRouterImageModelIds(
  currentIds: readonly string[],
  bindings: readonly ModelBinding[],
  models: readonly MinihRouterModel[],
): string[] | null {
  const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
  const designated = new Set(currentIds.map((id) => id.toLowerCase()));
  const next = [...currentIds];
  for (const binding of bindings) {
    if (!profileFollowsGateway(binding, "imageGeneration")) continue;
    const model = byId.get(binding.id.toLowerCase());
    if (!model || !routerModelGeneratesImages(model)) continue;
    if (designated.has(binding.id.toLowerCase())) continue;
    designated.add(binding.id.toLowerCase());
    next.push(binding.id);
  }
  return next.length === currentIds.length ? null : next;
}