/**
 * Pure planning for the models page: how the Minih Router row's binding list
 * changes when the gateway catalog is mirrored onto it, when a model is
 * configured, and when one is removed — plus what app defaults must move with
 * it.
 *
 * Pure on purpose: the same rules decide the app's chat and image defaults and
 * which models the page offers at all, so they are unit-tested without mounting
 * the page (the page only performs the plan's I/O).
 */
import {
  bindingForCustomModel,
  bindingForCustomModelInfo,
  type ImageGenerationBinding,
  type MinihRouterModel,
  type ModelBinding,
  type ModelInfo,
  type ProviderPublic,
} from "@minih-agent/shared";
import { keepsAppDefaultModel } from "./default-model.ts";
import { planImageGenerationDefaults } from "./image-generation-default.ts";

/** Case-insensitive wire-id equality, the way the rest of the app compares. */
function sameId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Seed a binding from a gateway plaza model.
 *
 * The models.dev record wins when it describes the id — it carries the
 * published limits, thinking ladder and attachment capabilities — and the
 * gateway's own context window is the fallback for an id the catalog has not
 * described yet. Either way the seed stays catalog-sourced: nothing is pinned,
 * so a later catalog correction still reaches the binding.
 */
export function bindingFromRouterModel(
  model: MinihRouterModel,
  info?: ModelInfo | null,
): ModelBinding {
  if (info) {
    const binding = bindingForCustomModelInfo(model.id, info);
    const published = info.limit?.context ?? info.contextWindow;
    return published
      ? binding
      : { ...binding, contextWindow: model.contextWindow ?? binding.contextWindow };
  }
  const seed = bindingForCustomModel(model.id);
  return model.contextWindow == null
    ? seed
    : { ...seed, contextWindow: model.contextWindow };
}

/** Append only models the row does not carry yet, preserving saved order. */
export function mergeAddedBindings(
  current: readonly ModelBinding[],
  added: readonly MinihRouterModel[],
  infoFor?: (model: MinihRouterModel) => ModelInfo | null | undefined,
): ModelBinding[] {
  const next = [...current];
  for (const model of added) {
    if (next.some((binding) => sameId(binding.id, model.id))) continue;
    next.push(bindingFromRouterModel(model, infoFor?.(model)));
  }
  return next;
}

/** Drop one binding by wire id. */
export function bindingAfterRemoval(
  current: readonly ModelBinding[],
  modelId: string,
): ModelBinding[] {
  return current.filter((binding) => !sameId(binding.id, modelId));
}

/** Normalize one hidden-id entry to the stored lowercase wire id. */
function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * The ids the models page hides for one provider row.
 *
 * Settings stores them per row because a second Router row (a self-hosted
 * gateway, another account) has its own catalog; an absent row hides nothing.
 */
export function hiddenModelIdsFor(
  hiddenById: Readonly<Record<string, readonly string[]>> | null | undefined,
  providerId: string | null | undefined,
): string[] {
  if (!providerId || !hiddenById) return [];
  const ids = hiddenById[providerId];
  return Array.isArray(ids) ? [...new Set(ids.map(normalizeId).filter(Boolean))] : [];
}

/** The hidden list with one more id; a no-op when it is already there. */
export function hiddenIdsWith(hiddenIds: readonly string[], modelId: string): string[] {
  const next = normalizeId(modelId);
  return next && !hiddenIds.includes(next) ? [...hiddenIds, next] : [...hiddenIds];
}

/** The hidden list without the given ids, in the order the list had. */
export function hiddenIdsWithout(
  hiddenIds: readonly string[],
  restoredIds: readonly string[],
): string[] {
  const restored = new Set(restoredIds.map(normalizeId));
  return hiddenIds.filter((id) => !restored.has(id));
}

/** Same hidden set, ignoring order and duplicates. */
export function sameHiddenIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = new Set(left.map(normalizeId));
  const b = new Set(right.map(normalizeId));
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * The catalog rows the page still has to append: on the gateway, not hidden,
 * and not already on the row. The caller looks up published info for exactly
 * this set, so a settled page asks the catalog for nothing.
 */
export function missingCatalogModels(
  current: readonly ModelBinding[],
  catalog: readonly MinihRouterModel[],
  hiddenIds: readonly string[],
): MinihRouterModel[] {
  const hidden = new Set(hiddenIds.map(normalizeId));
  return catalog.filter(
    (model) =>
      !hidden.has(normalizeId(model.id)) &&
      !current.some((binding) => sameId(binding.id, model.id)),
  );
}

/**
 * The row's binding list after a catalog sync, or `null` when it already
 * matches: bindings the user removed stay out, every other catalog model is
 * carried, and the row's own order is preserved.
 *
 * A binding the gateway no longer lists is kept: the row may be serving an id
 * the plaza stopped advertising, and silently dropping it would reroute a
 * model the user still sends. Only an explicit removal leaves the list.
 */
export function planCatalogSync(
  current: readonly ModelBinding[],
  catalog: readonly MinihRouterModel[],
  hiddenIds: readonly string[],
  infoFor?: (model: MinihRouterModel) => ModelInfo | null | undefined,
): ModelBinding[] | null {
  const hidden = new Set(hiddenIds.map(normalizeId));
  const kept = current.filter((binding) => !hidden.has(normalizeId(binding.id)));
  const next = mergeAddedBindings(
    kept,
    catalog.filter((model) => !hidden.has(normalizeId(model.id))),
    infoFor,
  );
  const unchanged =
    next.length === current.length &&
    next.every((binding, index) => binding === current[index]);
  return unchanged ? null : next;
}

export type ModelsPageSettingsDraft = {
  defaultProviderId?: string;
  defaultModelId?: string;
  imageGenerationModels?: ImageGenerationBinding[] | null;
  imageGeneration?: ImageGenerationBinding | null;
};

export type ModelsPageSavePlan = {
  /** `updateProvider` input for the row's new binding list. */
  provider: {
    id: string;
    models: ModelBinding[];
    defaultModelId?: string;
  };
  /**
   * Settings to write after the provider save, when defaults must move.
   * `null` means the stored defaults already resolve and stay untouched.
   */
  settings: ModelsPageSettingsDraft | null;
};

/**
 * Plan a save of the row's binding list:
 *
 * - the row's own `defaultModelId` follows the first remaining binding;
 * - the app's chat default is kept while it still resolves *and* still names a
 *   binding this row keeps — a removed model must not stay the default just
 *   because the row happens to serve others — and it is claimed by the first
 *   binding otherwise, the same rule the service dialog applies after a
 *   provider save;
 * - image bindings follow `imageModelIds` when the caller carries an explicit
 *   selection (the configure dialog's image-model checkbox), and otherwise
 * keep the stored selection filtered by the bindings that remain, dropping a
 * default whose model was removed.
 */
export function planModelsSave(
  provider: ProviderPublic,
  nextBindings: readonly ModelBinding[],
  settings: ModelsPageSettingsDraft,
  providers: readonly ProviderPublic[],
  imageModelIds?: readonly string[],
): ModelsPageSavePlan {
  const savedRow: ProviderPublic = { ...provider, models: [...nextBindings] };
  const nextProviders = providers.map((row) => (row.id === provider.id ? savedRow : row));
  const firstModelId = nextBindings[0]?.id;
  const namedDefault = (settings.defaultModelId ?? "").trim();
  const keepsDefault =
    (settings.defaultProviderId !== provider.id ||
      !namedDefault ||
      nextBindings.some((binding) => sameId(binding.id, namedDefault))) &&
    keepsAppDefaultModel(
      nextProviders,
      settings.defaultProviderId,
      settings.defaultModelId,
    );
  const imageIds = imageModelIds !== undefined
    ? [...new Set(imageModelIds)]
    : (settings.imageGenerationModels ?? [])
      .filter((binding) => binding.providerId === provider.id)
      .map((binding) => binding.modelId)
      .filter((modelId) => nextBindings.some((binding) => sameId(binding.id, modelId)));
  const imageRemovedDefault = !!settings.imageGeneration &&
    settings.imageGeneration.providerId === provider.id &&
    !nextBindings.some((binding) => sameId(binding.id, settings.imageGeneration!.modelId));
  const imagePlan = planImageGenerationDefaults(
    settings,
    provider.id,
    imageIds,
    nextProviders,
    imageRemovedDefault,
  );
  const chatDefaultMoves = !keepsDefault && !!firstModelId;
  const imageDraft = (settings.imageGenerationModels ?? []).filter(
    (binding) => binding.providerId === provider.id,
  );
  const imageChanged =
    imageIds.length !== imageDraft.length ||
    JSON.stringify(imagePlan) !== JSON.stringify({
      imageGenerationModels: settings.imageGenerationModels ?? [],
      imageGeneration: settings.imageGeneration ?? null,
    });
  return {
    provider: {
      id: provider.id,
      models: [...nextBindings],
      ...(firstModelId ? { defaultModelId: firstModelId } : {}),
    },
    settings: chatDefaultMoves || imageChanged
      ? {
          ...(chatDefaultMoves
            ? { defaultProviderId: provider.id, defaultModelId: firstModelId }
            : {}),
          imageGenerationModels: imagePlan.imageGenerationModels,
          imageGeneration: imagePlan.imageGeneration,
        }
      : null,
  };
}
