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
 *
 * State is read through the injected getters, *after* every await. A settings
 * write replaces the whole record and a provider write replaces the whole model
 * list, so merging into a snapshot taken before the network call would silently
 * undo whatever the user (or another window) changed while it was in flight.
 */
import {
  isMinihRouterVendorKey,
  mergeRouterModelProfileList,
  planRouterImageModelIds,
  type AppSettings,
  type MinihRouterModel,
  type ModelBinding,
  type ProviderPublic,
} from "@minih-agent/shared";
import { planImageGenerationDefaults } from "./image-generation-default.ts";

export type RouterProfileSyncDeps = {
  /** The provider rows as they are now. */
  readProviders: () => readonly ProviderPublic[];
  /** The app settings as they are now. */
  readSettings: () => AppSettings | null | undefined;
  /** One full read of the gateway catalog for a row; `null` means cancelled. */
  fetchCatalog: (providerId: string) => Promise<MinihRouterModel[] | null>;
  /** Persist one row's model list. */
  updateProvider: (input: { id: string; models: ModelBinding[] }) => Promise<unknown>;
  /** Persist the whole settings record. */
  setSettings: (settings: AppSettings) => Promise<unknown>;
};

export type RouterProfileSyncResult = {
  /** True when at least one provider row was rewritten. */
  providersChanged: boolean;
  /** True when the image-generation settings were rewritten. */
  settingsChanged: boolean;
};

const UNCHANGED: RouterProfileSyncResult = { providersChanged: false, settingsChanged: false };

/**
 * Bring every `minih-router` row in line with the gateway's model profile.
 *
 * Only bindings the row already carries are merged: opening the models page is
 * what mirrors the catalog, and a restart must never resurrect a model the user
 * removed. A write happens only when the merged result actually differs, so a
 * start with nothing to do makes no request beyond the catalog read.
 */
export async function syncRouterModelProfiles(
  deps: RouterProfileSyncDeps,
): Promise<RouterProfileSyncResult> {
  if (!deps.readSettings()) return UNCHANGED;
  const rows = deps.readProviders().filter(
    (provider) => isMinihRouterVendorKey(provider.vendorKey) && provider.hasSecret,
  );
  if (rows.length === 0) return UNCHANGED;

  let providersChanged = false;
  let settingsChanged = false;
  /** Model lists this run wrote, so availability checks see them before the store refreshes. */
  const writtenModels = new Map<string, ModelBinding[]>();
  const providersNow = (): readonly ProviderPublic[] =>
    deps.readProviders().map((provider) => {
      const models = writtenModels.get(provider.id);
      return models ? { ...provider, models } : provider;
    });

  for (const { id: providerId } of rows) {
    let catalog;
    try {
      catalog = await deps.fetchCatalog(providerId);
    } catch {
      // An unreachable or old gateway is not a failure to report: the row keeps
      // the configuration it was launched with.
      continue;
    }
    if (!catalog || catalog.length === 0) continue;

    // Re-read after the network hop: the row may have been edited meanwhile.
    const row = deps.readProviders().find((provider) => provider.id === providerId);
    if (!row) continue;
    const nextModels = mergeRouterModelProfileList(row.models, catalog);
    const upcomingModels = nextModels ?? row.models;
    const settingsBeforeImage = deps.readSettings();
    if (!settingsBeforeImage) continue;
    const currentImageIds = (settingsBeforeImage.imageGenerationModels ?? [])
      .filter((entry) => entry.providerId === row.id)
      .map((entry) => entry.modelId);
    const nextImageIds = planRouterImageModelIds(currentImageIds, upcomingModels, catalog);
    if (!nextModels && !nextImageIds) continue;

    if (nextModels) {
      await deps.updateProvider({ id: row.id, models: nextModels });
      writtenModels.set(row.id, nextModels);
      providersChanged = true;
    }

    if (nextImageIds) {
      // Only the two image fields are written, onto the settings as they are
      // right now: this record is replaced wholesale, so anything read earlier
      // would take the user's newer choices with it.
      const latest = deps.readSettings();
      if (!latest) continue;
      const plan = planImageGenerationDefaults(
        {
          imageGenerationModels: latest.imageGenerationModels,
          imageGeneration: latest.imageGeneration,
        },
        row.id,
        nextImageIds,
        providersNow(),
      );
      await deps.setSettings({
        ...latest,
        imageGenerationModels: plan.imageGenerationModels,
        imageGeneration: plan.imageGeneration,
      });
      settingsChanged = true;
    }
  }

  return { providersChanged, settingsChanged };
}