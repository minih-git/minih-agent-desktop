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
import type { DirectChatSummary } from "../lib/direct-chat/history.js";
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
      if (!cancelled) setRows(archived);
    };
    void load();
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, scope]);

  async function restore(conversationId: string): Promise<void> {
    // Restoring from the archive is the action this screen exists for, so it
    // happens here rather than behind the info sheet.
    await history.setArchived(conversationId, false, new Date().toISOString());
    setRows(await history.list(scope!, { archived: true }));
    onRestored();
  }

  return (
    <Screen>
      <NavBar title={t("chats.archiveTitle")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent>
        {rows.length === 0 ? (
          <div className="px-4 pt-2">
            <EmptyState
              icon={<Archive className="h-9 w-9 stroke-[1.5]" aria-hidden="true" />}
              title={t("chats.archiveEmpty")}
            />
          </div>
        ) : (
          <ListGroup>
            {rows.map((row) => (
              <ListRow
                key={row.conversation.id}
                title={row.conversation.title}
                subtitle={<span className="truncate">{row.preview}</span>}
                chevron
                onClick={() => onOpenConversation(row.conversation.id)}
                trailing={
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void restore(row.conversation.id);
                    }}
                    className="shrink-0 rounded-[8px] px-2 py-1 text-[13px] text-[var(--rm-accent)]"
                  >
                    {t("directChat.restore")}
                  </button>
                }
              />
            ))}
          </ListGroup>
        )}
      </ScreenContent>
    </Screen>
  );
}
