/**
 * S8 Settings, first release (ADR mobile-direct-gateway-chat §1, §2).
 *
 * Pushed from the gear on either root, and back returns to that root. This
 * release has two sections and one honest note about the rest:
 *
 * - Model gateway: connected (the gateway, the key's label, when it was verified)
 *   or a row that opens D2; unlinking asks first, because it deletes a secret.
 * - Chat history: a placeholder that says where history will live and that it
 *   stays on this phone. The repository arrives with the history stage; showing a
 *   count now would be a number the app cannot produce.
 */
import { ChevronRight, History, Router } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Sheet } from "../components/ui/Sheet.js";

export type SettingsScreenProps = {
  connection: DirectChatConnection | null;
  /** Whether this build has a model gateway at all. */
  gatewayConfigured: boolean;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => Promise<void>;
};

export function SettingsScreen({
  connection,
  gatewayConfigured,
  onBack,
  onConnect,
  onDisconnect,
}: SettingsScreenProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function unlink() {
    setBusy(true);
    await onDisconnect();
    setBusy(false);
    setConfirming(false);
  }

  return (
    <Screen>
      <NavBar title={t("settings.title")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent>
        <SectionHeader title={t("settings.modelGateway.section")} />
        <ListGroup>
          {connection ? (
            <>
              <ListRow
                leading={<Router className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
                title={t("settings.modelGateway.connected")}
                subtitle={
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span className="inline-block h-2 w-2 rounded-full bg-[var(--rm-success,#34c759)]" aria-hidden="true" />
                    <span>{connection.keyName || t("settings.modelGateway.unnamedKey")}</span>
                    <span className="text-[var(--rm-text-faint)]">·</span>
                    <span className="break-all font-mono">{connection.gatewayRoot}</span>
                  </span>
                }
              />
              <ListRow
                title={<span className="text-[var(--rm-error)]">{t("settings.modelGateway.disconnect")}</span>}
                chevron
                onClick={() => setConfirming(true)}
              />
            </>
          ) : (
            <ListRow
              leading={<Router className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
              title={t("settings.modelGateway.connect")}
              subtitle={
                gatewayConfigured ? t("settings.modelGateway.notConnected") : t("directChat.unavailable")
              }
              trailing={<ChevronRight className="h-4 w-4 text-[var(--rm-text-faint)]" aria-hidden="true" />}
              onClick={gatewayConfigured ? onConnect : undefined}
            />
          )}
        </ListGroup>
        <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
          {t("settings.modelGateway.note")}
        </p>

        <SectionHeader title={t("settings.history.section")} />
        <ListGroup>
          <ListRow
            leading={<History className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
            title={t("settings.history.local")}
            subtitle={t("settings.history.localHint")}
          />
        </ListGroup>
        <div className="mt-2 px-4">
          <Callout>{t("settings.history.comingSoon")}</Callout>
        </div>

        <SectionHeader title={t("settings.other.section")} />
        <ListGroup>
          <ListRow title={t("settings.other.computers")} subtitle={t("settings.other.later")} />
          <ListRow title={t("settings.other.notifications")} subtitle={t("settings.other.later")} />
          <ListRow title={t("settings.other.appearance")} subtitle={t("settings.other.later")} />
          <ListRow title={t("settings.other.about")} subtitle={t("settings.other.later")} />
        </ListGroup>
      </ScreenContent>

      <Sheet open={confirming} onClose={() => setConfirming(false)} title={t("settings.modelGateway.disconnectTitle")}>
        <p className="px-1 pb-4 text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
          {t("settings.modelGateway.disconnectBody")}
        </p>
        <div className="flex flex-col gap-2">
          <Button variant="destructive" size="large" disabled={busy} onClick={() => void unlink()}>
            {t("settings.modelGateway.disconnect")}
          </Button>
          <Button variant="secondary" size="large" disabled={busy} onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>
    </Screen>
  );
}
