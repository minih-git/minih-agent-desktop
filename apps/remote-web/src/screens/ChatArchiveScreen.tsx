/**
 * D4: archived direct conversations (ADR mobile-direct-gateway-chat §1, §4).
 *
 * The same rows as D1, with one difference that matters: restoring here puts a
 * conversation back in the list intact, and opening one goes to D3 with the
 * archive as its origin, so back returns here rather than to the root.
 */
import { Archive } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { Tag } from "../components/ui/StatusDot.js";
import type { DirectChatSummary } from "../lib/direct-chat/history.js";
import { vendorBadge } from "../lib/direct-chat/model-picker.js";
import { filterTextConversations } from "../lib/direct-chat/studio.js";
import { directChatHistory, directChatScope, subscribeDirectChat } from "../lib/runtime.js";

export type ChatArchiveScreenProps = {
  onBack: () => void;
  onOpenConversation: (conversationId: string) => void;
  onRestored: () => void;
};

export function ChatArchiveScreen({ onBack, onOpenConversation, onRestored }: ChatArchiveScreenProps) {
  const { t } = useTranslation();
  const history = directChatHistory();
  const scope = directChatScope();
  const [rows, setRows] = useState<DirectChatSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!scope) {
        setRows([]);
        return;
      }
      const archived = await history.list(scope, { archived: true });
      if (!cancelled) setRows(filterTextConversations(archived));
    };
    void load();
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, scope]);

  async function restore(conversationId: string): Promise<void> {
    await history.setArchived(conversationId, false, new Date().toISOString());
    setRows(filterTextConversations(await history.list(scope!, { archived: true })));
    onRestored();
  }

  return (
    <Screen aurora>
      <NavBar solid title={t("chats.archiveTitle")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent className="pt-3">
        {rows.length === 0 ? (
          <EmptyState
            aurora={false}
            icon={<Archive className="h-9 w-9 stroke-[1.7]" aria-hidden="true" />}
            title={t("chats.archiveEmpty")}
          />
        ) : (
          <ListGroup>
            {rows.map((row) => {
              const badge = vendorBadge(null, row.conversation.nextModelId);
              return (
                <ListRow
                  key={row.conversation.id}
                  leading={
                    <span
                      aria-hidden="true"
                      className={`grid h-10 w-10 shrink-0 place-items-center rounded-[13px] text-[13px] font-extrabold text-white ${badge.gradientClass}`}
                    >
                      {badge.monogram}
                    </span>
                  }
                  title={row.conversation.title}
                  subtitle={
                    <span className="flex flex-col gap-1">
                      <span className="truncate">{row.preview}</span>
                      {row.conversation.nextModelId ? (
                        <span>
                          <Tag>{row.conversation.nextModelId}</Tag>
                        </span>
                      ) : null}
                    </span>
                  }
                  chevron
                  onClick={() => onOpenConversation(row.conversation.id)}
                  trailing={
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void restore(row.conversation.id);
                      }}
                      className="shrink-0 rounded-[10px] bg-[var(--rm-bg-surface-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--rm-link)] transition-transform active:scale-95"
                    >
                      {t("directChat.restore")}
                    </button>
                  }
                />
              );
            })}
          </ListGroup>
        )}
      </ScreenContent>
    </Screen>
  );
}
