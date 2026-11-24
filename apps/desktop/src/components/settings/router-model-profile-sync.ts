/**
 * The gateway model profile, applied to the row it belongs to.
 *
 * A `minih-router` row's per-model configuration is maintained once, on the
 * gateway, and the row follows it field by field (see
 * `router-model-profile.ts` in `@minih-agent/shared`). The models page applies
 * it when it opens; this module applies it once at startup, so a profile the
 * operator changed reaches the app before the user opens Settings.
 *
 * Nothing here is a startup gate: a gateway that cannot be reached, refuses the
 * key or predates the profile simply leaves every row as it is, and no error
 * reaches the user.
 */
import {
  isMinihRouterVendorKey,
  mergeRouterModelProfileList,
  planRouterImageModelIds,
  type AppSettings,
  type ProviderPublic,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { planImageGenerationDefaults } from "./image-generation-default";
import { fetchMinihRouterCatalog } from "./useMinihRouter";

export type RouterProfileSyncInput = {
  providers: readonly ProviderPublic[];
  settings: AppSettings | null | undefined;
};

export type RouterProfileSyncResult = {
  /** True when at least one provider row was rewritten. */
  providersChanged: boolean;
  /** Settings to publish when the image designation moved; `null` otherwise. */
  settings: AppSettings | null;
};

const UNCHANGED: RouterProfileSyncResult = { providersChanged: false, settings: null };

/**
 * Bring every `minih-router` row in line with the gateway's model profile.
 *
 * Only bindings the row already carries are merged: opening the models page is
 * what mirrors the catalog, and a restart must never resurrect a model the user
 * removed. A write happens only when the merged result actually differs, so a
 * start with nothing to do makes no request beyond the catalog read.
 */
export async function syncRouterModelProfiles({
  providers,
  settings,
}: RouterProfileSyncInput): Promise<RouterProfileSyncResult> {
  if (!settings) return UNCHANGED;
  const rows = providers.filter(
    (provider) => isMinihRouterVendorKey(provider.vendorKey) && provider.hasSecret,
  );
  if (rows.length === 0) return UNCHANGED;

  let nextSettings = settings;
  let providersChanged = false;
  let settingsChanged = false;
  let knownProviders: ProviderPublic[] = [...providers];

  for (const row of rows) {
    let catalog;
    try {
      catalog = await fetchMinihRouterCatalog(row.id);
    } catch {
      // An unreachable or old gateway is not a failure to report: the row keeps
      // the configuration it was launched with.
      continue;
    }
    if (!catalog || catalog.length === 0) continue;

    const nextModels = mergeRouterModelProfileList(row.models, catalog);
    const upcomingModels = nextModels ?? row.models;
    const currentImageIds = (nextSettings.imageGenerationModels ?? [])
      .filter((entry) => entry.providerId === row.id)
      .map((entry) => entry.modelId);
    const nextImageIds = planRouterImageModelIds(currentImageIds, upcomingModels, catalog);

    if (nextModels) {
      await api.updateProvider({ id: row.id, models: nextModels });
      providersChanged = true;
      knownProviders = knownProviders.map((provider) =>
        provider.id === row.id ? { ...provider, models: nextModels } : provider,
      );
    }

    if (nextImageIds) {
      // The app default is re-planned with the row's new list, so a model that
      // just became the only runnable one still claims it, and a default that
      // still runs is left alone.
      const plan = planImageGenerationDefaults(
        {
          imageGenerationModels: nextSettings.imageGenerationModels,
          imageGeneration: nextSettings.imageGeneration,
        },
        row.id,
        nextImageIds,
        knownProviders,
      );
      nextSettings = {
        ...nextSettings,
        imageGenerationModels: plan.imageGenerationModels,
        imageGeneration: plan.imageGeneration,
      };
      settingsChanged = true;
    }
  }

  if (!providersChanged && !settingsChanged) return UNCHANGED;
  if (settingsChanged) await api.setSettings(nextSettings);
  return { providersChanged, settings: settingsChanged ? nextSettings : null };
}