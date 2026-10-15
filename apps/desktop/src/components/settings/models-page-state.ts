/**
 * Pure planning for the models page: how the Minih Router row's binding list
 * changes when models are added, configured or removed from there, and what
 * app defaults must move with it.
 *
 * Pure on purpose: the same rules decide the app's chat and image defaults, so
 * they are unit-tested without mounting the page (the page only performs the
 * plan's I/O).
 */
import {
  bindingForCustomModel,
  type ImageGenerationBinding,
  type MinihRouterModel,
  type ModelBinding,
  type ProviderPublic,
} from "@minih-agent/shared";
import { keepsAppDefaultModel } from "./default-model.ts";
import { planImageGenerationDefaults } from "./image-generation-default.ts";

/** Case-insensitive wire-id equality, the way the rest of the app compares. */
function sameId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Seed a binding from a gateway plaza model: the gateway's own context window
 * is a real published number, everything else starts from the generic seed so
 * models.dev can still take over the limits it knows better.
 */
export function bindingFromRouterModel(model: MinihRouterModel): ModelBinding {
  const seed = bindingForCustomModel(model.id);
  if (model.contextWindow === null || model.contextWindow === undefined) return seed;
  return {
    ...seed,
    contextWindow: model.contextWindow,
    // The gateway published the number; it is not a models.dev value to track.
    contextWindowSource: "user",
  };
}

/** Append only models the row does not carry yet, preserving saved order. */
export function mergeAddedBindings(
  current: readonly ModelBinding[],
  added: readonly MinihRouterModel[],
): ModelBinding[] {
  const next = [...current];
  for (const model of added) {
    if (next.some((binding) => sameId(binding.id, model.id))) continue;
    next.push(bindingFromRouterModel(model));
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
 * - the app's chat default is kept while it still resolves, and claimed by the
 *   first binding only when nothing runnable is left — the same rule the
 *   service dialog applies after a provider save;
 * - image bindings naming a removed model are dropped with their default.
 */
export function planModelsSave(
  provider: ProviderPublic,
  nextBindings: readonly ModelBinding[],
  settings: ModelsPageSettingsDraft,
  providers: readonly ProviderPublic[],
): ModelsPageSavePlan {
  const savedRow: ProviderPublic = { ...provider, models: [...nextBindings] };
  const nextProviders = providers.map((row) => (row.id === provider.id ? savedRow : row));
  const firstModelId = nextBindings[0]?.id;
  const keepsDefault = keepsAppDefaultModel(
    nextProviders,
    settings.defaultProviderId,
    settings.defaultModelId,
  );
  const imageIds = (settings.imageGenerationModels ?? [])
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
