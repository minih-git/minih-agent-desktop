/**
 * Network center (virtual LAN) status and configuration on the accounts page.
 *
 * The identity that joins the mesh is issued by the gateway: the section shows
 * the connection state, the virtual IPv4, the route in use and the network name
 * the gateway handed out, plus the controls to reconnect or switch between the
 * two tunnel modes. It never edits the identity, because nobody types it.
 *
 * Only developer mode renders this section, and only there can the identity be
 * configured by hand — the escape hatch for a self-hosted gateway that does not
 * serve the bootstrap endpoint.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "../../features/settings/primitives";
import {
  easyTierBootstrapLabel,
  easyTierDefaultNetworkName,
  easyTierDefaultPeers,
  easyTierDefaultRouterLanUrl,
  type EasyTierConnectionState,
  type EasyTierSettings,
  type EasyTierStatus,
} from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, Field, Input, PasswordInput, SettingsToggle } from "../ui";
import { endpointLabel } from "./service-catalog";
import { useEasyTierStatus } from "./useMinihRouter";

function stateBadgeTone(
  state: EasyTierConnectionState,
): "neutral" | "success" | "warning" | "error" {
  switch (state) {
    case "connected":
      return "success";
    case "connecting":
    case "degraded":
      return "warning";
    case "error":
      return "error";
    case "disabled":
    default:
      return "neutral";
  }
}

function stateLabelKey(state: EasyTierConnectionState): string {
  switch (state) {
    case "connected":
      return "settings.minihRouterLanStateConnected";
    case "connecting":
      return "settings.minihRouterLanStateConnecting";
    case "degraded":
      return "settings.minihRouterLanStateDegraded";
    case "error":
      return "settings.minihRouterLanStateError";
    case "disabled":
    default:
      return "settings.minihRouterLanStateDisabled";
  }
}

export function EasyTierLanSection({ revision }: { revision: number }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { load, busy, configure, reconnect, requestElevation } = useEasyTierStatus(revision);
  // The manual form is closed unless the saved row already asks for a manual
  // identity: a normal install never sees an identity it could type.
  const [manualOpen, setManualOpen] = useState(false);
  const [networkName, setNetworkName] = useState(easyTierDefaultNetworkName);
  const [networkSecret, setNetworkSecret] = useState("");
  const [peersInput, setPeersInput] = useState(() => easyTierDefaultPeers().join(", "));
  const [routerLanUrl, setRouterLanUrl] = useState(easyTierDefaultRouterLanUrl);
  const [dhcp, setDhcp] = useState(true);
  const [staticIpv4, setStaticIpv4] = useState("");

  const status: EasyTierStatus | null = load.data;

  useEffect(() => {
    if (!status) return;
    const peers = status.bootstrapPeers ?? status.peers ?? [];
    setNetworkName(status.networkName || easyTierDefaultNetworkName());
    setPeersInput(peers.length > 0 ? peers.join(", ") : easyTierDefaultPeers().join(", "));
    setRouterLanUrl(status.routerLanUrl || easyTierDefaultRouterLanUrl());
    setDhcp(status.dhcp !== false);
    setStaticIpv4(status.staticIpv4 ?? "");
  }, [status]);

  // A saved manual identity is a developer choice: keep its form open so the
  // parameters it depends on stay visible and editable.
  useEffect(() => {
    if (status?.identity === "manual") setManualOpen(true);
  }, [status?.identity]);

  if (!status) {
    if (load.state !== "error") return null;
    return (
      <div className="minih-router-lan" data-testid="minih-router-lan">
        <p className="minih-router-status is-error" role="alert">
          <span className="minih-router-status-detail">{load.message}</span>
        </p>
      </div>
    );
  }

  const effectiveMode = status.effectiveMode ?? status.configuredMode;
  const modeLabel =
    effectiveMode === "tun"
      ? t("settings.minihRouterLanModeTun")
      : t("settings.minihRouterLanModeNoTun");
  const manualIdentity = status.identity === "manual";
  // The gateway owns the network name; it is shown read-only, never edited.
  const gatewayNetworkName = easyTierBootstrapLabel(status);
  // Nothing joined the mesh: say why, because the fix is the user's to make.
  const holdReason = status.bootstrapError.trim();

  const activeRouteText = status.usingLan
    ? t("settings.minihRouterLanRouteActive", {
        endpoint: endpointLabel(status.routerLanUrl) || status.routerLanUrl,
      })
    : t("settings.minihRouterLanRouteFallback", {
        endpoint: endpointLabel(status.fallbackRouterBaseUrl) || status.fallbackRouterBaseUrl,
      });

  const reportError = (error: unknown) => {
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
  };

  // Mode and switch writes carry only the fields they own: the identity and its
  // secret stay as stored, so a manual identity survives a reconnect.
  const handleToggleEnabled = () => {
    void configure({
      enabled: !status.enabled,
      mode: status.configuredMode,
    }).catch(reportError);
  };

  const handleReconnect = () => {
    void reconnect().then(
      () => showToast(t("settings.minihRouterLanReconnected"), { variant: "success" }),
      reportError,
    );
  };

  const handleRequestTun = () => {
    void requestElevation().then((next) => {
      showToast(
        next.effectiveMode === "tun"
          ? t("settings.minihRouterLanTunEnabled")
          : t("settings.minihRouterLanTunFallback"),
        { variant: next.effectiveMode === "tun" ? "success" : "info" },
      );
    }, reportError);
  };

  const handleSwitchNoTun = () => {
    void configure({ mode: "no_tun" }).then(
      () => showToast(t("settings.minihRouterLanSaved"), { variant: "success" }),
      reportError,
    );
  };

  const handleManualToggle = () => {
    if (manualOpen) {
      // Closing the switch returns the channel to the gateway-issued identity,
      // which is the only mode a normal install ever runs.
      setManualOpen(false);
      void configure({ identity: "gateway" }).then(
        () => showToast(t("settings.minihRouterLanSaved"), { variant: "success" }),
        reportError,
      );
      return;
    }
    setManualOpen(true);
  };

  const handleSaveManual = () => {
    if (!networkSecret.trim()) {
      showToast(t("settings.minihRouterLanManualSecretRequired"), { variant: "error" });
      return;
    }
    const peers = peersInput
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const next: EasyTierSettings = {
      identity: "manual",
      enabled: status.enabled,
      mode: status.configuredMode,
      networkName: networkName.trim() || easyTierDefaultNetworkName(),
      networkSecret: networkSecret.trim(),
      peers: peers.length > 0 ? peers : easyTierDefaultPeers(),
      routerLanUrl: routerLanUrl.trim() || easyTierDefaultRouterLanUrl(),
      dhcp,
      ipv4: dhcp ? "" : staticIpv4.trim(),
    };
    void configure(next).then(
      () => showToast(t("settings.minihRouterLanSaved"), { variant: "success" }),
      reportError,
    );
  };

  const handleResetDefaults = () => {
    setNetworkName(easyTierDefaultNetworkName());
    setNetworkSecret("");
    setPeersInput(easyTierDefaultPeers().join(", "));
    setRouterLanUrl(easyTierDefaultRouterLanUrl());
    setDhcp(true);
    setStaticIpv4("");
  };

  return (
    <div className="minih-router-lan" data-testid="minih-router-lan">
      <div className="minih-router-lan-head">
        <div className="minih-router-lan-title-row">
          <h4 className="minih-router-models-title">{t("settings.minihRouterLanTitle")}</h4>
          <Badge tone={stateBadgeTone(status.state)}>{t(stateLabelKey(status.state))}</Badge>
          <Badge tone={effectiveMode === "tun" ? "success" : "neutral"}>{modeLabel}</Badge>
          <Badge tone={manualIdentity ? "warning" : "neutral"}>
            {manualIdentity
              ? t("settings.minihRouterLanIdentityManual")
              : t("settings.minihRouterLanIdentityGateway")}
          </Badge>
        </div>
        <div className="minih-router-lan-actions">
          <SettingsToggle
            checked={status.enabled}
            busy={busy}
            label={t("settings.minihRouterLanToggle")}
            onChange={handleToggleEnabled}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !status.enabled}
            onClick={handleReconnect}
          >
            {t("settings.minihRouterLanReconnect")}
          </Button>
          {effectiveMode !== "tun" ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleRequestTun}>
              {t("settings.minihRouterLanRequestTun")}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={handleSwitchNoTun}>
              {t("settings.minihRouterLanSwitchNoTun")}
            </Button>
          )}
        </div>
      </div>

      <p className="minih-router-price-hint">{t("settings.minihRouterLanDesc")}</p>

      <dl className="minih-router-lan-stats">
        <div className="minih-router-stat">
          <dt>{t("settings.minihRouterLanRoute")}</dt>
          <dd>
            <span className="minih-router-stat-value is-compact">{activeRouteText}</span>
          </dd>
        </div>
        <div className="minih-router-stat">
          <dt>{t("settings.minihRouterLanVirtualIp")}</dt>
          <dd>
            <span className="minih-router-stat-value is-compact">
              {status.virtualIpv4 ??
                (status.localForwardPort ? `127.0.0.1:${status.localForwardPort}` : "—")}
            </span>
          </dd>
        </div>
        <div className="minih-router-stat">
          <dt>{t("settings.minihRouterLanPeers")}</dt>
          <dd>
            <span className="minih-router-stat-value is-compact">{status.peerCount}</span>
          </dd>
        </div>
        <div className="minih-router-stat">
          <dt>{t("settings.minihRouterLanMode")}</dt>
          <dd>
            <span className="minih-router-stat-value is-compact">{modeLabel}</span>
          </dd>
        </div>
        <div className="minih-router-stat">
          <dt>{t("settings.minihRouterLanNetworkName")}</dt>
          <dd>
            <span
              className="minih-router-stat-value is-compact"
              data-testid="minih-router-lan-network-name"
            >
              {gatewayNetworkName ??
                (manualIdentity
                  ? status.networkName || "—"
                  : t("settings.minihRouterLanIdentityPending"))}
            </span>
          </dd>
        </div>
      </dl>

      {holdReason ? (
        <p className="minih-router-status is-error" role="alert" data-testid="minih-router-lan-hold">
          <span>{t("settings.minihRouterLanHoldLabel")}</span>
          <span className="minih-router-status-detail">{holdReason}</span>
          {manualIdentity ? null : (
            <span className="minih-router-status-detail">
              {t("settings.minihRouterLanHoldEndpointHint")}
            </span>
          )}
        </p>
      ) : null}

      {status.lastError ? (
        <p className="minih-router-status is-error" role="alert">
          <span className="minih-router-status-detail">{status.lastError}</span>
        </p>
      ) : null}

      <SettingsRow
        title={t("settings.minihRouterLanManualToggle")}
        description={t("settings.minihRouterLanManualHint")}
      >
        <SettingsToggle
          checked={manualOpen}
          busy={busy}
          label={t("settings.minihRouterLanManualToggle")}
          onChange={handleManualToggle}
        />
      </SettingsRow>
      <p className="minih-router-price-hint">{t("settings.minihRouterLanManualHint")}</p>
      {manualOpen ? (
        <div className="minih-router-lan-form" data-testid="minih-router-lan-form">
          <div className="minih-router-lan-grid">
            <Field label={t("settings.minihRouterLanNetworkName")}>
              <Input
                value={networkName}
                aria-label={t("settings.minihRouterLanNetworkName")}
                disabled={busy}
                onChange={(event) => setNetworkName(event.target.value)}
              />
            </Field>
            <Field label={t("settings.minihRouterLanNetworkSecret")}>
              <PasswordInput
                value={networkSecret}
                aria-label={t("settings.minihRouterLanNetworkSecret")}
                showLabel={t("settings.minihRouterLanShowSecret")}
                hideLabel={t("settings.minihRouterLanHideSecret")}
                disabled={busy}
                onChange={(event) => setNetworkSecret(event.target.value)}
              />
            </Field>
            <Field label={t("settings.minihRouterLanRouterUrl")}>
              <Input
                value={routerLanUrl}
                aria-label={t("settings.minihRouterLanRouterUrl")}
                disabled={busy}
                onChange={(event) => setRouterLanUrl(event.target.value)}
              />
            </Field>
            <Field label={t("settings.minihRouterLanBootstrapPeers")}>
              <Input
                value={peersInput}
                aria-label={t("settings.minihRouterLanBootstrapPeers")}
                disabled={busy}
                onChange={(event) => setPeersInput(event.target.value)}
              />
            </Field>
            <Field label={t("settings.minihRouterLanDhcp")}>
              <SettingsToggle
                checked={dhcp}
                busy={busy}
                label={t("settings.minihRouterLanDhcp")}
                onChange={() => setDhcp((current) => !current)}
              />
            </Field>
            {dhcp ? null : (
              <Field label={t("settings.minihRouterLanStaticIpv4")}>
                <Input
                  value={staticIpv4}
                  aria-label={t("settings.minihRouterLanStaticIpv4")}
                  placeholder="11.12.0.10"
                  disabled={busy}
                  onChange={(event) => setStaticIpv4(event.target.value)}
                />
              </Field>
            )}
          </div>
          <div className="minih-router-lan-form-actions">
            <Button variant="ghost" size="sm" disabled={busy} onClick={handleResetDefaults}>
              {t("settings.minihRouterLanReset")}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={handleSaveManual}>
              {t("settings.minihRouterLanSave")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
