/**
 * The models settings page: the Minih Router row's chosen models as cards, an
 * add-models dialog over the gateway catalog, per-model configuration (the
 * shared binding editor, including the per-model protocol override), the
 * image-generation default, the model a session the Agent creates for itself
 * runs on, and the models.dev enrichment snapshot status.
 *
 * Accounts — the token, endpoint, balance and the other providers — live on
 * the accounts page; this page only reads the connected router row.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isMinihRouterVendorKey,
  modelWireIdsEqual,
  publishedThinkingLevels,
  sortThinkingLevels,
  type ImageGenerationBinding,
  type ModelBinding,
  type ModelInfo,
  type SessionCreateModelBinding,
} from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Badge, Button } from "../ui";
import { IconConfig, IconPlus, IconServer } from "../icons";
import {
  MINIH_ROUTER_API_STYLES,
  API_STYLE_LABEL_KEYS,
} from "./provider-api-style";
import { ModelBindingFields } from "./ModelBindingFields";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { AddModelsDialog } from "./AddModelsDialog";
import { ModelConfigureDialog } from "./ModelConfigureDialog";
import { MinihRouterModelCard } from "./MinihRouterModelCard";
import { groupModelsByVendor, inferModelVendor } from "./minih-router-format";
import { ImageGenerationModelRow } from "./ImageGenerationModelRow";
import {
  SessionCreateModelRow,
  sessionCreateModelCandidates,
} from "./SessionCreateModelRow";
import {
  bindingAfterRemoval,
  mergeAddedBindings,
  planModelsSave,
} from "./models-page-state";
import {
  customModelLookupInput,
} from "./model-custom-lookup";
import {
  imageGenerationPickerCandidates,
  isImageGenerationPickerCandidate,
} from "./image-generation-default";
import { imageCandidates } from "./provider-list-helpers";
import { useMinihRouterSelectedModels } from "./useMinihRouter";

type CatalogStatus = {
  loaded: boolean;
  source: "bundled" | "remote" | "empty";
  catalogPath: string;
  fetchedAt?: string;
  providerCount: number;
  modelCount: number;
  lastError?: string;
};

export function ModelsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  const [revision, setRevision] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The binding whose configure drawer is open, by wire id. */
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  /** Draft edits while a drawer is open; saved as one list write. */
  const [draftBindings, setDraftBindings] = useState<ModelBinding[] | null>(null);
  /** Published models.dev record per chosen wire id, for display and seeding. */
  const [publishedInfoById, setPublishedInfoById] = useState<Map<string, ModelInfo>>(new Map());
  /**
   * Image-model selection drafted in the configure dialog; `null` means the
   * stored selection stands and the write plans no change of its own.
   */
  const [draftImageIds, setDraftImageIds] = useState<string[] | null>(null);
  const [changingImageModel, setChangingImageModel] = useState(false);
  const [changingSessionCreateModel, setChangingSessionCreateModel] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.modelCatalogStatus();
        setCatalogStatus(result.status);
      } catch {
        // The status line simply stays hidden when the catalog cannot report.
        setCatalogStatus(null);
      }
    })();
  }, []);

  const routerProvider = useMemo(
    () =>
      providers.find(
        (provider) => isMinihRouterVendorKey(provider.vendorKey) && provider.hasSecret,
      ) ?? null,
    [providers],
  );

  const chosenIds = useMemo(
    () => routerProvider?.models.map((model) => model.id) ?? [],
    [routerProvider?.models],
  );
  // The published record behind each chosen model: what the configure dialog
  // shows (published limits, capability defaults, thinking ladder) and what a
  // freshly added binding is seeded from. One read per id per revision.
  useEffect(() => {
    if (!routerProvider || chosenIds.length === 0) return;
    let current = true;
    const context = {
      providerId: routerProvider.id,
      vendorKey: routerProvider.vendorKey,
      baseUrl: routerProvider.baseUrl,
    };
    void Promise.all(
      chosenIds.map((id) =>
        api.lookupProviderModel(customModelLookupInput(id, context))
          .then((result) => [id.toLowerCase(), result.info] as const)
          .catch(() => [id.toLowerCase(), null] as const),
      ),
    ).then((entries) => {
      if (!current) return;
      setPublishedInfoById(
        new Map(entries.filter(([, info]) => info != null) as [string, ModelInfo][]),
      );
    });
    return () => {
      current = false;
    };
  }, [routerProvider, chosenIds, revision]);

  const selected = useMinihRouterSelectedModels(routerProvider, chosenIds, revision);

  /** The image-model ids this row designates today. */
  const currentImageIds = useMemo(
    () =>
      (settings?.imageGenerationModels ?? [])
        .filter((binding) => binding.providerId === routerProvider?.id)
        .map((binding) => binding.modelId),
    [settings?.imageGenerationModels, routerProvider?.id],
  );

  const imageGenerationCandidates = useMemo(
    () => imageCandidates(
      settings?.imageGenerationModels,
      settings?.imageGeneration,
      providers,
    ),
    [settings?.imageGenerationModels, settings?.imageGeneration, providers],
  );

  const sessionCreateCandidates = useMemo(
    () => sessionCreateModelCandidates(settings, providers),
    [settings, providers],
  );

  if (!settings) return null;

  const isDefaultModel = (binding: ModelBinding) =>
    settings.defaultProviderId === routerProvider?.id &&
    (settings.defaultModelId ?? "").toLowerCase() === binding.id.toLowerCase();

  /**
   * One write path for every models-page save.
   *
   * `persistBindings` is false for a save that changed only the image-model
   * designation: the row already stores the list as rendered, and rewriting it
   * would move the row's own default model for a change the user never made.
   */
  const saveBindings = async (
    nextBindings: ModelBinding[],
    successKey: string,
    imageModelIds?: readonly string[],
    persistBindings = true,
  ) => {
    if (!routerProvider) return;
    setSaving(true);
    try {
      // Re-read settings: another window or agent may have moved defaults.
      const current = await api.getSettings();
      const plan = planModelsSave(routerProvider, nextBindings, current, providers, imageModelIds);
      if (persistBindings) await api.updateProvider(plan.provider);
      if (plan.settings) {
        const nextSettings = { ...current, ...plan.settings };
        await api.setSettings(nextSettings);
        useAppStore.setState({ settings: nextSettings });
      }
      await refreshProviders();
      setRevision((value) => value + 1);
      showToast(t(successKey), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const addModels = async (models: Parameters<typeof mergeAddedBindings>[1]) => {
    if (!routerProvider) return;
    setAddOpen(false);
    // The same auto-configuration the service dialog applied: the published
    // record seeds limits, thinking and capabilities when models.dev describes
    // the id, so a freshly added model is usable without manual tuning.
    const context = {
      providerId: routerProvider.id,
      vendorKey: routerProvider.vendorKey,
      baseUrl: routerProvider.baseUrl,
    };
    const entries = await Promise.all(
      models.map(async (model) => {
        try {
          const result = await api.lookupProviderModel(
            customModelLookupInput(model.id, context),
          );
          return [model.id.toLowerCase(), result.info ?? null] as const;
        } catch {
          return [model.id.toLowerCase(), null] as const;
        }
      }),
    );
    const infoById = new Map(entries);
    setPublishedInfoById((current) => {
      const next = new Map(current);
      for (const [id, info] of entries) if (info) next.set(id, info);
      return next;
    });
    await saveBindings(
      mergeAddedBindings(routerProvider.models, models, (model) =>
        infoById.get(model.id.toLowerCase()),
      ),
      "settings.modelsAddedToast",
    );
  };

  /** The row's global protocol: what every per-model "follow global" reads. */
  const setGlobalApiStyle = async (style: string) => {
    if (!routerProvider) return;
    setSaving(true);
    try {
      await api.updateProvider({ id: routerProvider.id, apiStyle: style });
      await refreshProviders();
      showToast(t("settings.providerUpdated"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async (binding: ModelBinding) => {
    if (!routerProvider) return;
    if (configuringId === binding.id) setConfiguringId(null);
    await saveBindings(
      bindingAfterRemoval(routerProvider.models, binding.id),
      "settings.modelRemovedToast",
    );
  };

  const updateBinding = (id: string, patch: Partial<ModelBinding>) => {
    // Local draft only; the drawer's Save writes the whole list once.
    setDraftBindings((current) =>
      (current ?? routerProvider?.models ?? []).map((binding) =>
        binding.id === id ? { ...binding, ...patch } : binding,
      ),
    );
  };

  const effectiveBindings = draftBindings ?? routerProvider?.models ?? [];
  /** The published thinking ladder for one chosen id, in canonical order. */
  const publishedLevelsFor = (id: string) =>
    sortThinkingLevels(
      publishedThinkingLevels(publishedInfoById.get(id.toLowerCase()) ?? undefined),
    );
  const configuredBinding = configuringId
    ? effectiveBindings.find(
        (binding) => binding.id.toLowerCase() === configuringId.toLowerCase(),
      ) ?? null
    : null;

  /**
   * The configure dialog's Save.
   *
   * The image-model designation is part of this dialog but not a field of the
   * binding, so toggling only that checkbox leaves `draftBindings` null. Reading
   * that as "nothing to save" closed the dialog without writing anything and
   * without a word, so a model the user had just marked stayed unconfigured and
   * every later GenerateImages answered IMAGE_NOT_CONFIGURED.
   */
  const saveConfigured = async () => {
    const imageModelIds = draftImageIds ?? undefined;
    const edited = draftBindings === null ? null : configuredBinding;
    if (!configuredBinding || (edited === null && imageModelIds === undefined)) {
      setConfiguringId(null);
      setDraftBindings(null);
      setDraftImageIds(null);
      return;
    }
    const nextBindings = edited
      ? (routerProvider?.models ?? []).map((binding) =>
          binding.id === edited.id ? edited : binding,
        )
      : routerProvider?.models ?? [];
    setConfiguringId(null);
    setDraftBindings(null);
    setDraftImageIds(null);
    // A save that carried no binding edit leaves the row exactly as stored: the
    // designation is a settings write, so the provider must not be rewritten
    // for it (that would also move the row's own default model).
    await saveBindings(
      nextBindings,
      "settings.modelConfiguredToast",
      imageModelIds,
      edited !== null,
    );
  };

  const setImageGenerationDefault = async (binding: ImageGenerationBinding) => {
    setChangingImageModel(true);
    try {
      const current = await api.getSettings();
      // Exactly the list the picker row offered, so a choice the user could
      // make is always one this page accepts — including the image model of a
      // signed-in vendor account, which is never stored as a chat model.
      const candidates = imageGenerationPickerCandidates(
        current.imageGenerationModels,
        current.imageGeneration,
        providers,
      );
      if (!isImageGenerationPickerCandidate(candidates, binding.providerId, binding.modelId)) {
        // The row offered this binding when it rendered, but the read above no
        // longer lists it: another window, another agent or a concurrent
        // provider edit changed the candidates in between. Report the refusal
        // instead of silently keeping the previous default.
        showToast(t("settings.imageModelSaveFailed"), { variant: "error" });
        return;
      }
      const nextSettings = { ...current, imageGeneration: binding };
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });
      showToast(t("settings.imageModelSelected"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setChangingImageModel(false);
    }
  };

  /**
   * The model a session the Agent creates for itself runs on.
   *
   * `null` is a real choice: it turns the built-in `SessionCreate` tool off, so
   * the write is never rejected for being empty — only for naming a pairing the
   * picker no longer offers.
   */
  const setSessionCreateModel = async (binding: SessionCreateModelBinding | null) => {
    setChangingSessionCreateModel(true);
    try {
      const current = await api.getSettings();
      // Exactly the list the row offered, so a choice the user could make is
      // always one this page accepts.
      const candidates = sessionCreateModelCandidates(current, providers);
      if (
        binding &&
        !candidates.some((candidate) =>
          candidate.provider.id === binding.providerId &&
          modelWireIdsEqual(candidate.modelId, binding.modelId),
        )
      ) {
        // The row offered this pairing when it rendered, but the read above no
        // longer lists it: another window or a concurrent provider edit changed
        // the candidates in between. Report the refusal instead of storing a
        // model the runtime cannot launch.
        showToast(t("settings.sessionCreateModelSaveFailed"), { variant: "error" });
        return;
      }
      const nextSettings = { ...current, sessionCreateModel: binding };
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });
      showToast(t("settings.sessionCreateModelSelected"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setChangingSessionCreateModel(false);
    }
  };

  const refreshCatalog = async () => {
    setRefreshingCatalog(true);
    try {
      const result = await api.refreshModelCatalog();
      setCatalogStatus(result.status);
      await refreshProviders();
      if (result.refreshed) {
        showToast(t("settings.modelCatalogUpdated"), { variant: "success" });
      } else {
        showToast(result.status.lastError || t("settings.modelCatalogUpdateFailed"), {
          variant: "error",
        });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setRefreshingCatalog(false);
    }
  };

  const catalogSourceLabel = catalogStatus
    ? t(
        catalogStatus.source === "remote"
          ? "settings.catalogSourceRemote"
          : catalogStatus.source === "bundled"
            ? "settings.catalogSourceBundled"
            : "settings.catalogSourceEmpty",
      )
    : "";

  const modelApiStyleOptions = MINIH_ROUTER_API_STYLES.map((style) => ({
    id: style,
    label: t(API_STYLE_LABEL_KEYS[style]),
  }));

  return (
    <div className="settings-stack models-page">
      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.modelsPageTitle")}</h3>
            {chosenIds.length > 0 ? (
              <span className="provider-section-count">{chosenIds.length}</span>
            ) : null}
          </div>
          <div className="provider-section-head-actions">
            <Button
              variant="primary"
              className="model-provider-add"
              disabled={!routerProvider || saving}
              onClick={() => setAddOpen(true)}
            >
              <span className="model-config-btn-inner">
                <IconPlus size={14} />
                <span>{t("settings.addModelsTitle")}</span>
              </span>
            </Button>
          </div>
        </div>

        {routerProvider ? (
          <div className="settings-row model-default-row models-global-style-row">
            <div className="settings-row-copy model-default-copy">
              <div className="settings-row-title model-default-label">
                {t("settings.apiStyle")}
              </div>
              <div className="settings-row-detail model-default-value">
                {t("settings.minihRouterApiStyleHint")}
              </div>
            </div>
            <SettingsMenuSelect
              className="models-global-style-select"
              label={t("settings.apiStyle")}
              value={routerProvider.apiStyle ?? "chat_completions"}
              disabled={saving}
              onChange={(id) => void setGlobalApiStyle(id)}
              options={modelApiStyleOptions.map((style) => ({ ...style }))}
            />
          </div>
        ) : null}

        <div className="settings-panel model-provider-panel">
          {!routerProvider ? (
            <div className="model-provider-empty">
              <div className="model-provider-empty-icon" aria-hidden>
                <IconServer size={18} />
              </div>
              <div className="model-provider-empty-title">
                {t("settings.modelsNoAccountTitle")}
              </div>
              <div className="model-provider-empty-desc">
                {t("settings.modelsNoAccountDesc")}
              </div>
              <div className="model-provider-empty-actions">
                <Button variant="primary" onClick={() => setSettingsTab("accounts")}>
                  <span className="model-config-btn-inner">
                    <span>{t("settings.modelsGoToAccounts")}</span>
                  </span>
                </Button>
              </div>
            </div>
          ) : chosenIds.length === 0 ? (
            <div className="model-provider-empty">
              <div className="model-provider-empty-title">
                {t("settings.modelsEmptyTitle")}
              </div>
              <div className="model-provider-empty-desc">
                {t("settings.modelsEmptyDesc")}
              </div>
              <div className="model-provider-empty-actions">
                <Button variant="primary" onClick={() => setAddOpen(true)}>
                  <span className="model-config-btn-inner">
                    <IconPlus size={14} />
                    <span>{t("settings.addModelsTitle")}</span>
                  </span>
                </Button>
              </div>
            </div>
          ) : (
            <>
              {selected.state === "loading" && selected.data.length === 0 ? (
                <p className="minih-router-status">{t("settings.minihRouterLoading")}</p>
              ) : null}
              <div className="models-vendor-groups" data-model-section="chosen">
                {groupModelsByVendor(
                  routerProvider.models.map((binding) => {
                    const plaza = selected.data.find(
                      (entry) => entry.model.id.toLowerCase() === binding.id.toLowerCase(),
                    );
                    const model = plaza?.model ?? {
                      id: binding.id,
                      upstreamIds: [],
                      vendor: inferModelVendor({ id: binding.id }),
                      category: "chat" as const,
                      protocols: [],
                      price: { input: null, output: null, cacheRead: null, cacheWrite: null },
                      multiplePrices: false,
                      tieredPricing: false,
                      contextWindow:
                        binding.contextWindow && binding.contextWindow > 0
                          ? binding.contextWindow
                          : null,
                      maxOutput:
                        binding.maxTokens && binding.maxTokens > 0 ? binding.maxTokens : null,
                    };
                    return {
                      binding,
                      model,
                      priced: plaza ? plaza.priced : false,
                    };
                  }),
                  (entry) => entry.model,
                  t("settings.minihRouterVendorOther"),
                ).map((group) => (
                  <section
                    key={group.key}
                    className="models-vendor-group"
                    data-vendor-group={group.key}
                  >
                    <div className="models-vendor-group-head">
                      <h4 className="models-vendor-group-title">{group.label}</h4>
                      <span className="models-vendor-group-count">{group.items.length}</span>
                    </div>
                    <ul className="minih-router-model-grid models-chosen-grid">
                      {group.items.map(({ binding, model, priced }) => (
                        <li
                          key={binding.id}
                          className="models-chosen-card"
                          data-model-id={binding.id}
                        >
                          <MinihRouterModelCard
                            model={model}
                            locale={locale}
                            unpricedLabel={
                              priced ? undefined : t("settings.minihRouterSelectedUnpriced")
                            }
                          />
                          <div className="models-chosen-card-actions">
                            <span className="models-chosen-card-status">
                              {isDefaultModel(binding) ? (
                                <Badge tone="success">{t("settings.modelsDefaultBadge")}</Badge>
                              ) : null}
                            </span>
                            <div className="models-chosen-card-buttons">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setDraftBindings(null);
                                  setConfiguringId(binding.id);
                                }}
                              >
                                {t("settings.modelsConfigure")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={saving}
                                onClick={() => void removeModel(binding)}
                              >
                                {t("settings.removeModel")}
                              </Button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {imageGenerationCandidates.length > 0 ? (
        <section className="settings-card-block">
          <div className="settings-panel model-default-panel">
            <ImageGenerationModelRow
              settings={settings}
              providers={providers}
              busy={changingImageModel}
              onChange={setImageGenerationDefault}
            />
          </div>
        </section>
      ) : null}

      {sessionCreateCandidates.length > 0 ? (
        <section className="settings-card-block">
          <div className="settings-panel model-default-panel">
            <SessionCreateModelRow
              settings={settings}
              providers={providers}
              busy={changingSessionCreateModel}
              onChange={setSessionCreateModel}
            />
          </div>
        </section>
      ) : null}

      <div className="model-catalog-status">
        <span className="model-catalog-status-text">
          {catalogStatus
            ? t("settings.catalogStatusLine", {
                source: catalogSourceLabel,
                models: catalogStatus.modelCount,
                fetchedAt: catalogStatus.fetchedAt
                  ? new Date(catalogStatus.fetchedAt).toLocaleString(locale)
                  : t("settings.catalogNeverFetched"),
              })
            : t("settings.catalogStatusUnknown")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshingCatalog}
          onClick={() => void refreshCatalog()}
        >
          <span className="model-config-btn-inner">
            <IconConfig size={13} />
            <span>
              {refreshingCatalog
                ? t("settings.refreshingModelCatalog")
                : t("settings.refreshModelCatalog")}
            </span>
          </span>
        </Button>
      </div>

      {configuredBinding && routerProvider ? (
        <ModelConfigureDialog
          binding={configuredBinding}
          info={publishedInfoById.get(configuredBinding.id.toLowerCase())}
          publishedLevels={publishedLevelsFor(configuredBinding.id)}
          saving={saving}
          imageModelSelected={(draftImageIds ?? currentImageIds).some((id) =>
            id.toLowerCase() === configuredBinding.id.toLowerCase(),
          )}
          onImageModelChange={(id, selected) =>
            setDraftImageIds((current) => {
              const base = current ?? currentImageIds;
              return selected
                ? base.some((entry) => entry.toLowerCase() === id.toLowerCase())
                  ? base
                  : [...base, id]
                : base.filter((entry) => entry.toLowerCase() !== id.toLowerCase());
            })
          }
          apiStyleOptions={modelApiStyleOptions}
          globalApiStyle={routerProvider.apiStyle ?? "chat_completions"}
          onClose={() => {
            setConfiguringId(null);
            setDraftBindings(null);
            setDraftImageIds(null);
          }}
          onSave={() => void saveConfigured()}
          onChange={(patch) => updateBinding(configuredBinding.id, patch)}
        />
      ) : null}

      {addOpen && routerProvider ? (
        <AddModelsDialog
          providerId={routerProvider.id}
          configuredIds={chosenIds}
          busy={saving}
          onClose={() => setAddOpen(false)}
          onConfirm={(models) => void addModels(models)}
        />
      ) : null}
    </div>
  );
}
