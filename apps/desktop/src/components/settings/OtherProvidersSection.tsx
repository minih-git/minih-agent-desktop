/**
 * Every credential-bearing service that is not the Minih Router account card:
 * API services, plugin-declared services and vendor subscription accounts in
 * one list (D625), plus Jev and the import workbench.
 *
 * The section folds away by default: the accounts page leads with Minih
 * Router, and existing providers surface here — hidden only when the user has
 * none and developer mode is off, so an existing configuration can never
 * silently disappear.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelBinding, ProviderPublic } from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { IconPlus } from "../icons";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { providerServesChatModels } from "./default-model";
import { imageCandidates, chatModelOptions } from "./provider-list-helpers";
import { copyProviderConfiguration, type ProviderCopyDraft } from "./provider-copy";
import { OAuthLoginDialog } from "./OAuthLoginDialog";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { ServiceList } from "./ServiceList";
import { serviceRowKind } from "./service-row-status";
import { useVendorAccounts } from "./useVendorAccounts";
import { VendorAccountDialog, type VendorAccountForm } from "./VendorAccountDialog";
import { ModelConfigImportPanel } from "../../features/settings/imports/ModelConfigImportPanel";
import { ImportToggleButton } from "../../features/settings/import-workbench";
import { JevSettingsCard } from "./JevSettingsCard";
import { JEV_SERVICE } from "./service-catalog";
import { isPluginCatalogSetupForProvider } from "./provider-setup-mode";

const sameWireId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export type OtherProvidersSectionProps = {
  /** True when the section starts unfolded, e.g. existing rows are present. */
  defaultOpen?: boolean;
};

export function OtherProvidersSection({ defaultOpen = false }: OtherProvidersSectionProps) {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);

  // null = closed, "" = add flow, provider id = edit flow.
  const [copyDraft, setCopyDraft] = useState<ProviderCopyDraft | null>(null);
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [pluginCatalogSetup, setPluginCatalogSetup] = useState<{
    providerId: string;
    pluginName: string;
  } | null>(null);
  // The Jev card opens the same dialog, straight on the Jev service.
  const [jevSetup, setJevSetup] = useState(false);
  // Bumped when that dialog stored a key, so the card re-reads what exists.
  const [jevStatusRevision, setJevStatusRevision] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const {
    vendors,
    accountFor,
    login,
    busyAccountId,
    savingAccount,
    startLogin,
    finishLogin,
    closeLogin,
    removeAccount,
    saveAccount,
  } = useVendorAccounts();
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);

  if (!settings) return null;

  const editingProvider =
    setupFor ? providers.find((provider) => provider.id === setupFor) ?? null : null;
  const editingAccount = editingAccountId
    ? providers.find((provider) => provider.id === editingAccountId) ?? null
    : null;
  const imageGenerationCandidates = imageCandidates(
    settings.imageGenerationModels,
    settings.imageGeneration,
    providers,
  );

  /**
   * Preserve the selected app defaults unless they were removed from the
   * provider or no longer resolve, and let a newly added provider claim a
   * default only while none resolves.
   */
  const afterSaved = async (saved: ProviderPublic, models: ModelBinding[]) => {
    const selectedImageIds = imageGenerationCandidates
      .filter((entry) => entry.providerId === saved.id)
      .map((entry) => entry.modelId);
    const firstModelId = models.find((model) =>
      !selectedImageIds.some((id) => sameWireId(id, model.id)),
    )?.id;
    // Editing away the model the app default names leaves the default pointing
    // at a model this row no longer serves: the first remaining chat model
    // takes its place, so the next session does not fail on a stale id.
    const replacementChatModelId =
      settings.defaultProviderId === saved.id && firstModelId &&
      !models.some((model) => sameWireId(model.id, settings.defaultModelId ?? "") &&
        !selectedImageIds.some((id) => sameWireId(id, model.id)))
    ? firstModelId
    : undefined;
    try {
      if (pluginCatalogSetup?.providerId === saved.id) {
        const defaultsProviders = [...providers.filter((provider) => provider.id !== saved.id), saved];
        const currentDefault = defaultsProviders.find(
          (provider) => provider.id === settings.defaultProviderId,
        );
        const keepsCurrentDefault = !!currentDefault &&
          providerServesChatModels(currentDefault, imageGenerationCandidates) &&
          chatModelOptions([currentDefault], imageGenerationCandidates).some(
            ({ modelId }) => sameWireId(modelId, settings.defaultModelId ?? ""),
          );
        if (!keepsCurrentDefault && firstModelId) {
          const nextSettings = {
            ...settings,
            defaultProviderId: saved.id,
            defaultModelId: firstModelId,
          };
          await api.setSettings(nextSettings);
          useAppStore.setState({ settings: nextSettings });
        }
        showToast(t("settings.pluginProviderKeySaved"), { variant: "success" });
      } else if (!editingProvider) {
        // A freshly added provider must not take over the app default: whatever
        // the user already picked keeps running — as long as that default's own
        // provider is still runnable — until they change it themselves.
        const currentProvider = providers.find(
          (provider) => provider.id === settings.defaultProviderId,
        );
        const keepsCurrentDefault = !!currentProvider &&
          providerServesChatModels(currentProvider, imageGenerationCandidates) &&
          chatModelOptions([currentProvider], imageGenerationCandidates).some(
            ({ modelId }) => sameWireId(modelId, settings.defaultModelId ?? ""),
          );
        if (!keepsCurrentDefault && firstModelId) {
          await api.setSettings({
            ...settings,
            defaultProviderId: saved.id,
            defaultModelId: firstModelId ?? "",
          });
        }
        showToast(t("settings.providerSaved"), { variant: "success" });
      } else {
        if (replacementChatModelId) {
          const nextSettings = { ...settings, defaultModelId: replacementChatModelId };
          await api.setSettings(nextSettings);
          useAppStore.setState({ settings: nextSettings });
        }
        showToast(t("settings.providerUpdated"), { variant: "success" });
      }
      setSetupFor(null);
      setCopyDraft(null);
      setPluginCatalogSetup(null);
      setJevSetup(false);
      await refreshProviders();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const toggleEnabled = async (provider: ProviderPublic) => {
    setBusyId(provider.id);
    try {
      await api.updateProvider({ id: provider.id, enabled: !provider.enabled });
      await refreshProviders();
      showToast(
        t(provider.enabled ? "settings.providerDisabled" : "settings.providerEnabled"),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const removeProvider = async (provider: ProviderPublic) => {
    setBusyId(provider.id);
    try {
      await api.deleteProvider(provider.id);
      await refreshProviders();
      showToast(t("settings.providerRemoved"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  /** Resolves true once the key is stored, so the row can close its entry. */
  const saveProviderKey = async (provider: ProviderPublic, value: string) => {
    setBusyId(provider.id);
    try {
      await api.setProviderSecret({ id: provider.id, secretValue: value });
      await refreshProviders();
      showToast(
        t(value.trim() ? "settings.pluginProviderKeySaved" : "settings.pluginProviderKeyRemoved"),
        { variant: "success" },
      );
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const saveEditingAccount = async (provider: ProviderPublic, form: VendorAccountForm) => {
    if (await saveAccount(provider, form)) setEditingAccountId(null);
  };

  const testProvider = async (provider: ProviderPublic) => {
    setTestingId(provider.id);
    try {
      const result = (await api.testProvider(provider.id)) as {
        ok?: boolean;
        message?: string;
        status?: number;
      };
      if (result?.ok) {
        showToast(t("settings.testOk"), { variant: "success" });
      } else {
        showToast(
          result?.message ||
            (result?.status
              ? t("settings.testFailedStatus", { status: result.status })
              : t("settings.testFailed")),
          { variant: "error" },
        );
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <section className="settings-card-block other-providers-section">
      <SettingsDisclosure
        open={defaultOpen}
        title={t("settings.otherProvidersTitle")}
      >
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.providers")}</h3>
            {providers.length > 0 ? (
              <span className="provider-section-count">{providers.length}</span>
            ) : null}
          </div>
          <div className="provider-section-head-actions">
            <ImportToggleButton
              open={importOpen}
              controls="model-config-import-panel"
              label={t("settings.importTitle")}
              onClick={() => setImportOpen((current) => !current)}
            />
            <Button
              variant="primary"
              className="model-provider-add"
              onClick={() => setSetupFor("")}
            >
              <span className="model-config-btn-inner">
                <IconPlus size={14} />
                <span>{t("settings.addProvider")}</span>
              </span>
            </Button>
          </div>
        </div>

        <div
          id="model-config-import-panel"
          className="import-inline-workbench"
          hidden={!importOpen}
        >
          <ModelConfigImportPanel />
        </div>

        <div className="settings-panel model-provider-panel">
          {providers.length === 0 ? (
            <div className="model-provider-empty">
              <div className="model-provider-empty-title">
                {t("settings.noProviders")}
              </div>
              <div className="model-provider-empty-actions">
                <Button variant="secondary" onClick={() => setSetupFor("")}>
                  <span className="model-config-btn-inner">
                    <span>{t("settings.addProvider")}</span>
                  </span>
                </Button>
              </div>
            </div>
          ) : (
            <ServiceList
              providers={providers}
              accountFor={accountFor}
              busy={
                busyId !== null ||
                testingId !== null ||
                setupFor !== null ||
                editingAccountId !== null ||
                busyAccountId !== null ||
                savingAccount ||
                login !== null
              }
              isRowBusy={(id) => busyId === id || testingId === id || busyAccountId === id}
              testingId={testingId}
              onEdit={(provider) =>
                serviceRowKind(provider) === "account"
                  ? setEditingAccountId(provider.id)
                  : setSetupFor(provider.id)
              }
              onTest={(provider) => void testProvider(provider)}
              onCopy={(provider) => {
                setCopyDraft(
                  copyProviderConfiguration(
                    provider,
                    t("settings.copyProviderName", { name: provider.name }),
                  ),
                );
                setSetupFor("");
              }}
              onToggleEnabled={(provider) => void toggleEnabled(provider)}
              onRemove={(provider) =>
                void (serviceRowKind(provider) === "account"
                  ? removeAccount(provider)
                  : removeProvider(provider))
              }
              onSaveKey={saveProviderKey}
            />
          )}
        </div>

        <JevSettingsCard
          settings={settings}
          onConfigure={() => {
            setJevSetup(true);
            setSetupFor("");
          }}
          statusRevision={jevStatusRevision}
        />
      </SettingsDisclosure>

      {setupFor !== null ? (
        <ProviderSetupDialog
          key={setupFor}
          provider={editingProvider}
          pluginCatalogSetup={isPluginCatalogSetupForProvider(
            pluginCatalogSetup,
            editingProvider,
          )}
          pluginCatalogPluginName={pluginCatalogSetup?.pluginName}
          initialDraft={copyDraft}
          initialService={jevSetup ? JEV_SERVICE : undefined}
          onClose={() => {
            setSetupFor(null);
            setCopyDraft(null);
            setPluginCatalogSetup(null);
            setJevSetup(false);
          }}
          onSaved={afterSaved}
          onJevConfigured={() => {
            setSetupFor(null);
            setCopyDraft(null);
            setJevSetup(false);
            // The card is already mounted: tell it the key it read has changed.
            setJevStatusRevision((revision) => revision + 1);
          }}
          vendors={vendors}
          onPickSubscription={(vendor) => {
            setSetupFor(null);
            setCopyDraft(null);
            setPluginCatalogSetup(null);
            // Started here, not in the dialog: a click happens once, where
            // StrictMode would run a mount effect twice and open two browsers.
            startLogin(vendor);
          }}
          onPickPluginProvider={(providerId, pluginName) => {
            setPluginCatalogSetup({ providerId, pluginName });
            setCopyDraft(null);
            setJevSetup(false);
            setSetupFor(providerId);
          }}
        />
      ) : null}

      {editingAccount ? (
        <VendorAccountDialog
          provider={editingAccount}
          initialName={
            accountFor(editingAccount.id)?.account.accountLabel ||
            editingAccount.oauthAccountLabel ||
            editingAccount.name
          }
          saving={savingAccount}
          onClose={() => setEditingAccountId(null)}
          onSave={(form) => void saveEditingAccount(editingAccount, form)}
        />
      ) : null}

      {login ? (
        <OAuthLoginDialog
          vendor={login.vendor}
          session={login.session}
          onDone={finishLogin}
          onClose={closeLogin}
        />
      ) : null}
    </section>
  );
}
