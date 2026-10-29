import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReviewFocusRequest } from "../../lib/review-focus-request";
import { reviewChangesFromMessages, summarizeReviewChanges } from "../../lib/workspace-review";
import { useAppStore } from "../../stores/app-store";
import { IconDiff } from "../icons";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { WorkTabEmpty } from "./WorkTabEmpty";

let handledFocusSeq = 0;
type AppliedFocus = { sessionId: string; snapshotIds: ReadonlySet<string>; anchor: string; expand: boolean; seq: number };

export function ReviewTab() {
  const { t } = useTranslation();
  const messages = useAppStore((state) => state.messages);
  const sessionId = useAppStore((state) => state.activeSessionId);
  const focusRequest = useReviewFocusRequest();
  const entries = useMemo(() => {
    // A card in an older reading window already owns the durable evidence.
    // Keep newer live rows authoritative and never load/upload full history.
    const currentIds = new Set(messages.map((message) => message.id));
    const earlier = focusRequest && focusRequest.sessionId === sessionId
      ? focusRequest.messages.filter((message) => !currentIds.has(message.id))
      : [];
    return reviewChangesFromMessages(earlier.length ? [...earlier, ...messages] : messages);
  }, [messages, focusRequest, sessionId]);
  const summary = useMemo(() => summarizeReviewChanges(entries), [entries]);
  const [focus, setFocus] = useState<AppliedFocus | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRequest || focusRequest.sessionId !== sessionId || focusRequest.seq === handledFocusSeq) return;
    const wanted = new Set(focusRequest.snapshotIds);
    const anchor = entries.find((entry) => wanted.has(entry.change.snapshotId));
    if (!anchor) return;
    handledFocusSeq = focusRequest.seq;
    setFocus({ sessionId: focusRequest.sessionId, snapshotIds: wanted, anchor: anchor.change.snapshotId, expand: focusRequest.expand, seq: focusRequest.seq });
  }, [focusRequest, entries, sessionId]);
  useEffect(() => {
    if (!focus || focus.sessionId !== sessionId) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-snapshot-id="${CSS.escape(focus.anchor)}"]`);
    target?.scrollIntoView({ block: "start" });
    target?.querySelector<HTMLButtonElement>(".review-change-card-header")?.focus({ preventScroll: true });
  }, [focus, sessionId]);

  if (entries.length === 0) return <WorkTabEmpty icon={IconDiff} title={t("panel.review.noChanges")} />;
  return (
    <div className="review-tab">
      <div className="review-toolbar">
        <span className="review-summary">{t("panel.review.changes", { count: summary.changeCount })}</span>
        <span className="review-toolbar-counts diff-counts">
          <span className="diff-count-add">+{summary.additions}</span>
          <span className="diff-count-del">−{summary.deletions}</span>
        </span>
      </div>
      <div className="review-scroll" ref={scrollRef}>
        {entries.map((entry) => (
          <ReviewChangeCard key={entry.change.snapshotId} message={entry.message} compact
            openRequest={focus && focus.sessionId === sessionId && focus.expand && focus.snapshotIds.has(entry.change.snapshotId) ? focus.seq : undefined} />
        ))}
      </div>
    </div>
  );
}
