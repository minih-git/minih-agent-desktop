/**
 * D1 Chats root (ADR mobile-direct-gateway-chat §1, §4, ADR mobile-redesign D3, B7).
 *
 * Text conversations only (`filterTextConversations`): image conversations live
 * in Studio (tab 2) and never appear here (bug B7). Pinned conversations render
 * as a horizontal card strip above the recent list (`splitPinnedAndRecent`), and
 * each row supports both swipe actions (`SwipeRow`: pin, archive, delete) and an
 * accessible "More" button that opens the action sheet.
 */
import {
  Archive,
  Edit3,
  MessageSquareText,
  MessagesSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Router,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelSheet } from "../components/ModelSheet.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup, ListRow, SwipeRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Sheet } from "../components/ui/Sheet.js";
import { Tag } from "../components/ui/StatusDot.js";
import { Toast } from "../components/ui/Toast.js";
import { resolveEffectiveChatModel } from "../lib/direct-chat/catalog.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import type { DirectChatSummary } from "../lib/direct-chat/history.js";
import { vendorBadge } from "../lib/direct-chat/model-picker.js";
import {
  filterTextConversations,
  splitPinnedAndRecent,
} from "../lib/direct-chat/studio.js";
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
  onOpenStudio?: () => void;
};

export function ChatsScreen({
  connection,
  gatewayConfigured,
  onConnect,
  onOpenSettings,
  onOpenConversation,
  onNewConversation,
  onOpenArchive,
  onOpenStudio,
}: ChatsScreenProps) {
  const { t } = useTranslation();
  const history = directChatHistory();
  const connectedScope = directChatScope();
  const runner = directChatRunner();

  const [rows, setRows] = useState<DirectChatSummary[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [query, setQuery] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<DirectChatSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<DirectChatSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<DirectChatSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
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
      // Chats lists text conversations only (ADR mobile-redesign D3, bug B7).
      setRows(filterTextConversations(active));
      setArchivedCount(filterTextConversations(archived).length);
    };
    void load();
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, connectedScope, query]);

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

  const trailingButtons = connection ? (
    <div className="flex items-center gap-0.5">
      <Button
        variant="plain"
        size="icon"
        onClick={() => setModelsOpen(true)}
        aria-label={t("chats.modelRow")}
        title={t("chats.modelRow")}
      >
        <Sparkles className="h-5 w-5 stroke-[1.9]" aria-hidden="true" />
      </Button>
      <Button
        variant="plain"
        size="icon"
        onClick={() => void handleQuickNewChat()}
        aria-label={t("chats.newChat")}
        title={t("chats.newChat")}
      >
        <Plus className="h-5 w-5 stroke-[2.2]" aria-hidden="true" />
      </Button>
    </div>
  ) : undefined;

  const { pinned, recent } = useMemo(() => splitPinnedAndRecent(rows), [rows]);
  const listRows = query.trim().length > 0 ? rows : recent.length > 0 ? recent : rows;
  const hasHistory = rows.length > 0 || archivedCount > 0;

  const togglePin = async (row: DirectChatSummary) => {
    await history.setPinned(row.conversation.id, !row.conversation.pinned);
    notifyDirectChatChanged();
  };

  const archiveRow = async (row: DirectChatSummary) => {
    if (row.liveAttempt) await runner.stop(row.conversation.id);
    await history.setArchived(row.conversation.id, true);
    notifyDirectChatChanged();
  };

  return (
    <Screen aurora>
      <NavBar
        title={t("chats.title")}
        largeTitle
        onAvatarClick={onOpenSettings}
        avatarLabel={t("chats.settings")}
        trailing={trailingButtons}
      />

      <ScreenContent className="pb-24">
        <h1 className="rm-title-large mb-3.5 pt-1">{t("chats.title")}</h1>

        {!connection ? (
          <div className="pt-1">
            {hasHistory ? (
              <div className="mb-3 space-y-2">
                <Callout>{t("chats.offlineBanner")}</Callout>
                <Button
                  variant="secondary"
                  size="large"
                  onClick={gatewayConfigured ? onConnect : undefined}
                >
                  {t("chats.connect")}
                </Button>
              </div>
            ) : (
              <EmptyState
                icon={<Router className="h-10 w-10 stroke-[1.7]" aria-hidden="true" />}
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

        {connection || hasHistory ? (
          <>
            <label className="mb-3.5 flex min-h-[42px] items-center gap-2 rounded-[14px] bg-[var(--rm-bg-surface-2)] px-3.5">
              <Search className="h-[18px] w-[18px] shrink-0 text-[var(--rm-text-muted)]" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("chats.search")}
                aria-label={t("chats.search")}
                className="min-w-0 flex-1 bg-transparent py-2 text-[16px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none"
              />
            </label>

            {rows.length === 0 ? (
              <EmptyState
                icon={<MessagesSquare className="h-9 w-9 stroke-[1.7]" aria-hidden="true" />}
                title={query ? t("chats.emptyList") : t("chats.emptyTitle")}
                description={query ? undefined : t("chats.emptyHint")}
              />
            ) : (
              <>
                {pinned.length > 0 && !query.trim() ? (
                  <>
                    <SectionHeader title={t("chats.pinnedSection")} />
                    <div className="mb-1 flex gap-2.5 overflow-x-auto pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {pinned.map((row) => (
                        <div
                          key={row.conversation.id}
                          className="relative flex w-[132px] shrink-0 flex-col justify-between rounded-[18px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] p-3 text-left backdrop-blur-md transition-transform duration-150 active:scale-[0.975]"
                        >
                          <div className="mb-2 flex items-center justify-between">
                            <span
                              aria-hidden="true"
                              className="grid h-[30px] w-[30px] place-items-center rounded-[10px] bg-[image:var(--rm-aurora)] text-white"
                            >
                              <MessageSquareText className="h-4 w-4 stroke-[2]" />
                            </span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setActionTarget(row);
                              }}
                              aria-label={t("directChat.actions")}
                              className="grid h-7 w-7 place-items-center rounded-[8px] text-[var(--rm-text-faint)] hover:text-[var(--rm-text-primary)]"
                            >
                              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => onOpenConversation(row.conversation.id)}
                            className="w-full text-left"
                          >
                            <b className="block truncate text-[14px] font-semibold text-[var(--rm-text-primary)]">
                              {row.conversation.title}
                            </b>
                            <small className="mt-0.5 block truncate text-[12px] text-[var(--rm-text-muted)]">
                              {formatTime(row.conversation.updatedAt)}
                            </small>
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}

                <SectionHeader title={t("chats.listSection")} />
                <ListGroup>
                  {listRows.map((row) => {
                    const badge = vendorBadge(null, row.conversation.nextModelId);
                    const failureState = row.lastFailure?.state;
                    return (
                      <SwipeRow
                        key={row.conversation.id}
                        actions={[
                          {
                            key: "pin",
                            label: row.conversation.pinned ? t("directChat.unpin") : t("directChat.pin"),
                            icon: row.conversation.pinned ? (
                              <PinOff className="h-5 w-5" aria-hidden="true" />
                            ) : (
                              <Pin className="h-5 w-5" aria-hidden="true" />
                            ),
                            tone: "pin",
                            onClick: () => void togglePin(row),
                          },
                          {
                            key: "archive",
                            label: row.liveAttempt
                              ? t("directChat.stopAndArchive")
                              : t("directChat.archive"),
                            icon: <Archive className="h-5 w-5" aria-hidden="true" />,
                            tone: "archive",
                            onClick: () => void archiveRow(row),
                          },
                          {
                            key: "delete",
                            label: t("directChat.delete"),
                            icon: <Trash2 className="h-5 w-5" aria-hidden="true" />,
                            tone: "danger",
                            onClick: () => setDeleteConfirmTarget(row),
                          },
                        ]}
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => onOpenConversation(row.conversation.id)}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onOpenConversation(row.conversation.id);
                            }
                          }}
                          className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors active:bg-[var(--rm-bg-surface-2)]"
                        >
                          <span
                            aria-hidden="true"
                            className={`mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-[13px] text-[13px] font-extrabold text-white ${badge.gradientClass}`}
                          >
                            {badge.monogram}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <b className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-[21px] text-[var(--rm-text-primary)]">
                                {row.conversation.title}
                              </b>
                              <time className="shrink-0 text-[12px] text-[var(--rm-text-faint)]">
                                {formatTime(row.conversation.updatedAt)}
                              </time>
                            </div>
                            <div className="mt-0.5 truncate text-[14px] leading-[19px] text-[var(--rm-text-muted)]">
                              {row.liveAttempt ? (
                                <span className="rm-text-shimmer">{t("chats.replying")}</span>
                              ) : (
                                row.preview
                              )}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {row.conversation.nextModelId ? (
                                <Tag>{row.conversation.nextModelId}</Tag>
                              ) : null}
                              {!row.liveAttempt && failureState === "interrupted" ? (
                                <Tag tone="warn">
                                  {t("directChat.state.interrupted").split(" ·")[0]}
                                </Tag>
                              ) : !row.liveAttempt && failureState === "stopped" ? (
                                <Tag tone="warn">
                                  {t("directChat.state.stopped").split(" ·")[0]}
                                </Tag>
                              ) : !row.liveAttempt && failureState === "failed" ? (
                                <Tag tone="error">{t("directChat.state.failed")}</Tag>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActionTarget(row);
                            }}
                            aria-label={t("directChat.actions")}
                            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[var(--rm-text-faint)] hover:text-[var(--rm-text-primary)] active:opacity-60"
                          >
                            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </SwipeRow>
                    );
                  })}
                </ListGroup>
              </>
            )}

            {archivedCount > 0 ? (
              <div className="mt-3.5">
                <ListGroup>
                  <ListRow
                    leadingIcon={<Archive className="h-[19px] w-[19px]" aria-hidden="true" />}
                    title={t("chats.archivedLink", { count: archivedCount })}
                    value={archivedCount}
                    chevron
                    onClick={onOpenArchive}
                  />
                </ListGroup>
              </div>
            ) : null}
          </>
        ) : null}
      </ScreenContent>

      {/* Floating New Chat action */}
      {connection ? (
        <button
          type="button"
          onClick={() => void handleQuickNewChat()}
          className="fixed bottom-24 right-5 z-20 inline-flex h-[52px] items-center gap-1.5 rounded-[26px] bg-[image:var(--rm-aurora)] pl-4 pr-5 text-[15px] font-bold text-white shadow-[0_12px_30px_rgba(124,92,255,0.45)] transition-transform duration-150 active:scale-[0.93]"
        >
          <Plus className="h-[22px] w-[22px] stroke-[2.3]" aria-hidden="true" />
          <span>{t("chats.newChat")}</span>
        </button>
      ) : null}

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
                await togglePin(actionTarget);
                setActionTarget(null);
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
                await archiveRow(target);
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
            className="min-w-0 flex-1 rounded-[12px] bg-[var(--rm-bg-surface-2)] px-3 py-2 text-[16px] text-[var(--rm-text-primary)] outline-none"
          />
          <Button
            variant="primary"
            size="small"
            disabled={
              renameTitle.trim().length === 0 ||
              renameTitle.trim() === renameTarget?.conversation.title
            }
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
          <p className="px-1 pb-3 text-[14px] leading-[20px] font-medium text-[var(--rm-error)]">
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
          <Button
            variant="secondary"
            size="large"
            disabled={busy}
            onClick={() => {
              setDeleteConfirmTarget(null);
              setDeleteError(null);
            }}
          >
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
          defaultChatModelId={connection.defaultChatModelId}
          defaultImageModelId={connection.defaultImageModelId}
          allowSetDefault={true}
          onClose={() => setModelsOpen(false)}
          onSelectDefault={(model) => {
            void directChatService().setDefaultChatModel(model.id);
          }}
          onSetDefault={(model, targetMode) => {
            setToastMsg(
              t(
                targetMode === "image"
                  ? "modelSheet.defaultToastImage"
                  : "modelSheet.defaultToastChat",
                { model: model.id },
              ),
            );
          }}
          onSelect={(model, pickedMode) => {
            setModelsOpen(false);
            if (pickedMode === "image") {
              directChatService().rememberImageModel(model.id);
              onOpenStudio?.();
              return;
            }
            onNewConversation(model.id);
          }}
        />
      ) : null}

      <Toast
        message={toastMsg}
        visible={toastMsg !== null}
        onDismiss={() => setToastMsg(null)}
      />
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
