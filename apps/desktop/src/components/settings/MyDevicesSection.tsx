/**
 * My devices on the accounts page (rollout R8 package F).
 *
 * Everything that can reach this account's machines, in one list: the
 * computers of the account (the paired-host inventory, which already knows
 * online state and whether a machine is behind this release) and the devices
 * this desktop's Gateway has granted (phones and sibling computers, with the
 * two-step revoke that already exists).
 *
 * The section is read-mostly by design: pairing happens on This computer, and
 * the only action here is revocation, which goes through the same signed
 * revoke path the device list has always used.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteGatewayAccountComputers, RemoteHostSummary } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { accountComputersNotice } from "../../lib/remote-gateway-state";
import { Badge, Button, cx } from "../ui";
import type { RemoteControl } from "./useRemoteControl";

export function MyDevicesSection({ control }: { control: RemoteControl }) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<RemoteHostSummary[] | null>(null);

  // The computer list refreshes with the device list: both change together when
  // a sibling joins or is revoked. The join report is a dependency too — a retry
  // that finally reaches the account's roster is the round that makes these rows
  // appear, and nothing else in this renderer changes at that moment.
  // Unmounting drops the read, not the hosts.
  const joinAt = control.status?.accountComputers?.at;
  useEffect(() => {
    let live = true;
    void api.listRemoteHosts().then((result) => {
      if (live) setHosts(result.hosts);
    }).catch(() => {
      // Keep the previous answer: an empty list would read as "no computers",
      // which is a worse lie than slightly stale rows.
    });
    return () => { live = false; };
  }, [control.devices, joinAt]);

  const accountComputers = (hosts ?? []).filter((host) => host.transport === "account");

  return (
    <section className="settings-card-block" aria-labelledby="my-devices-heading">
      <div className="settings-card-heading-row">
        <h3 id="my-devices-heading" className="settings-card-heading">
          {t("settings.accountsDevices.title")}
        </h3>
      </div>
      <p className="text-sm text-text-secondary">{t("settings.accountsDevices.desc")}</p>

      <div className="space-y-2 py-2" data-testid="accounts-devices-computers">
        <div className="settings-row-title">{t("settings.accountsDevices.computersTitle")}</div>
        {hosts === null ? (
          <p className="text-sm text-text-secondary" role="status">{t("settings.remoteGateway.loading")}</p>
        ) : accountComputers.length === 0 ? (
          <p className="text-sm text-text-secondary" role="status">
            {t("settings.accountsDevices.computersEmpty")}
          </p>
        ) : (
          accountComputers.map((host) => (
            <article
              key={host.hostKey}
              role="listitem"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-default px-3 py-2"
            >
              <div className="space-y-1">
                <div className="text-sm text-text-primary">{host.label}</div>
                <div className="text-xs text-text-secondary">
                  {host.connected
                    ? (host.needsUpgrade ? t("settings.accountsDevices.needsUpdate") : t("settings.accountsDevices.online"))
                    : t("settings.accountsDevices.offline")}
                </div>
              </div>
              <Badge tone={host.connected ? "success" : "neutral"}>
                {t("settings.accountsDevices.kindComputer")}
              </Badge>
            </article>
          ))
        )}
      </div>

      {/* Why the account's other computers are not listed. The roster is the
          Gateway's answer, so without this line a round that failed is silence. */}
      <AccountComputersNotice report={control.status?.accountComputers} />

      <DeviceGrantList control={control} />
    </section>
  );
}

/**
 * The devices this desktop's Gateway granted, with the two-step revoke. The
 * kind badge names what was paired — a phone or a sibling computer — because
 * "device" alone says nothing about what can reach the machine.
 */
function DeviceGrantList({ control }: { control: RemoteControl }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 py-2" role="list" aria-busy={control.devices === null} data-testid="accounts-devices-grants">
      <div className="settings-row-title">{t("settings.remoteGateway.devicesTitle")}</div>
      {control.devicesError ? (
        <p className="text-sm text-danger" role="alert">
          {control.devicesError}
        </p>
      ) : null}
      {control.devices === null ? (
        <p className="text-sm text-text-secondary" role="status">
          {t("settings.remoteGateway.loading")}
        </p>
      ) : control.devices.length === 0 ? (
        <p className="text-sm text-text-secondary" role="status">
          {t("settings.remoteGateway.devicesEmpty")}
        </p>
      ) : (
        control.devices.map((device) => (
          <article
            key={device.deviceId}
            role="listitem"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-default px-3 py-2"
          >
            <div className="space-y-1">
              <div className="text-sm text-text-primary">{device.label}</div>
              <div className="text-xs text-text-secondary">
                {t(kindKey(device), { roles: device.roles.join(", ") })}
              </div>
              {device.lastSeenAt ? (
                <div className="text-xs text-text-secondary">
                  {t("settings.remoteGateway.devicesLastSeen", { time: device.lastSeenAt })}
                </div>
              ) : null}
            </div>
            <Badge>
              {t(device.deviceClass === "desktop" ? "settings.accountsDevices.kindComputer" : "settings.accountsDevices.kindPhone")}
            </Badge>
            {control.revoke.pending === device.deviceId ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary">
                  {t("settings.remoteGateway.revokeBody")}
                </span>
                <Button
                  type="button"
                  variant="primary"
                  disabled={control.revoke.busy === device.deviceId}
                  aria-busy={control.revoke.busy === device.deviceId}
                  onClick={() => void control.onRevoke(device)}
                >
                  {t("settings.remoteGateway.revokeConfirm")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => control.setPendingRevoke(null)}>
                  {t("settings.remoteGateway.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => control.setPendingRevoke(device.deviceId)}
                aria-label={t("settings.remoteGateway.revokeTitle", { label: device.label })}
              >
                {t("settings.remoteGateway.revoke")}
              </Button>
            )}
          </article>
        ))
      )}
    </div>
  );
}

/**
 * Why the account's other computers are not listed, or nothing when they all are.
 *
 * The wording lives in one place (`accountComputersNotice`) so the rule — a
 * failed round is retried, a skipped one is not, and two reasons say nothing —
 * is testable without a DOM.
 */
function AccountComputersNotice({ report }: { report?: RemoteGatewayAccountComputers }) {
  const { t } = useTranslation();
  const notice = accountComputersNotice(report);
  if (!notice) return null;
  return (
    <p
      className={cx("py-1 text-sm", notice.failed ? "text-danger" : "text-text-secondary")}
      role="status"
      data-testid="accounts-devices-join-status"
    >
      {t(notice.key, { reason: notice.reason })}
    </p>
  );
}

/** The roles line keeps the original wording for a device of unknown class. */
function kindKey(device: { deviceClass?: "phone" | "desktop" }): string {
  return device.deviceClass
    ? "settings.accountsDevices.kindRoles"
    : "settings.remoteGateway.devicesRoles";
}
