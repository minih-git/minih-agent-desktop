/**
 * The accounts settings page: the Minih Router account first — one token
 * connects it, no models required — then the other providers folded away.
 *
 * Initialization is deliberately one field: paste a token, connect, and the
 * models page offers the gateway's catalog. The endpoint defaults to the
 * published one and only shows its input when the user asks for it.
 */
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MINIH_ROUTER_DEFAULT_BASE_URL,
  MINIH_ROUTER_NAME,
  minihRouterApiBaseUrl,
  isMinihRouterVendorKey,
} from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Badge, Button, Field, Input, PasswordInput } from "../ui";
import { IconRefresh } from "../icons";
import { endpointLabel } from "./service-catalog";
import { EasyTierLanSection } from "./EasyTierLanSection";
import { MinihRouterAccountSummary } from "./MinihRouterAccountSummary";
import { OtherProvidersSection } from "./OtherProvidersSection";
import { useMinihRouterAccount } from "./useMinihRouter";

export function AccountsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const headingId = useId();
  const [revision, setRevision] = useState(0);

  // The saved router row this page owns; several rows cannot all be "the"
  // account, so the first credentialed one wins.
  const routerProvider =
    providers.find(
      (provider) => isMinihRouterVendorKey(provider.vendorKey) && provider.hasSecret,
    ) ?? null;

  const account = useMinihRouterAccount(routerProvider?.id ?? null, revision);
  const refreshing = account.state === "loading";

  // The service list is legacy surface: a normal profile sees the account card
  // only, and developer mode brings the other providers back.
  const developerMode = settings?.developerMode === true;

  return (
    <div className="settings-stack accounts-page">
      <section className="settings-card-block minih-router-panel" aria-labelledby={headingId}>
        <div className="minih-router-head">
          <div className="minih-router-head-copy">
            <h3 id={headingId} className="settings-card-heading">{MINIH_ROUTER_NAME}</h3>
            <span className="minih-router-head-detail">
              {routerProvider
                ? endpointLabel(routerProvider.baseUrl ?? MINIH_ROUTER_DEFAULT_BASE_URL)
                : t("settings.accountsConnectDesc")}
            </span>
          </div>
          {routerProvider ? (
            <div className="minih-router-head-actions">
              {routerProvider.enabled ? (
                <Badge tone="success">{t("settings.accountsConnected")}</Badge>
              ) : (
                <Badge>{t("settings.providerDisabledBadge")}</Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={refreshing}
                onClick={() => setRevision((value) => value + 1)}
              >
                <span className="model-config-btn-inner">
                  <IconRefresh size={13} />
                  <span>{t("settings.minihRouterRefresh")}</span>
                </span>
              </Button>
            </div>
          ) : null}
        </div>

        <div className="settings-panel minih-router-body">
          {routerProvider ? (
            <>
              <ConnectedAccountCard
                provider={routerProvider}
                account={account.data}
                onSaved={async () => {
                  await refreshProviders();
                  setRevision((value) => value + 1);
                }}
              />
              <MinihRouterAccountSummary account={account.data} locale={locale} />
              {account.state === "loading" && !account.data ? (
                <p className="minih-router-status">{t("settings.minihRouterLoading")}</p>
              ) : null}
              {account.state === "error" ? (
                <p className="minih-router-status is-error" role="alert">
                  <span>{t("settings.minihRouterAccountFailed")}</span>
                  <span className="minih-router-status-detail">{account.message}</span>
                </p>
              ) : null}
              <EasyTierLanSection revision={revision} />
            </>
          ) : (
            <ConnectAccountCard
              onConnected={async () => {
                await refreshProviders();
                setRevision((value) => value + 1);
              }}
              onGoToModels={() => setSettingsTab("agent")}
            />
          )}
        </div>
      </section>

      {developerMode ? <OtherProvidersSection defaultOpen /> : null}
    </div>
  );
}

/** The not-yet-connected state: one token field, endpoint tucked away. */
function ConnectAccountCard({
  onConnected,
  onGoToModels,
}: {
  onConnected: () => Promise<void>;
  onGoToModels: () => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [token, setToken] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const connect = async () => {
    const secret = token.trim();
    if (!secret) return;
    setSaving(true);
    try {
      await api.createProvider({
        name: MINIH_ROUTER_NAME,
        vendorKey: "minih-router",
        type: "openai_compatible",
        protocol: "openai_compatible",
        baseUrl: minihRouterApiBaseUrl(baseUrl.trim() || MINIH_ROUTER_DEFAULT_BASE_URL),
        authKind: "api_key_and_base_url",
        apiStyle: "chat_completions",
        // Initialization stays one field: models are chosen on the models page.
        secretValue: secret,
      });
      showToast(t("settings.accountsConnectedToast"), { variant: "success" });
      setToken("");
      await onConnected();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="accounts-connect">
      <Field label={t("settings.accountsTokenLabel")} hint={t("settings.accountsTokenHint")}>
        <PasswordInput
          value={token}
          placeholder={t("settings.accountsTokenPlaceholder")}
          aria-label={t("settings.accountsTokenLabel")}
          autoComplete="off"
          showLabel={t("settings.configSync.showPassword")}
          hideLabel={t("settings.configSync.hidePassword")}
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void connect();
          }}
        />
      </Field>
      <button
        type="button"
        className="accounts-connect-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((current) => !current)}
      >
        {t("settings.accountsAdvanced")}
      </button>
      {advancedOpen ? (
        <Field
          label={t("settings.accountsEndpointLabel")}
          hint={t("settings.accountsEndpointHint")}
        >
          <Input
            value={baseUrl}
            placeholder={MINIH_ROUTER_DEFAULT_BASE_URL}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
      ) : null}
      <div className="accounts-connect-actions">
        <Button variant="primary" disabled={saving || !token.trim()} onClick={() => void connect()}>
          <span className="model-config-btn-inner">
            <span>{saving ? t("settings.accountsConnecting") : t("settings.accountsConnect")}</span>
          </span>
        </Button>
        <Button variant="ghost" onClick={onGoToModels}>
          <span className="model-config-btn-inner">
            <span>{t("settings.accountsGoToModels")}</span>
          </span>
        </Button>
      </div>
    </div>
  );
}

/** The connected state: replace token, edit endpoint, disconnect. */
function ConnectedAccountCard({
  provider,
  account,
  onSaved,
}: {
  provider: { id: string; baseUrl?: string };
  account: { keyName?: string; maskedKey?: string } | null;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [mode, setMode] = useState<"idle" | "token" | "endpoint">("idle");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [saving, setSaving] = useState(false);

  const masked = account ? [account.keyName, account.maskedKey].filter(Boolean).join(" · ") : null;

  const saveToken = async () => {
    const secret = token.trim();
    if (!secret) return;
    setSaving(true);
    try {
      await api.setProviderSecret({ id: provider.id, secretValue: secret });
      showToast(t("settings.accountsTokenReplaced"), { variant: "success" });
      setToken("");
      setMode("idle");
      await onSaved();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const saveEndpoint = async () => {
    setSaving(true);
    try {
      await api.updateProvider({
        id: provider.id,
        baseUrl: minihRouterApiBaseUrl(baseUrl.trim() || MINIH_ROUTER_DEFAULT_BASE_URL),
      });
      showToast(t("settings.accountsEndpointSaved"), { variant: "success" });
      setMode("idle");
      await onSaved();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      await api.deleteProvider(provider.id);
      showToast(t("settings.accountsDisconnected"), { variant: "success" });
      await onSaved();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="accounts-connected">
      <div className="accounts-connected-row">
        <span className="accounts-connected-key font-mono">
          {masked || t("settings.accountsTokenStored")}
        </span>
        <div className="accounts-connected-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => setMode(mode === "token" ? "idle" : "token")}
          >
            {mode === "token" ? t("settings.cancel") : t("settings.accountsReplaceToken")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              setBaseUrl(provider.baseUrl ?? "");
              setMode(mode === "endpoint" ? "idle" : "endpoint");
            }}
          >
            {mode === "endpoint" ? t("settings.cancel") : t("settings.accountsEditEndpoint")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void disconnect()}
          >
            {t("settings.accountsDisconnect")}
          </Button>
        </div>
      </div>

      {mode === "token" ? (
        <div className="accounts-connected-edit">
          <Field label={t("settings.accountsNewTokenLabel")}>
            <PasswordInput
              value={token}
              placeholder={t("settings.accountsTokenPlaceholder")}
              aria-label={t("settings.accountsNewTokenLabel")}
              autoComplete="off"
              showLabel={t("settings.configSync.showPassword")}
              hideLabel={t("settings.configSync.hidePassword")}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveToken();
              }}
            />
          </Field>
          <Button variant="primary" size="sm" disabled={saving || !token.trim()} onClick={() => void saveToken()}>
            {t("settings.accountsSaveToken")}
          </Button>
        </div>
      ) : null}

      {mode === "endpoint" ? (
        <div className="accounts-connected-edit">
          <Field label={t("settings.accountsEndpointLabel")} hint={t("settings.accountsEndpointHint")}>
            <Input
              value={baseUrl}
              placeholder={MINIH_ROUTER_DEFAULT_BASE_URL}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void saveEndpoint()}>
            {t("settings.save")}
          </Button>
        </div>
      ) : null}

    </div>
  );
}
