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
import {
  Archive,
  Edit3,
  Image as ImageIcon,
  MessagesSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Router,
  Search,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
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
import { Sheet } from "../components/ui/Sheet.js";
import { resolveEffectiveChatModel, resolveEffectiveImageModel } from "../lib/direct-chat/catalog.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import type { DirectChatSummary } from "../lib/direct-chat/history.js";
import {
  directChatHistory,
  directChatRunner,
  directChatScope,
  directChatService,
  notifyDirectChatChanged,
  subscribeDirectChat,
} from "../lib/runtime.js";

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
  const runner = directChatRunner();

  const [rows, setRows] = useState<DirectChatSummary[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"chats" | "images">("chats");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [imageModelsOpen, setImageModelsOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<DirectChatSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<DirectChatSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<DirectChatSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      /*
       * Without a key D1 still lists what this device holds: the account used
       * most recently. Resolving it inside the load - not into state first -
       * means one pass fills the list, and a load that arrives late is dropped
       * by the same `cancelled` check as any other.
       */
      const scope = connectedScope ?? (await history.lastScope());
      if (!scope) {
        if (cancelled) return;
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
  }, [history, connectedScope, query]);

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

  const handleQuickNewChat = () => {
    if (!connection) return;
    const resolved = resolveEffectiveChatModel(
      connection.models,
      connection.defaultChatModelId,
      connection.lastModelId,
    );
    if (resolved.model) {
      onNewConversation(resolved.model.id);
      return;
    }
    setModelsOpen(true);
  };
  const handleCreateImage = () => {
    if (!connection) return;
    const resolved = resolveEffectiveImageModel(
      connection.models,
      connection.defaultImageModelId,
    );
    if (resolved) {
      onNewConversation(resolved.id);
      return;
    }
    setImageModelsOpen(true);
  };

  const trailingButtons = connection ? (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => void handleCreateImage()}
        aria-label={t("chats.createImage")}
        title={t("chats.createImage")}
        className="flex h-10 w-10 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] transition-opacity active:opacity-60"
      >
        <ImageIcon className="h-5 w-5 stroke-[1.8]" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void handleQuickNewChat()}
        aria-label={t("chats.newChat")}
        title={t("chats.newChat")}
        className="flex h-10 w-10 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] transition-opacity active:opacity-60"
      >
        <Plus className="h-5 w-5 stroke-[2]" aria-hidden="true" />
      </button>
    </div>
  ) : undefined;

  const hasHistory = rows.length > 0 || archivedCount > 0;

  return (
    <Screen>
      <NavBar title={t("chats.title")} leading={gear} trailing={trailingButtons} />
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

        {/* The list stays while nothing is connected: reading needs no key. */}
        {connection || hasHistory ? (
          <>
            <div className="mx-3 mb-2 flex rounded-[8px] bg-[var(--rm-bg-inset)] p-0.5">
              <button
                type="button"
                onClick={() => setActiveTab("chats")}
                className={`flex-1 rounded-[6px] py-1 text-[13px] font-medium transition-all ${
                  activeTab === "chats"
                    ? "bg-[var(--rm-bg-surface)] text-[var(--rm-text-primary)] shadow-sm"
                    : "text-[var(--rm-text-muted)]"
                }`}
              >
                {t("chats.tabChats")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("images")}
                className={`flex-1 rounded-[6px] py-1 text-[13px] font-medium transition-all ${
                  activeTab === "images"
                    ? "bg-[var(--rm-bg-surface)] text-[var(--rm-text-primary)] shadow-sm"
                    : "text-[var(--rm-text-muted)]"
                }`}
              >
                {t("chats.tabImages")}
              </button>
            </div>

            <label className="mx-3 mb-2 flex min-h-[38px] items-center gap-2 rounded-[10px] bg-[var(--rm-bg-inset)] px-3">
              <Search className="h-4 w-4 shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("chats.search")}
                aria-label={t("chats.search")}
                className="min-w-0 flex-1 bg-transparent py-2 text-[16px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none"
              />
            </label>

            {(() => {
              const displayRows = rows.filter((r) =>
                activeTab === "images" ? r.isImage === true : true,
              );
              if (displayRows.length === 0) {
                return (
                  <div className="px-4">
                    <EmptyState
                      icon={
                        activeTab === "images" ? (
                          <ImageIcon className="h-9 w-9 stroke-[1.5]" aria-hidden="true" />
                        ) : (
                          <MessagesSquare className="h-9 w-9 stroke-[1.5]" aria-hidden="true" />
                        )
                      }
                      title={
                        query
                          ? t("chats.emptyList")
                          : activeTab === "images"
                            ? t("imageGen.empty")
                            : t("chats.emptyTitle")
                      }
                      description={query ? undefined : activeTab === "images" ? undefined : t("chats.emptyHint")}
                    />
                  </div>
                );
              }
              return (
                <>
                  <SectionHeader title={t("chats.listSection")} />
                  <ListGroup>
                    {displayRows.map((row) => (
                      <ListRow
                        key={row.conversation.id}
                        title={row.conversation.title}
                        subtitle={
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{row.preview}</span>
                          </span>
                        }
                        trailing={
                          <div className="flex items-center gap-1.5">
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
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setActionTarget(row);
                              }}
                              aria-label={t("directChat.actions")}
                              className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--rm-text-faint)] hover:text-[var(--rm-text-primary)] active:opacity-60"
                            >
                              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </div>
                        }
                        chevron
                        onClick={() => onOpenConversation(row.conversation.id)}
                      />
                    ))}
                  </ListGroup>
                </>
              );
            })()}
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

      {/* Conversation Action Sheet */}
      <Sheet
        open={actionTarget !== null}
        onClose={() => setActionTarget(null)}
        title={actionTarget?.conversation.title ?? t("directChat.actions")}
      >
        <div className="flex flex-col gap-1 pb-2">
          <ListGroup>
            <ListRow
              leading={
                actionTarget?.conversation.pinned ? (
                  <PinOff className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />
                ) : (
                  <Pin className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />
                )
              }
              title={actionTarget?.conversation.pinned ? t("directChat.unpin") : t("directChat.pin")}
              chevron
              onClick={async () => {
                if (!actionTarget) return;
                await history.setPinned(actionTarget.conversation.id, !actionTarget.conversation.pinned);
                setActionTarget(null);
                notifyDirectChatChanged();
              }}
            />
            <ListRow
              leading={<Edit3 className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
              title={t("directChat.rename")}
              chevron
              onClick={() => {
                if (!actionTarget) return;
                setRenameTitle(actionTarget.conversation.title);
                setRenameTarget(actionTarget);
                setActionTarget(null);
              }}
            />
            <ListRow
              leading={<Archive className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
              // A reply in flight refuses the archive, and a row that then did
              // nothing was bug B6. The row says what it will do, and does it.
              title={
                actionTarget?.liveAttempt
                  ? t("directChat.stopAndArchive")
                  : t("directChat.archive")
              }
              chevron
              onClick={async () => {
                const target = actionTarget;
                if (!target) return;
                setActionTarget(null);
                if (target.liveAttempt) await runner.stop(target.conversation.id);
                await history.setArchived(target.conversation.id, true);
                notifyDirectChatChanged();
              }}
            />
            <ListRow
              leading={<Trash2 className="h-5 w-5 text-[var(--rm-error)]" aria-hidden="true" />}
              title={<span className="text-[var(--rm-error)]">{t("directChat.delete")}</span>}
              chevron
              onClick={() => {
                if (!actionTarget) return;
                setDeleteConfirmTarget(actionTarget);
                setActionTarget(null);
              }}
            />
          </ListGroup>
        </div>
      </Sheet>

      {/* Rename Sheet */}
      <Sheet
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={t("directChat.rename")}
      >
        <div className="flex items-center gap-2 px-1 pb-4">
          <input
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            aria-label={t("directChat.rename")}
            className="min-w-0 flex-1 rounded-[10px] bg-[var(--rm-bg-inset)] px-3 py-2 text-[16px] text-[var(--rm-text-primary)] outline-none"
          />
          <Button
            variant="primary"
            size="small"
            disabled={renameTitle.trim().length === 0 || renameTitle.trim() === renameTarget?.conversation.title}
            onClick={async () => {
              if (!renameTarget || !renameTitle.trim()) return;
              await history.rename(renameTarget.conversation.id, renameTitle.trim());
              setRenameTarget(null);
              notifyDirectChatChanged();
            }}
          >
            {t("common.save")}
          </Button>
        </div>
      </Sheet>

      {/* Delete Confirmation Sheet */}
      <Sheet
        open={deleteConfirmTarget !== null}
        onClose={() => {
          if (!busy) {
            setDeleteConfirmTarget(null);
            setDeleteError(null);
          }
        }}
        title={t("directChat.deleteTitle")}
      >
        <p className="px-1 pb-4 text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
          {t("directChat.deleteBody")}
        </p>
        {deleteError ? (
          <p className="px-1 pb-3 text-[14px] leading-[20px] text-red-500 font-medium">
            {deleteError}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            variant="destructive"
            size="large"
            disabled={busy}
            onClick={async () => {
              if (!deleteConfirmTarget) return;
              setBusy(true);
              setDeleteError(null);
              try {
                // Ensure runner stop precedes removal
                await runner.stop(deleteConfirmTarget.conversation.id);
                const result = await history.remove(deleteConfirmTarget.conversation.id);
                if (!result.ok) {
                  setDeleteError(result.reason ?? "Delete failed");
                  return;
                }
                setDeleteConfirmTarget(null);
                notifyDirectChatChanged();
              } catch (err) {
                setDeleteError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("directChat.delete")}
          </Button>
          <Button variant="secondary" size="large" disabled={busy} onClick={() => { setDeleteConfirmTarget(null); setDeleteError(null); }}>
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>

      {connection ? (
        <ModelSheet
          open={modelsOpen}
          mode="chat"
          models={connection.models}
          selectedId={connection.defaultChatModelId ?? connection.lastModelId ?? null}
          allowSetDefault={true}
          onClose={() => setModelsOpen(false)}
          onSelectDefault={(model) => {
            void directChatService().setDefaultChatModel(model.id);
          }}
          onSelect={(model) => {
            setModelsOpen(false);
            onNewConversation(model.id);
          }}
        />
      ) : null}

      {connection ? (
        <ModelSheet
          open={imageModelsOpen}
          mode="image"
          models={connection.models}
          selectedId={connection.defaultImageModelId ?? null}
          title={t("imageGen.title")}
          allowSetDefault={true}
          onClose={() => setImageModelsOpen(false)}
          onSelectDefault={(model) => {
            void directChatService().setDefaultImageModel(model.id);
          }}
          onSelect={(model) => {
            setImageModelsOpen(false);
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
