import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ReviewChangeStatus, UiMessage } from "@minih-agent/shared";
import { Button, cx } from "../../../components/ui";
import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { requestReviewFocus } from "../../../lib/review-focus-request";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { summarizeTurnChanges, TURN_CHANGES_RELAXED_LIMIT, TURN_CHANGES_VISIBLE_LIMIT } from "../../../lib/turn-changed-files";
import { toolWorkPanelTab } from "../../../lib/work-panel-tabs";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
import { useAppStore } from "../../../stores/app-store";
import "../../../styles/turn-changes.css";

const STATUS_MARKS: Record<ReviewChangeStatus, string> = { added: "A", modified: "M", deleted: "D" };
function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="turn-changes-counts diff-counts" aria-hidden>
    {additions > 0 && <span className="diff-count-add">+{additions}</span>}
    {deletions > 0 && <span className="diff-count-del">−{deletions}</span>}
  </span>;
}

/** Read-only evidence for the completed turn, linked to the existing Review. */
export const TurnChangesCard = memo(function TurnChangesCard({ tools }: { tools: readonly UiMessage[] }) {
  const { t } = useTranslation();
  const sessionId = useSlotSessionId();
  const canReview = useChatSessionCapability("canUseLocalTools");
  const openTabForSession = useAppStore((state) => state.openWorkPanelTabForSession);
  const summary = useMemo(() => summarizeTurnChanges(tools), [tools]);
  const { files } = summary;
  if (files.length === 0) return null;
  const dense = files.length > TURN_CHANGES_RELAXED_LIMIT;
  const visible = files.slice(0, TURN_CHANGES_VISIBLE_LIMIT);
  const hidden = files.length - visible.length;
  const openReview = (snapshotIds: readonly string[], expand: boolean) => {
    const wanted = new Set(snapshotIds);
    const messages = tools.filter((message) => {
      const change = reviewChangeFromMessage(message);
      return change !== null && wanted.has(change.snapshotId);
    });
    requestReviewFocus(snapshotIds, { sessionId, messages, expand });
    openTabForSession(sessionId, toolWorkPanelTab("review"));
  };
  return <section className="turn-changes-card" aria-label={t("chat.turnChangesLabel")}>
    <div className="turn-changes-head">
      <span className="turn-changes-title">{t("chat.turnChangesTitle")}</span>
      <span className="turn-changes-meta">
        {t("chat.toolChipFiles", { count: files.length })}
        {dense ? ` · ${t("chat.turnChangesDirs", { count: summary.directoryCount })}` : null}
      </span>
      <span className="turn-changes-total" aria-label={t("chat.reviewChangeCounts", summary)}>
        <Counts additions={summary.additions} deletions={summary.deletions} />
      </span>
    </div>
    <ul className={cx("turn-changes-body", dense && "is-dense")}>
      {visible.map((file) => {
        const base = t("chat.turnChangesOpen", { status: t(`panel.review.status.${file.status}`), path: file.path, additions: file.additions, deletions: file.deletions });
        const label = file.rolledBack ? `${base} · ${t("panel.review.rolledBack")}` : base;
        return <li key={file.path}>
          <Button variant="ghost" type="button" className="turn-changes-row" data-status={file.status}
            data-rolled-back={file.rolledBack || undefined} aria-label={label} title={label}
            disabled={!canReview}
            onClick={() => openReview(file.snapshotIds, true)}>
            <span className="turn-changes-mark" aria-hidden>{STATUS_MARKS[file.status]}</span>
            <span className="turn-changes-path">{file.path}</span>
            <Counts additions={file.additions} deletions={file.deletions} />
          </Button>
        </li>;
      })}
      {hidden > 0 && <li className="turn-changes-more"><span aria-hidden>···</span>{t("chat.turnChangesMore", { count: hidden })}</li>}
    </ul>
    {hidden > 0 && <div className="turn-changes-foot">
      <Button variant="ghost" type="button" className="turn-changes-view-all"
        disabled={!canReview}
        onClick={() => openReview(files.flatMap((file) => file.snapshotIds), false)}>
        {t("chat.turnChangesViewAll", { count: files.length })}
      </Button>
    </div>}
  </section>;
});
