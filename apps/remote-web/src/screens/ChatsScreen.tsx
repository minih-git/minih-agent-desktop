/**
 * D1 Chats root (ADR mobile-direct-gateway-chat §1, §2).
 *
 * Two states, and no third:
 *
 * - not connected: an explanation and one action, "Connect model gateway". A
 *   build without a model gateway origin says so instead of offering a button
 *   that cannot work.
 * - connected: the empty state of a phone-owned history that arrives with its own
 *   stage, plus the account's name and the model this phone would use. The list,
 *   search and Archived link come with the repository; nothing here pretends to
 *   have conversations yet.
 *
 * The gear opens Settings from here as well as from Computers (the ADR's two
 * gears). The model row opens the same sheet D3 will use, so the sheet can be
 * reviewed before sending exists.
 */
import { MessagesSquare, Router, Settings as SettingsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";

export type ChatsScreenProps = {
  connection: DirectChatConnection | null;
  /** Whether this build has a model gateway origin at all. */
  gatewayConfigured: boolean;
  onConnect: () => void;
  onOpenSettings: () => void;
  onOpenModels: () => void;
};

export function ChatsScreen({
  connection,
  gatewayConfigured,
  onConnect,
  onOpenSettings,
  onOpenModels,
}: ChatsScreenProps) {
  const { t } = useTranslation();

  const gear = (
    <button
      type="button"
      onClick={onOpenSettings}
      aria-label={t("chats.settings")}
      title={t("chats.settings")}
      className="flex h-10 w-10 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] transition-opacity active:opacity-60"
    >
      <SettingsIcon className="h-5 w-5 stroke-[1.8]" aria-hidden="true" />
    </button>
  );

  return (
    <Screen>
      <NavBar title={t("chats.title")} leading={gear} />
      <ScreenContent>
        {connection ? (
          <>
            <div className="px-4 pt-2">
              <EmptyState
                icon={<MessagesSquare className="h-10 w-10 stroke-[1.5]" aria-hidden="true" />}
                title={t("chats.emptyTitle")}
                description={t("chats.emptyHint")}
              />
            </div>
            <SectionHeader title={t("chats.accountSection")} />
            <ListGroup>
              <ListRow
                leading={<Router className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
                title={connection.keyName || t("settings.modelGateway.unnamedKey")}
                subtitle={<span className="break-all font-mono">{connection.gatewayRoot}</span>}
                chevron
                onClick={onOpenSettings}
              />
              <ListRow
                title={t("chats.modelRow")}
                subtitle={connection.lastModelId ?? t("chats.modelUnset")}
                chevron
                onClick={onOpenModels}
              />
            </ListGroup>
          </>
        ) : (
          <div className="px-4 pt-2">
            <EmptyState
              icon={<Router className="h-10 w-10 stroke-[1.5]" aria-hidden="true" />}
              title={gatewayConfigured ? t("chats.connectTitle") : t("directChat.unavailableTitle")}
              description={gatewayConfigured ? t("chats.connectHint") : t("directChat.unavailable")}
              action={
                gatewayConfigured ? (
                  <Button variant="primary" size="large" onClick={onConnect}>
                    {t("chats.connect")}
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}
      </ScreenContent>
    </Screen>
  );
}
