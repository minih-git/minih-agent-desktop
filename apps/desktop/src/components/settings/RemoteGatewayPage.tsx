/**
 * Settings ▸ Remote gateway (rollout R5, ADR 0331).
 *
 * The desktop as a connected Host: it dials the user's own Gateway over one
 * outbound Host link and never opens a listener. The page steers a link the
 * main process owns, so unmounting it only drops this renderer's status
 * subscription — a reload does not disconnect a remote device.
 *
 * Only the pairing code is a secret here, and it is meant to be read off the
 * screen: every other value (certificate, registration code, device list) is
 * either public or redacted by main.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  formatPairingTicket,
  type RemoteGatewayDeviceSummary,
  type RemoteGatewayLinkState,
  type RemoteGatewayStatus,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import {
  pairingCodeExpired,
  pairingCodeRemainingLabel,
  remoteGatewayErrorKey,
  remoteGatewayStateKey,
  remoteGatewaySwitchDisabled,
} from "../../lib/remote-gateway-state";
import { Badge, Button, Field, Input, SettingsToggle, Textarea, cx } from "../ui";

type PairingCode = { code: string; expiresAt: string; hostId: string };

export function RemoteGatewayPage() {
  const { t } = useTranslation();

  const [status, setStatus] = useState<RemoteGatewayStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [caPem, setCaPem] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollSucceeded, setEnrollSucceeded] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedTicket, setCopiedTicket] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [devices, setDevices] = useState<RemoteGatewayDeviceSummary[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const urlTouched = useRef(false);

  const describeError = useCallback(
    (prefixKey: string, error: unknown) =>
      t(prefixKey, { message: t(remoteGatewayErrorKey(error)) }),
    [t],
  );

  const applyStatus = useCallback((next: RemoteGatewayStatus) => {
    setStatus(next);
    setStatusError(null);
    // The stored URL is the default until the user edits the field.
    if (!urlTouched.current && next.url) setUrl(next.url);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      applyStatus(await api.remoteGatewayStatus());
    } catch (error) {
      setStatusError(t("settings.remoteGateway.statusFailed", { message: t(remoteGatewayErrorKey(error)) }));
    }
  }, [applyStatus, t]);

  const loadDevices = useCallback(async () => {
    try {
      const result = await api.listRemoteGatewayDevices();
      setDevices(result.devices);
      setDevicesError(null);
    } catch (error) {
      setDevices(null);
      setDevicesError(t("settings.remoteGateway.devicesFailed", { message: t(remoteGatewayErrorKey(error)) }));
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
    void loadDevices();
    // A renderer reload re-subscribes here; the link itself belongs to main
    // and is deliberately left running.
    const unsubscribe = api.onRemoteGatewayStatus(applyStatus);
    return () => {
      unsubscribe();
    };
  }, [applyStatus, loadDevices, loadStatus]);

  // The pairing code is cleared from state the moment it expires, so a code
  // that is no longer redeemable cannot be copied out of the page.
  useEffect(() => {
    if (!pairingCode) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (pairingCodeExpired(pairingCode.expiresAt, current)) setPairingCode(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [pairingCode]);

  const enrolled = status?.enrolled === true;
  const enabled = status?.enabled === true;
  const remainingMs = pairingCode ? Date.parse(pairingCode.expiresAt) - now : 0;
  const toggle = useCallback(async () => {
    if (!status) return;
    setToggling(true);
    setToggleError(null);
    try {
      applyStatus(await api.setRemoteGatewayEnabled(!status.enabled));
    } catch (error) {
      setToggleError(describeError("settings.remoteGateway.toggleFailed", error));
    } finally {
      setToggling(false);
    }
  }, [applyStatus, describeError, status]);

  const enroll = useCallback(async () => {
    const trimmedUrl = url.trim();
    const trimmedCa = caPem.trim();
    const trimmedCode = registrationCode.trim();
    if (!trimmedUrl || !trimmedCa || !trimmedCode) {
      setEnrollError(t("settings.remoteGateway.errorInvalidInput"));
      return;
    }
    setEnrolling(true);
    setEnrollError(null);
    setEnrollSucceeded(false);
    try {
      applyStatus(await api.enrollRemoteGateway({ url: trimmedUrl, caPem: trimmedCa, code: trimmedCode }));
      // The registration code is single use; never keep it in renderer state.
      setRegistrationCode("");
      setEnrollSucceeded(true);
      await loadDevices();
    } catch (error) {
      setEnrollError(describeError("settings.remoteGateway.enrollFailed", error));
    } finally {
      setEnrolling(false);
    }
  }, [applyStatus, caPem, describeError, loadDevices, registrationCode, t, url]);

  const createPairingCode = useCallback(async () => {
    setPairingBusy(true);
    setPairingError(null);
    setCopied(false);
    setCopiedTicket(false);
    try {
      const result = await api.createRemoteGatewayPairingCode();
      setNow(Date.now());
      // The ticket names the Host the code belongs to; it is derived from the
      // code, so it expires and clears with it.
      setPairingCode({ code: result.code, expiresAt: result.expiresAt, hostId: result.hostId });
    } catch (error) {
      setPairingCode(null);
      setPairingError(describeError("settings.remoteGateway.pairingFailed", error));
    } finally {
      setPairingBusy(false);
    }
  }, [describeError]);

  const copyPairingCode = useCallback(async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode.code);
      setCopied(true);
      setPairingError(null);
    } catch {
      setCopied(false);
      setPairingError(t("settings.remoteGateway.copyFailed"));
    }
  }, [pairingCode, t]);

  const copyPairingTicket = useCallback(async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(formatPairingTicket(pairingCode.hostId, pairingCode.code));
      setCopiedTicket(true);
      setPairingError(null);
    } catch {
      setCopiedTicket(false);
      setPairingError(t("settings.remoteGateway.copyFailed"));
    }
  }, [pairingCode, t]);
  const revoke = useCallback(
    async (device: RemoteGatewayDeviceSummary) => {
      setRevoking(device.deviceId);
      setDevicesError(null);
      try {
        await api.revokeRemoteGatewayDevice(device.deviceId);
        setPendingRevoke(null);
        await loadDevices();
      } catch (error) {
        setDevicesError(t("settings.remoteGateway.revokeFailed", { message: t(remoteGatewayErrorKey(error)) }));
        // A failed revoke must leave the row usable: a confirmation left armed
        // would sit on top of the error and block the retry.
        setPendingRevoke(null);
      } finally {
        setRevoking(null);
      }
    },
    [loadDevices, t],
  );

  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <div className="settings-card-heading-row">
          <h3 className="settings-card-heading">{t("settings.remoteGateway.title")}</h3>
          <Badge>{t("settings.remoteHosts.experimental")}</Badge>
        </div>
        <p className="text-sm text-text-secondary">{t("settings.remoteGateway.desc")}</p>
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="space-y-1">
            <div className="text-sm text-text-primary">{t("settings.remoteGateway.enabled")}</div>
            <div className="text-xs text-text-secondary">{t("settings.remoteGateway.enabledHint")}</div>
            {toggleError ? <div className="text-xs text-danger" role="alert">{toggleError}</div> : null}
          </div>
          <SettingsToggle
            checked={enabled}
            busy={toggling}
            disabled={remoteGatewaySwitchDisabled(status)}
            label={t("settings.remoteGateway.enabled")}
            onChange={() => void toggle()}
          />
        </div>
      </section>

      <section className="settings-card-block">
        <div className="space-y-3">
          <Field label={t("settings.remoteGateway.url")}>
            <Input
              value={url}
              placeholder={t("settings.remoteGateway.urlPlaceholder")}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => {
                urlTouched.current = true;
                setUrl(event.currentTarget.value);
              }}
            />
          </Field>
          <Field label={t("settings.remoteGateway.caPem")}>
            <Textarea
              value={caPem}
              placeholder={t("settings.remoteGateway.caPemPlaceholder")}
              rows={4}
              onChange={(event) => setCaPem(event.currentTarget.value)}
            />
          </Field>
          <Field label={t("settings.remoteGateway.registrationCode")}>
            <Input
              value={registrationCode}
              placeholder={t("settings.remoteGateway.registrationCodePlaceholder")}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setRegistrationCode(event.currentTarget.value)}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="primary"
              disabled={enrolling || !url.trim() || !caPem.trim() || !registrationCode.trim()}
              aria-busy={enrolling}
              onClick={() => void enroll()}
            >
              {enrolling ? t("settings.remoteGateway.enrolling") : t("settings.remoteGateway.enroll")}
            </Button>
            <span className="text-xs text-text-secondary">{t("settings.remoteGateway.enrollHint")}</span>
          </div>
          {enrollSucceeded && !enrollError ? (
            <p className="text-sm text-text-secondary" role="status">
              {t("settings.remoteGateway.enrollSucceeded")}
            </p>
          ) : null}
          {enrollError ? (
            <p className="text-sm text-danger" role="alert">
              {enrollError}
            </p>
          ) : null}
          {statusError ? (
            <p className="text-sm text-danger" role="alert">
              {statusError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("settings.remoteGateway.statusTitle")}</h3>
        <div className="space-y-1" aria-live="polite">
          <div className="text-sm text-text-primary">
            {status ? t(remoteGatewayStateKey(status.state)) : t("settings.remoteGateway.loading")}
          </div>
          {status?.lastError ? (
            <div className="text-xs text-text-secondary">
              {t("settings.remoteGateway.lastError")}: {status.lastError.message}
            </div>
          ) : null}
          {status?.nextRetryAt ? (
            <div className="text-xs text-text-secondary">
              {t("settings.remoteGateway.retryAt", { time: status.nextRetryAt })}
            </div>
          ) : null}
        </div>
      </section>

      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("settings.remoteGateway.pairingTitle")}</h3>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={pairingBusy}
              aria-busy={pairingBusy}
              onClick={() => void createPairingCode()}
            >
              {pairingBusy
                ? t("settings.remoteGateway.pairingCreating")
                : t("settings.remoteGateway.pairingCreate")}
            </Button>
            <span className="text-xs text-text-secondary">{t("settings.remoteGateway.pairingHint")}</span>
          </div>
          {pairingCode ? (
            <div className="space-y-2" aria-live="polite">
              <div className="flex flex-wrap items-center gap-3">
                <code
                  id="remote-gateway-pairing-code"
                  className="select-all rounded-md border border-border-default bg-surface-raised px-3 py-1.5 font-mono text-sm"
                >
                  {pairingCode.code}
                </code>
                <Button type="button" variant="secondary" onClick={() => void copyPairingCode()}>
                  {copied
                    ? t("settings.remoteGateway.pairingCopied")
                    : t("settings.remoteGateway.pairingCopy")}
                </Button>
                <span className="text-xs text-text-secondary">
                  {t("settings.remoteGateway.pairingExpiresIn", { time: pairingCodeRemainingLabel(remainingMs) })}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-text-secondary">{t("settings.remoteGateway.pairingTicket")}</span>
                <code
                  id="remote-gateway-pairing-ticket"
                  className="select-all break-all rounded-md border border-border-default bg-surface-raised px-3 py-1.5 font-mono text-xs"
                >
                  {formatPairingTicket(pairingCode.hostId, pairingCode.code)}
                </code>
                <Button type="button" variant="secondary" onClick={() => void copyPairingTicket()}>
                  {copiedTicket
                    ? t("settings.remoteGateway.pairingTicketCopied")
                    : t("settings.remoteGateway.pairingTicketCopy")}
                </Button>
              </div>
              <p className="text-xs text-text-secondary">{t("settings.remoteGateway.pairingTicketHint")}</p>
            </div>
          ) : (
            <p className="text-xs text-text-secondary">{t("settings.remoteGateway.pairingExpired")}</p>
          )}
          {pairingError ? (
            <p className="text-sm text-danger" role="alert">
              {pairingError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("settings.remoteGateway.devicesTitle")}</h3>
        <div className="space-y-2" role="list" aria-busy={devices === null}>
          {devicesError ? (
            <p className="text-sm text-danger" role="alert">
              {devicesError}
            </p>
          ) : null}
          {devices === null ? (
            <p className="text-sm text-text-secondary" role="status">
              {t("settings.remoteGateway.loading")}
            </p>
          ) : devices.length === 0 ? (
            <p className="text-sm text-text-secondary" role="status">
              {t("settings.remoteGateway.devicesEmpty")}
            </p>
          ) : (
            devices.map((device) => (
              <article
                key={device.deviceId}
                role="listitem"
                className={cx(
                  "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-default px-3 py-2",
                  device.revokedAt && "opacity-60",
                )}
              >
                <div className="space-y-1">
                  <div className="text-sm text-text-primary">{device.label}</div>
                  <div className="text-xs text-text-secondary">
                    {t("settings.remoteGateway.devicesRoles", {
                      roles: device.roles.join(", "),
                    })}
                  </div>
                  {device.lastSeenAt ? (
                    <div className="text-xs text-text-secondary">
                      {t("settings.remoteGateway.devicesLastSeen", { time: device.lastSeenAt })}
                    </div>
                  ) : null}
                </div>
                {pendingRevoke === device.deviceId ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">
                      {t("settings.remoteGateway.revokeBody")}
                    </span>
                    <Button
                      type="button"
                      variant="primary"
                      disabled={revoking === device.deviceId}
                      aria-busy={revoking === device.deviceId}
                      onClick={() => void revoke(device)}
                    >
                      {t("settings.remoteGateway.revokeConfirm")}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setPendingRevoke(null)}>
                      {t("settings.remoteGateway.cancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={Boolean(device.revokedAt)}
                    onClick={() => setPendingRevoke(device.deviceId)}
                    aria-label={t("settings.remoteGateway.revokeTitle", { label: device.label })}
                  >
                    {t("settings.remoteGateway.revoke")}
                  </Button>
                )}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
