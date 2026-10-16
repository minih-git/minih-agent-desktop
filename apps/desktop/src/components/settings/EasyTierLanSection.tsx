/**
 * EasyTier virtual LAN status and configuration section on the accounts page.
 *
 * Displays the current tunnel state (Connected / Connecting / Degraded / Error / Disabled),
 * effective operating mode (Mode 1 No-TUN user-space forwarder vs Mode 2 privileged TUN NIC),
 * virtual IPv4, connected peer count, and active routing path, plus controls to reconnect,
 * request administrator privileges for TUN mode, or customize network parameters.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  EASYTIER_DEFAULT_NETWORK_NAME,
  EASYTIER_DEFAULT_NETWORK_SECRET,
  EASYTIER_DEFAULT_PEERS,
  EASYTIER_DEFAULT_ROUTER_LAN_URL,
  easyTierBootstrapLabel,
  type EasyTierConnectionState,
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
  const [editing, setEditing] = useState(false);
  const [networkName, setNetworkName] = useState(EASYTIER_DEFAULT_NETWORK_NAME);
  const [networkSecret, setNetworkSecret] = useState(EASYTIER_DEFAULT_NETWORK_SECRET);
  const [peersInput, setPeersInput] = useState(EASYTIER_DEFAULT_PEERS.join(", "));
  const [staticIpv4, setStaticIpv4] = useState("");
  const [dhcp, setDhcp] = useState(true);
  const [routerLanUrl, setRouterLanUrl] = useState(EASYTIER_DEFAULT_ROUTER_LAN_URL);

  const status: EasyTierStatus | null = load.data;

  useEffect(() => {
    if (!status || editing) return;
    const peers = status.bootstrapPeers ?? status.peers ?? [];
    setNetworkName(status.networkName || EASYTIER_DEFAULT_NETWORK_NAME);
    setPeersInput(
      peers.length > 0
        ? peers.join(", ")
        : EASYTIER_DEFAULT_PEERS.join(", "),
    );
    setRouterLanUrl(status.routerLanUrl || EASYTIER_DEFAULT_ROUTER_LAN_URL);
    setDhcp(status.dhcp !== false);
    setStaticIpv4(status.staticIpv4 ?? "");
  }, [status, editing]);

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

  const bootstrapPeers = status.bootstrapPeers ?? status.peers ?? [];
  const effectiveMode = status.effectiveMode ?? status.configuredMode;
  const modeLabel =
    effectiveMode === "tun"
      ? t("settings.minihRouterLanModeTun")
      : t("settings.minihRouterLanModeNoTun");

  // The gateway issues the network identity when it answered, so the fields it
  // owns are shown read-only rather than silently ignored on save.
  const gatewayNetworkName = easyTierBootstrapLabel(status);
  const gatewayManaged = gatewayNetworkName !== null;

  const activeRouteText = status.usingLan
    ? t("settings.minihRouterLanRouteActive", {
        endpoint: endpointLabel(status.routerLanUrl) || status.routerLanUrl,
      })
    : t("settings.minihRouterLanRouteFallback", {
        endpoint: endpointLabel(status.fallbackRouterBaseUrl) || status.fallbackRouterBaseUrl,
      });

  const handleToggleEnabled = () => {
    void configure({
      enabled: !status.enabled,
      mode: status.configuredMode,
      networkName: status.networkName,
      peers: bootstrapPeers,
      routerLanUrl: status.routerLanUrl,
      dhcp: status.dhcp,
      ipv4: status.dhcp ? "" : status.staticIpv4,
    }).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    });
  };

  const handleReconnect = () => {
    void reconnect().then(
      () => showToast(t("settings.minihRouterLanReconnected"), { variant: "success" }),
      (error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
  };

  const handleRequestTun = () => {
    void requestElevation().then(
      (next) => {
        if (next.effectiveMode === "tun") {
          showToast(t("settings.minihRouterLanTunEnabled"), { variant: "success" });
        } else {
          showToast(t("settings.minihRouterLanTunFallback"), { variant: "info" });
        }
      },
      (error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
  };

  const handleSwitchNoTun = () => {
    void configure({
      enabled: status.enabled,
      mode: "no_tun",
      networkName: status.networkName,
      peers: bootstrapPeers,
      routerLanUrl: status.routerLanUrl,
      dhcp: status.dhcp,
      ipv4: status.dhcp ? "" : status.staticIpv4,
    }).then(
      () => showToast(t("settings.minihRouterLanSaved"), { variant: "success" }),
      (error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
  };

  const handleSaveSettings = () => {
    const peers = peersInput
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    void configure({
      enabled: status.enabled,
      mode: status.configuredMode,
      networkName: networkName.trim() || EASYTIER_DEFAULT_NETWORK_NAME,
      networkSecret: networkSecret.trim() || EASYTIER_DEFAULT_NETWORK_SECRET,
      peers: peers.length > 0 ? peers : [...EASYTIER_DEFAULT_PEERS],
      routerLanUrl: routerLanUrl.trim() || EASYTIER_DEFAULT_ROUTER_LAN_URL,
      dhcp,
      ipv4: dhcp ? "" : staticIpv4.trim(),
    }).then(
      () => {
        setEditing(false);
        showToast(t("settings.minihRouterLanSaved"), { variant: "success" });
      },
      (error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
    );
  };

  const handleResetDefaults = () => {
    setNetworkName(EASYTIER_DEFAULT_NETWORK_NAME);
    setNetworkSecret(EASYTIER_DEFAULT_NETWORK_SECRET);
    setPeersInput(EASYTIER_DEFAULT_PEERS.join(", "));
    setRouterLanUrl(EASYTIER_DEFAULT_ROUTER_LAN_URL);
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
          {gatewayManaged ? (
            <Badge tone="neutral">{t("settings.minihRouterLanBootstrapGateway")}</Badge>
          ) : null}
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
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={handleRequestTun}
            >
              {t("settings.minihRouterLanRequestTun")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={handleSwitchNoTun}
            >
              {t("settings.minihRouterLanSwitchNoTun")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-expanded={editing}
            onClick={() => setEditing((current) => !current)}
          >
            {t("settings.minihRouterLanConfigure")}
          </Button>
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
              {status.virtualIpv4 ?? (status.localForwardPort ? `127.0.0.1:${status.localForwardPort}` : "—")}
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
      </dl>

      {status.lastError ? (
        <p className="minih-router-status is-error" role="alert">
          <span className="minih-router-status-detail">{status.lastError}</span>
        </p>
      ) : null}

      {editing ? (
        <div className="minih-router-lan-form" data-testid="minih-router-lan-form">
          {gatewayManaged ? (
            <p className="minih-router-price-hint">
              {t("settings.minihRouterLanBootstrapHint")}
            </p>
          ) : null}
          <div className="minih-router-lan-grid">
            <Field label={t("settings.minihRouterLanNetworkName")}>
              <Input
                value={networkName}
                aria-label={t("settings.minihRouterLanNetworkName")}
                disabled={busy || gatewayManaged}
                onChange={(event) => setNetworkName(event.target.value)}
              />
            </Field>
            <Field label={t("settings.minihRouterLanNetworkSecret")}>
              <PasswordInput
                value={networkSecret}
                aria-label={t("settings.minihRouterLanNetworkSecret")}
                showLabel={t("settings.minihRouterLanShowSecret")}
                hideLabel={t("settings.minihRouterLanHideSecret")}
                disabled={busy || gatewayManaged}
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
            <Button variant="primary" size="sm" disabled={busy} onClick={handleSaveSettings}>
              {t("settings.minihRouterLanSave")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
