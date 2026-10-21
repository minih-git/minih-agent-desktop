import { useTranslation } from "react-i18next";
import type { ConfigSyncPendingApproval } from "@minih-agent/shared";
import { Button } from "../ui";
import { SettingsCard } from "../../features/settings/primitives";
import { groupConfigSyncApprovals } from "../../features/settings/config-sync-conflicts";

const REASON_KEYS: Record<ConfigSyncPendingApproval["reason"], string> = {
  newDevice: "settings.configSync.approvalReason.newDevice",
  securityChange: "settings.configSync.approvalReason.securityChange",
  dependency: "settings.configSync.approvalReason.dependency",
  mapping: "settings.configSync.approvalReason.mapping",
  conflict: "settings.configSync.approvalReason.conflict",
};

/**
 * Staged imports waiting for this device. A merge conflict arrives as two
 * candidate approvals, so it renders as one card with one choice per side:
 * approving a side is what dismisses its sibling on the Host.
 */
export function ConfigSyncApprovals({
  approvals,
  disabled,
  onApprove,
  onReject,
  onMapFolder,
}: {
  approvals: readonly ConfigSyncPendingApproval[];
  disabled: boolean;
  onApprove: (approvalId: string, digest: string) => void;
  onReject: (approvalId: string, digest: string) => void;
  onMapFolder: (logicalId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsCard
      title={t("settings.configSync.approvalsTitle")}
      description={t("settings.configSync.approvalsDescription")}
    >
      <div className="settings-config-sync-approvals">
        {groupConfigSyncApprovals(approvals).map((group) => {
          if (group.kind === "conflict") {
            const { local, remote } = group;
            // A side already dismissed leaves a single candidate: the choice is
            // gone, so keep the ordinary rejection as the only other action.
            const solo = local && remote ? null : (local ?? remote ?? null);
            return (
              <div
                key={group.key}
                className="settings-config-sync-approval"
                data-config-sync-conflict={group.baseId}
              >
                <div>
                  <div className="settings-config-sync-approval-title">{group.label}</div>
                  <div className="settings-config-sync-approval-meta">
                    {t("settings.configSync.conflictChoiceHint")}
                  </div>
                </div>
                <div className="settings-config-sync-actions">
                  {group.mappingKey ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onMapFolder(group.mappingKey as string)}
                      disabled={disabled}
                    >
                      {t("settings.configSync.mapFolder")}
                    </Button>
                  ) : null}
                  {local ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      data-config-sync-side="local"
                      onClick={() => onApprove(local.id, local.digest)}
                      disabled={disabled}
                    >
                      {t("settings.configSync.conflictAcceptLocal")}
                    </Button>
                  ) : null}
                  {remote ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      data-config-sync-side="remote"
                      onClick={() => onApprove(remote.id, remote.digest)}
                      disabled={disabled}
                    >
                      {t("settings.configSync.conflictAcceptRemote")}
                    </Button>
                  ) : null}
                  {solo ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onReject(solo.id, solo.digest)}
                      disabled={disabled}
                    >
                      {t("settings.configSync.reject")}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          }
          const approval = group.approval;
          return (
            <div key={group.key} className="settings-config-sync-approval">
              <div>
                <div className="settings-config-sync-approval-title">{approval.label}</div>
                <div className="settings-config-sync-approval-meta">
                  {t(REASON_KEYS[approval.reason])}
                </div>
              </div>
              <div className="settings-config-sync-actions">
                {approval.mappingKey ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onMapFolder(approval.mappingKey as string)}
                    disabled={disabled}
                  >
                    {t("settings.configSync.mapFolder")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onReject(approval.id, approval.digest)}
                  disabled={disabled}
                >
                  {t("settings.configSync.reject")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => onApprove(approval.id, approval.digest)}
                  disabled={disabled}
                >
                  {t("settings.configSync.approve")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}
