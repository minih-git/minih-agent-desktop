/**
 * D4: archived direct conversations (ADR mobile-direct-gateway-chat §1, §4).
 *
 * The same rows as D1, with one difference that matters: restoring here puts a
 * conversation back in the list intact, and opening one goes to D3 with the
 * archive as its origin, so back returns here rather than to the root.
 *
 * Both kinds live here — text and image — because this is the only place an
 * archived image conversation can still be found and brought back once Studio
 * stops drawing archived work.
 */
import { Archive } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Callout } from "../components/ui/Callout.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Tag } from "../components/ui/StatusDot.js";
import type { DirectChatSummary } from "../lib/direct-chat/history.js";
import { scopeDependency } from "../lib/direct-chat/history-store.js";
import { vendorBadge } from "../lib/direct-chat/model-picker.js";
import { splitArchivedByKind } from "../lib/direct-chat/studio.js";
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
  /** The stable identity of the scope; the object itself is new on every render. */
  const scopeKeyValue = scopeDependency(scope);
  const [rows, setRows] = useState<DirectChatSummary[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const groups = splitArchivedByKind(rows);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!scope) {
        setRows([]);
        return;
      }
      const archived = await history.list(scope, { archived: true });
      // Both kinds: an archived image conversation is reachable nowhere else.
      if (!cancelled) setRows(archived);
    };
    void load();
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, scopeKeyValue]);

  async function restore(conversationId: string): Promise<void> {
    const outcome = await history.setArchived(conversationId, false, new Date().toISOString());
    const next = await history.list(scope!, { archived: true });
    setRows(next);
    onRestored();
    if (!outcome.ok) setFailure(t("directChat.saveFailed"));
  }

  /** One archived row: the same card in both sections, with its own kind label. */
  function renderRow(row: DirectChatSummary) {
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
  }

  return (
    <Screen aurora>
      <NavBar solid title={t("chats.archiveTitle")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent className="pt-3">
        {failure ? (
          <Callout tone="error" className="mb-3">
            {failure}
          </Callout>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState
            aurora={false}
            icon={<Archive className="h-9 w-9 stroke-[1.7]" aria-hidden="true" />}
            title={t("chats.archiveEmpty")}
          />
        ) : (
          <div className="space-y-4">
            {groups.text.length > 0 ? (
              <section>
                <SectionHeader title={t("chats.archiveText")} />
                <ListGroup>{groups.text.map(renderRow)}</ListGroup>
              </section>
            ) : null}
            {groups.images.length > 0 ? (
              <section>
                <SectionHeader title={t("chats.archiveImages")} />
                <ListGroup>{groups.images.map(renderRow)}</ListGroup>
              </section>
            ) : null}
          </div>
        )}
      </ScreenContent>
    </Screen>
  );
}
