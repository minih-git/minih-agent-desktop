/**
 * This computer on the accounts page (rollout R5/R8 package F; ADR 0331).
 *
 * The account's devices reach this desktop only through what this section
 * shows: the switch that dials the Gateway, the strict and auto-admission
 * switches, the link's state, and the pairing code. Everything a user needs in
 * account mode is visible; the self-hosted registration-code path is a nested
 * advanced area, because an account names the Gateway for the user.
 *
 * The pairing code stays visible on purpose: account mode still falls back to a
 * §11.4 ticket when no computer of the account can confirm a device, so it is
 * not a self-hosted-only concern.
 */
import { useTranslation } from "react-i18next";
import { formatPairingTicket, type RemoteGatewayDeviceNotice } from "@minih-agent/shared";
import {
  accountModeVisible,
  pairingCodeRemainingLabel,
  remoteGatewayStateKey,
  remoteGatewaySwitchDisabled,
} from "../../lib/remote-gateway-state";
import { Badge, Button, SettingsToggle } from "../ui";
import type { RemoteControl } from "./useRemoteControl";

export function RemoteControlSection({ control }: { control: RemoteControl }) {
  const { t } = useTranslation();
  const { status } = control;

  const enrolled = status?.enrolled === true;
  const enabled = status?.enabled === true;
  // Available is not the same as registered: on a fresh install the Router
  // offers account mode and this desktop has a key, but nothing has enrolled
  // yet — turning the switch on is what does.
  const accountModeAvailable = status?.accountMode?.available === true;

  return (
    <section className="settings-card-block" aria-labelledby="remote-control-heading">
      <div className="settings-card-heading-row">
        <h3 id="remote-control-heading" className="settings-card-heading">
          {t("settings.accountsThisComputerTitle")}
        </h3>
        <Badge>{t("settings.remoteHosts.experimental")}</Badge>
      </div>
      <p className="text-sm text-text-secondary">{t("settings.remoteGateway.desc")}</p>

      {/* The computer's own name, the same one a phone shows; the Host id is
          the fallback because it is the one identifier that always exists. */}
      <div className="space-y-1 py-2" data-testid="accounts-this-computer">
        <div className="settings-row-title">{t("settings.accountsComputerName")}</div>
        <div className="text-sm text-text-primary font-mono">
          {status?.hostLabel || status?.hostId || t("settings.accountsComputerNameUnknown")}
        </div>
      </div>

      {accountModeVisible(status) ? (
        <div className="space-y-1 py-2" role="status" data-testid="remote-gateway-account-mode">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-primary">
              {t("settings.remoteGateway.accountModeTitle")}
            </span>
            <Badge tone={accountModeAvailable ? (enrolled ? "success" : "neutral") : "neutral"}>
              {!accountModeAvailable
                ? t("settings.remoteGateway.accountModeUnavailable")
                : enrolled
                  ? t("settings.remoteGateway.accountModeActive")
                  : t("settings.remoteGateway.accountModeReady")}
            </Badge>
          </div>
          {!accountModeAvailable ? (
            <p className="text-xs text-text-secondary">
              {t("settings.remoteGateway.accountModeUnavailableHint")}
              {status?.accountMode?.reason ? ` ${status.accountMode.reason}` : ""}
            </p>
          ) : (
            <>
              <p className="text-xs text-text-secondary">
                {enrolled
                  ? t("settings.remoteGateway.accountModeActiveHint")
                  : t("settings.remoteGateway.accountModeReadyHint")}
              </p>
              {status?.accountMode?.url ? (
                <p className="font-mono text-xs text-text-secondary">{status.accountMode.url}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-1">
          <div className="text-sm text-text-primary">{t("settings.remoteGateway.enabled")}</div>
          <div className="text-xs text-text-secondary">{t("settings.remoteGateway.enabledHint")}</div>
          {control.toggle.error ? (
            <div className="text-xs text-danger" role="alert">
              {control.toggle.error}
            </div>
          ) : null}
        </div>
        <SettingsToggle
          checked={enabled}
          busy={control.toggle.busy}
          disabled={remoteGatewaySwitchDisabled(status)}
          label={t("settings.remoteGateway.enabled")}
          onChange={() => void control.onToggle()}
        />
      </div>

      <div className="space-y-1 py-2" aria-live="polite">
        <div className="settings-row-title">{t("settings.remoteGateway.statusTitle")}</div>
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
        {control.statusError ? (
          <p className="text-xs text-danger" role="alert">
            {control.statusError}
          </p>
        ) : null}
      </div>

      {accountModeVisible(status) ? (
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="space-y-1">
            <div className="settings-row-title">{t("settings.remoteGateway.strictTitle")}</div>
            <div className="text-sm text-text-primary">
              {t("settings.remoteGateway.strictLabel")}
            </div>
            <div className="text-xs text-text-secondary">
              {t("settings.remoteGateway.strictHint")}
            </div>
            {control.strict.error ? (
              <div className="text-xs text-danger" role="alert">
                {control.strict.error}
              </div>
            ) : null}
          </div>
          <SettingsToggle
            checked={status?.strictDevices === true}
            busy={control.strict.busy}
            label={t("settings.remoteGateway.strictLabel")}
            onChange={() => void control.onToggleStrict()}
          />
        </div>
      ) : null}

      {accountModeVisible(status) ? (
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="space-y-1">
            <div className="settings-row-title">{t("settings.remoteGateway.desktopAutoTitle")}</div>
            <div className="text-sm text-text-primary">{t("settings.remoteGateway.desktopAutoLabel")}</div>
            <div className="text-xs text-text-secondary">{t("settings.remoteGateway.desktopAutoHint")}</div>
            {control.desktopAuto.error ? (
              <div className="text-xs text-danger" role="alert">
                {control.desktopAuto.error}
              </div>
            ) : null}
          </div>
          <SettingsToggle
            checked={status?.desktopAutoAdmission !== false}
            busy={control.desktopAuto.busy}
            label={t("settings.remoteGateway.desktopAutoLabel")}
            onChange={() => void control.onToggleDesktopAuto()}
          />
        </div>
      ) : null}

      {control.notices.length > 0 ? (
        <div className="space-y-1 py-2" aria-live="polite">
          <div className="settings-row-title">{t("settings.remoteGateway.noticesTitle")}</div>
          <ul className="space-y-1 text-xs text-text-secondary" role="list">
            {control.notices.map((notice) => (
              <li key={`${notice.kind}-${notice.deviceId}-${notice.at}`} role="listitem">
                {t(noticeKey(notice), { label: notice.label, time: notice.at, device: notice.deviceId })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <PairingCodeBlock control={control} />
    </section>
  );
}
/**
 * The catalog key for one notice. A desktop-class device is announced as a
 * computer rather than a phone, and `host.joined` names another computer of the
 * account (ADR amendment 3) — both are the same notice channel the page already
 * renders, so the person at this machine sees them without a new surface.
 */
function noticeKey(notice: RemoteGatewayDeviceNotice): string {
  if (notice.kind === "host.joined") return "settings.remoteGateway.noticeHostJoined";
  if (notice.deviceClass === "desktop") {
    if (notice.kind === "device.adopted") return "settings.remoteGateway.noticeDesktopAdopted";
    if (notice.kind === "device.revoked") return "settings.remoteGateway.noticeDesktopRevoked";
  }
  switch (notice.kind) {
    case "device.minted":
      return "settings.remoteGateway.noticeMinted";
    case "device.adopted":
      return "settings.remoteGateway.noticeAdopted";
    case "device.revoked":
      return "settings.remoteGateway.noticeRevoked";
    case "device.session-created":
      return "settings.remoteGateway.noticeSessionCreated";
    case "device.session-configured":
      return "settings.remoteGateway.noticeSessionConfigured";
    case "device.project-registered":
      return "settings.remoteGateway.noticeProjectRegistered";
  }
}

/** One-time pairing code plus the ticket a phone can paste instead. */
function PairingCodeBlock({ control }: { control: RemoteControl }) {
  const { t } = useTranslation();
  const { pairing } = control;
  return (
    <div className="space-y-3 py-2">
      <div className="settings-row-title">{t("settings.remoteGateway.pairingTitle")}</div>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={pairing.busy}
          aria-busy={pairing.busy}
          onClick={() => void control.onCreatePairingCode()}
        >
          {pairing.busy
            ? t("settings.remoteGateway.pairingCreating")
            : t("settings.remoteGateway.pairingCreate")}
        </Button>
        <span className="text-xs text-text-secondary">{t("settings.remoteGateway.pairingHint")}</span>
      </div>
      {pairing.code ? (
        <div className="space-y-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-3">
            <code
              id="remote-gateway-pairing-code"
              className="select-all rounded-md border border-border-default bg-surface-raised px-3 py-1.5 font-mono text-sm"
            >
              {pairing.code.code}
            </code>
            <Button type="button" variant="secondary" onClick={() => void control.onCopyPairingCode()}>
              {pairing.copied
                ? t("settings.remoteGateway.pairingCopied")
                : t("settings.remoteGateway.pairingCopy")}
            </Button>
            <span className="text-xs text-text-secondary">
              {t("settings.remoteGateway.pairingExpiresIn", {
                time: pairingCodeRemainingLabel(pairing.remainingMs),
              })}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-text-secondary">
              {t("settings.remoteGateway.pairingTicket")}
            </span>
            <code
              id="remote-gateway-pairing-ticket"
              className="select-all break-all rounded-md border border-border-default bg-surface-raised px-3 py-1.5 font-mono text-xs"
            >
              {formatPairingTicket(pairing.code.hostId, pairing.code.code)}
            </code>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void control.onCopyPairingTicket()}
            >
              {pairing.copiedTicket
                ? t("settings.remoteGateway.pairingTicketCopied")
                : t("settings.remoteGateway.pairingTicketCopy")}
            </Button>
          </div>
          <p className="text-xs text-text-secondary">
            {t("settings.remoteGateway.pairingTicketHint")}
          </p>
        </div>
      ) : (
        <p className="text-xs text-text-secondary">{t("settings.remoteGateway.pairingExpired")}</p>
      )}
      {pairing.error ? (
        <p className="text-sm text-danger" role="alert">
          {pairing.error}
        </p>
      ) : null}
    </div>
  );
}
