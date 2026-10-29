import { useChatSessionCapability } from "../hooks/use-chat-session-capability";
import { memo, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ReviewChange,
  ReviewChangeStatus,
  UiMessage,
} from "@minih-agent/shared";
import {
  disclosureKey,
  useAutomaticDisclosure,
} from "../features/chat/transcript/disclosure";
import {
  opensProcessDetails,
  resolveTranscriptDensity,
} from "../lib/transcript-density";
import { reviewChangeFromMessage } from "../lib/workspace-review";
import { useAppStore } from "../stores/app-store";
import { useCopy } from "./Markdown";
import { cx, TooltipButton } from "./ui";
import { IconCheck, IconChevronRight, IconCopy, IconSnapshot } from "./icons";
/* Git-status letters carry the status without relying on color alone; the
   localized word stays in the row's accessible name. */
const STATUS_MARKS: Record<ReviewChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

function reviewDiffText(change: ReviewChange): string {
  return change.hunks
    .map((hunk) =>
      [
        hunk.header,
        ...hunk.lines.map((line) =>
          `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`,
        ),
      ].join("\n"),
    )
    .join("\n");
}

function DiffBody({ message, compact }: { message: UiMessage; compact: boolean }) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const rollback = useAppStore((state) => state.rollbackWorkspaceChange);
  const { copied, copy } = useCopy();
  const [rollingBack, setRollingBack] = useState(false);

  if (!change) return null;

  const diffText = reviewDiffText(change);

  const runRollback = async () => {
    if (!localToolsAllowed || !change.reversible || change.state === "rolledBack" || rollingBack) return;
    setRollingBack(true);
    // A conflict or an unavailable snapshot is already reported through the
    // store's toast; this card owns the rollback action only.
    await rollback(message.id, change.snapshotId);
    setRollingBack(false);
  };

  return (
    <div className="review-change-card-body-content">
      {change.binary ? (
        <div className="review-change-note">{t("panel.review.binary")}</div>
      ) : change.truncated ? (
        <div className="review-change-note">{t("panel.review.tooLarge")}</div>
      ) : change.hunks.length > 0 ? (
        <div className="review-change-diff">
          {change.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
              <div className="diff-line hunk">
                <span className="diff-line-text">{hunk.header}</span>
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <div className={cx("diff-line", line.type)} key={lineIndex}>
                  <span className="diff-line-sign" aria-hidden>
                    {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                  </span>
                  <span className="diff-line-text">{line.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="review-change-note">{t("panel.review.noLineDetails")}</div>
      )}

      <div className={cx("review-change-card-actions", compact && "is-compact")}>
        {change.state === "rolledBack" ? (
          <span className="review-change-state is-rolled-back">
            <IconCheck size={13} />
            {t("panel.review.rolledBack")}
          </span>
        ) : change.reversible && localToolsAllowed ? (
          <button
            type="button"
            className="review-change-rollback"
            onClick={() => void runRollback()}
            disabled={rollingBack}
          >
            <IconSnapshot size={13} />
            {rollingBack
              ? t("panel.review.rollingBack")
              : t("panel.review.rollback")}
          </button>
        ) : (
          <span className="review-change-rollback-note">
            {t("panel.review.rollbackUnavailable")}
          </span>
        )}
        <TooltipButton
          type="button"
          className={cx("review-change-copy", copied && "copied")}
          tooltip={copied ? t("chat.copied") : t("chat.copy")}
          ariaLabel={t("chat.copy")}
          onClick={() => copy(diffText)}
          disabled={!diffText}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? t("chat.copied") : t("chat.copy")}
        </TooltipButton>
      </div>
    </div>
  );
}

export const ReviewChangeCard = memo(function ReviewChangeCard({
  message,
  compact = false,
  asToolRow = false,
  autoOpen,
  openRequest,
  onUserInteraction,
}: {
  message: UiMessage;
  compact?: boolean;
  /** The card is the tool-level row: one file header and its diff body. */
  asToolRow?: boolean;
  autoOpen?: boolean;
  /** One-time Review navigation; a later user collapse still wins. */
  openRequest?: number;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const change = reviewChangeFromMessage(message);
  const detailsId = useId();
  const defaultOpen = useAppStore((state) =>
    asToolRow ? opensProcessDetails(resolveTranscriptDensity(state.settings)) : false,
  );
  const disclosure = useAutomaticDisclosure(
    autoOpen ?? defaultOpen,
    openRequest,
    asToolRow ? disclosureKey("review", message.id) : undefined,
  );
  const { open, toggle: toggleDisclosure, titleRef } = disclosure;
  if (!change) return null;

  const statusLabel = t(`panel.review.status.${change.status}`);
  const baseLabel = t(open ? "chat.reviewChangeHide" : "chat.reviewChangeShow", {
    status: statusLabel,
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
  });
  // The collapsed row shows a rolled-back change struck through, so the state
  // has to reach the accessible name too.
  const accessibleLabel =
    change.state === "rolledBack"
      ? `${baseLabel} · ${t("panel.review.rolledBack")}`
      : baseLabel;

  return (
    <section
      className={cx(
        "review-change-card",
        compact && "is-compact",
        asToolRow && "is-tool-row",
        open && "open",
      )}
      data-state={change.state}
      data-status={change.status}
      data-message-id={asToolRow ? message.id : undefined}
      data-snapshot-id={change.snapshotId}
    >
      <button
        type="button"
        ref={titleRef}
        className="review-change-card-header"
        aria-expanded={open}
        aria-controls={detailsId}
        aria-label={accessibleLabel}
        title={accessibleLabel}
        onClick={() => {
          onUserInteraction?.();
          toggleDisclosure();
        }}
      >
        <span className="review-change-card-caret" aria-hidden>
          <IconChevronRight size={11} />
        </span>
        <span
          className={cx("review-change-card-mark", `is-${change.status}`)}
          aria-hidden
        >
          {STATUS_MARKS[change.status]}
        </span>
        <span className="review-change-card-path" title={change.path}>
          {change.path}
        </span>
        <span
          className="review-change-card-counts diff-counts"
          aria-label={t("chat.reviewChangeCounts", change)}
        >
          {change.additions > 0 && (
            <span className="diff-count-add">+{change.additions}</span>
          )}
          {change.deletions > 0 && (
            <span className="diff-count-del">−{change.deletions}</span>
          )}
        </span>
      </button>
      {open ? (
        <div className="review-change-card-body" id={detailsId}>
          <DiffBody message={message} compact={compact} />
        </div>
      ) : null}
    </section>
  );
});
