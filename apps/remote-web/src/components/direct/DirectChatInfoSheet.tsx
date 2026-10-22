/**
 * The direct conversation's info sheet (ADR mobile-direct-gateway-chat §4).
 *
 * Everything a conversation can do to itself lives here, in one place, because
 * each action has a precondition the ADR states: a rename is manual and costs no
 * model call, a delete needs the reply stopped first, and a copy carries the
 * transcript and nothing else.
 *
 * The save location is stated in words ("this phone"), not implied: it is the one
 * promise the user cannot verify from the screen.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DirectChatTranscript } from "../../lib/direct-chat/history-store.js";
import { Button } from "../ui/Button.js";
import { Callout } from "../ui/Callout.js";
import { ListGroup, ListRow } from "../ui/ListGroup.js";
import { SectionHeader } from "../ui/SectionHeader.js";
import { Sheet } from "../ui/Sheet.js";

export type DirectChatInfoSheetProps = {
  open: boolean;
  onClose: () => void;
  transcript: DirectChatTranscript | null;
  /** Whether the conversation is idle; every destructive action needs it. */
  idle: boolean;
  onRename: (title: string) => Promise<void>;
  onTogglePin: () => Promise<void>;
  onArchive: () => Promise<void>;
  onCopy: () => Promise<boolean>;
  onDelete: () => Promise<boolean>;
};

export function DirectChatInfoSheet({
  open,
  onClose,
  transcript,
  idle,
  onRename,
  onTogglePin,
  onArchive,
  onCopy,
  onDelete,
}: DirectChatInfoSheetProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(transcript?.conversation.title ?? "");
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const conversation = transcript?.conversation ?? null;

  return (
    <Sheet open={open} onClose={onClose} title={t("directChat.info")}>
      <div className="max-h-[60dvh] overflow-y-auto">
        <SectionHeader title={t("directChat.infoSection")} />
        <ListGroup>
          <ListRow
            title={t("directChat.infoModel")}
            subtitle={<span className="break-all font-mono">{conversation?.nextModelId ?? t("chats.modelUnset")}</span>}
          />
          <ListRow
            title={t("directChat.infoGateway")}
            subtitle={
              <span className="break-all font-mono">{conversation?.scope.gatewayRoot ?? ""}</span>
            }
          />
          <ListRow title={t("directChat.infoStorage")} subtitle={t("settings.history.local")} />
        </ListGroup>

        <SectionHeader title={t("directChat.rename")} />
        <div className="flex items-center gap-2 px-1">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={t("directChat.rename")}
            className="min-w-0 flex-1 rounded-[10px] bg-[var(--rm-bg-inset)] px-3 py-2 text-[15px] text-[var(--rm-text-primary)] outline-none"
          />
          <Button
            variant="secondary"
            size="small"
            disabled={title.trim().length === 0 || title.trim() === conversation?.title}
            onClick={async () => {
              await onRename(title);
            }}
          >
            {t("common.save")}
          </Button>
        </div>

        <SectionHeader title={t("directChat.actions")} />
        <ListGroup>
          <ListRow
            title={conversation?.pinned ? t("directChat.unpin") : t("directChat.pin")}
            chevron
            onClick={() => {
              void onTogglePin();
            }}
          />
          <ListRow
            title={copied ? t("directChat.copied") : t("directChat.copy")}
            chevron
            onClick={async () => {
              setCopied(await onCopy());
            }}
          />
          <ListRow
            title={conversation?.archived ? t("directChat.restore") : t("directChat.archive")}
            chevron
            onClick={() => {
              void onArchive();
            }}
          />
          <ListRow
            title={<span className="text-[var(--rm-error)]">{t("directChat.delete")}</span>}
            chevron
            onClick={() => setConfirming(true)}
          />
        </ListGroup>
        {!idle ? (
          <div className="mt-2 px-1">
            <Callout>{t("directChat.stopFirst")}</Callout>
          </div>
        ) : null}
      </div>

      <Sheet open={confirming} onClose={() => setConfirming(false)} title={t("directChat.deleteTitle")}>
        <p className="px-1 pb-4 text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
          {t("directChat.deleteBody")}
        </p>
        <div className="flex flex-col gap-2">
          <Button
            variant="destructive"
            size="large"
            disabled={busy || !idle}
            onClick={async () => {
              setBusy(true);
              const removed = await onDelete();
              setBusy(false);
              if (removed) {
                setConfirming(false);
                onClose();
              }
            }}
          >
            {t("directChat.delete")}
          </Button>
          <Button variant="secondary" size="large" disabled={busy} onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>
    </Sheet>
  );
}
