/**
 * D1 Chats root (ADR mobile-direct-gateway-chat §1, §4).
 *
 * The account's conversations, pinned first and then by activity, with a search
 * that filters titles and saved text in place. Two states above the list:
 *
 * - not connected: an explanation and one action, or - when history exists - a
 *   banner saying the history is readable and sending needs the gateway. History
 *   never becomes unreadable because a key was removed.
 * - connected: the list, a new-chat action, and the archived count as the way
 *   into D4.
 *
 * A row states what is happening in it: a reply still arriving, or the last one
 * that ended early, so the list is honest before the user opens anything.
 */
import { MessagesSquare, Plus, Router, Search, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { ModelSheet } from "../components/ModelSheet.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { resolveDirectModel } from "../lib/direct-chat/catalog.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import type { DirectChatSummary } from "../lib/direct-chat/history.js";
import { directChatHistory, directChatScope, subscribeDirectChat } from "../lib/runtime.js";

export type ChatsScreenProps = {
  connection: DirectChatConnection | null;
  /** Whether this build has a model gateway origin at all. */
  gatewayConfigured: boolean;
  onConnect: () => void;
  onOpenSettings: () => void;
  onOpenConversation: (conversationId: string) => void;
  /** A new conversation is opened before it has a record. */
  onNewConversation: (modelId: string) => void;
  onOpenArchive: () => void;
};

export function ChatsScreen({
  connection,
  gatewayConfigured,
  onConnect,
  onOpenSettings,
  onOpenConversation,
  onNewConversation,
  onOpenArchive,
}: ChatsScreenProps) {
  const { t } = useTranslation();
  const history = directChatHistory();
  const connectedScope = directChatScope();
  /**
   * While nothing is connected, the account used most recently is still
   * readable: removing a key must not make its conversations disappear.
   */
  const [offlineScope, setOfflineScope] = useState<{ gatewayRoot: string; accessKeyId: string } | null>(null);
  const scope = connectedScope ?? offlineScope;

  const [rows, setRows] = useState<DirectChatSummary[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!connectedScope) {
      void history.lastScope().then((last) => {
        if (!cancelled) setOfflineScope(last);
      });
    }
    const load = async () => {
      if (!scope) {
        setRows([]);
        setArchivedCount(0);
        return;
      }
      const [active, archived] = await Promise.all([
        history.list(scope, { query }),
        history.list(scope, { archived: true }),
      ]);
      if (cancelled) return;
      setRows(active);
      setArchivedCount(archived.length);
    };
    void load();
    // A reply changes its row's state, so the list follows the store.
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, connectedScope, scope, query]);

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

  const newChat = (
    <button
      type="button"
      onClick={() => setModelsOpen(true)}
      aria-label={t("chats.newChat")}
      title={t("chats.newChat")}
      className="flex h-10 w-10 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] transition-opacity active:opacity-60"
    >
      <Plus className="h-5 w-5 stroke-[2]" aria-hidden="true" />
    </button>
  );

  const hasHistory = rows.length > 0 || archivedCount > 0;

  return (
    <Screen>
      <NavBar title={t("chats.title")} leading={gear} trailing={connection ? newChat : undefined} />
      <ScreenContent>
        {!connection ? (
          <div className="px-4 pt-2">
            {hasHistory ? (
              // History stays readable without a key; only sending needs one.
              <div className="mb-3">
                <Callout>{t("chats.offlineBanner")}</Callout>
                <div className="mt-2">
                  <Button variant="secondary" size="large" onClick={gatewayConfigured ? onConnect : undefined}>
                    {t("chats.connect")}
                  </Button>
                </div>
              </div>
            ) : (
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
            )}
          </div>
        ) : null}

        {connection ? (
          <>
            <label className="mx-3 mb-2 flex min-h-[38px] items-center gap-2 rounded-[10px] bg-[var(--rm-bg-inset)] px-3">
              <Search className="h-4 w-4 shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("chats.search")}
                aria-label={t("chats.search")}
                className="min-w-0 flex-1 bg-transparent py-2 text-[15px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none"
              />
            </label>

            {rows.length === 0 ? (
              <div className="px-4">
                <EmptyState
                  icon={<MessagesSquare className="h-9 w-9 stroke-[1.5]" aria-hidden="true" />}
                  title={query ? t("chats.emptyList") : t("chats.emptyTitle")}
                  description={query ? undefined : t("chats.emptyHint")}
                />
              </div>
            ) : (
              <>
                <SectionHeader title={t("chats.listSection")} />
                <ListGroup>
                  {rows.map((row) => (
                    <ListRow
                      key={row.conversation.id}
                      title={row.conversation.title}
                      subtitle={
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{row.preview}</span>
                        </span>
                      }
                      trailing={
                        <span className="flex shrink-0 flex-col items-end text-[12px] leading-[16px] text-[var(--rm-text-faint)]">
                          <span>{formatTime(row.conversation.updatedAt)}</span>
                          {row.liveAttempt ? (
                            <span className="text-[var(--rm-accent)]">{t("chats.replying")}</span>
                          ) : row.lastFailure ? (
                            <span className="text-[var(--rm-text-muted)]">
                              {row.lastFailure.state === "interrupted"
                                ? t("directChat.state.interrupted").split(" ·")[0]
                                : row.lastFailure.state === "stopped"
                                  ? t("directChat.state.stopped").split(" ·")[0]
                                  : t("directChat.state.failed")}
                            </span>
                          ) : null}
                        </span>
                      }
                      chevron
                      onClick={() => onOpenConversation(row.conversation.id)}
                    />
                  ))}
                </ListGroup>
              </>
            )}

            {!connectedScope ? (
              <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                {t("chats.readOnlyScope")}
              </p>
            ) : null}

            {archivedCount > 0 ? (
              <div className="mt-3">
                <ListGroup>
                  <ListRow
                    title={t("chats.archivedLink", { count: archivedCount })}
                    chevron
                    onClick={onOpenArchive}
                  />
                </ListGroup>
              </div>
            ) : null}
          </>
        ) : null}
      </ScreenContent>

      {connection ? (
        <ModelSheet
          open={modelsOpen}
          models={connection.models}
          selectedId={connection.lastModelId}
          onClose={() => setModelsOpen(false)}
          onSelect={(model) => {
            // A new conversation starts on the account's last explicit choice, and
            // only a usable model can start one.
            if (!resolveDirectModel(model).usable) return;
            onNewConversation(model.id);
          }}
        />
      ) : null}
    </Screen>
  );
}

/** The row's time, in the reader's locale, without a dependency. */
function formatTime(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  const now = new Date();
  const sameDay = value.toDateString() === now.toDateString();
  return sameDay
    ? value.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : value.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
