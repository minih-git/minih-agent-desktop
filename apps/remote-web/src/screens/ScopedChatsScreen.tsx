/**
 * An earlier account's conversations, read-only (ADR mobile-direct-gateway-chat §4).
 *
 * Reached from Settings, never from the tab bar: whatever this device is
 * connected to now is a different account or none at all, so this is history
 * kept for reference and it must never be sent under the key the app holds
 * today. The list is the same one D1 draws — the scope is a parameter, not a
 * second screen — and opening a conversation goes to D3, which sees the scope
 * mismatch and renders it read-only.
 *
 * Unarchived conversations only: restoring from the archive is an action on the
 * account this device holds, and an older account's archive is not reachable
 * from here.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Callout } from "../components/ui/Callout.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import type { DirectChatSummary } from "../lib/direct-chat/history.js";
import { directChatHistory, subscribeDirectChat } from "../lib/runtime.js";

export type ScopedChatsScreenProps = {
  gatewayRoot: string;
  accessKeyId: string;
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
};

export function ScopedChatsScreen({
  gatewayRoot,
  accessKeyId,
  onBack,
  onOpenConversation,
}: ScopedChatsScreenProps) {
  const { t } = useTranslation();
  const history = directChatHistory();
  const [rows, setRows] = useState<DirectChatSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const scope = { gatewayRoot, accessKeyId };
    const load = async () => {
      const active = await history.list(scope);
      if (!cancelled) setRows(active);
    };
    void load();
    // Another screen may finish a save while this one is open, which changes
    // nothing here but keeps the count honest if the user returns to Settings.
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, gatewayRoot, accessKeyId]);

  return (
    <Screen>
      <NavBar title={t("settings.history.otherAccounts")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent>
        <div className="px-4 pt-2">
          <Callout>{t("chats.readOnlyScope")}</Callout>
          <p className="mt-2 break-all px-1 font-mono text-[12px] leading-[16px] text-[var(--rm-text-faint)]">
            {gatewayRoot} · {accessKeyId}
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="px-4">
            <EmptyState title={t("settings.history.none")} />
          </div>
        ) : (
          <>
            <SectionHeader title={t("chats.listSection")} />
            <ListGroup>
              {rows.map((row) => (
                <ListRow
                  key={row.conversation.id}
                  title={row.conversation.title}
                  subtitle={<span className="truncate">{row.preview}</span>}
                  chevron
                  onClick={() => onOpenConversation(row.conversation.id)}
                />
              ))}
            </ListGroup>
          </>
        )}
      </ScreenContent>
    </Screen>
  );
}
