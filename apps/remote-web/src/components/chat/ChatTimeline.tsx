import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { groupConsecutiveToolRuns } from "@minih-agent/shared";

import type { TimelineFailure, TimelineItem } from "../../lib/timeline-types.js";
import { ToolRun } from "./ToolRun.js";

export interface ChatTimelineProps {
  items: TimelineItem[];
  lastFailure?: TimelineFailure;
  pendingText?: string | null;
}

/*
  `react-markdown` hands every custom component its own hast `node` alongside
  the DOM props. Destructuring it out is not cosmetic: spreading it writes
  `node="[object Object]"` into the markup. A table needs a scroll container on
  a phone, because `.rm-prose` cannot clip a wide one on its own.
*/
type MarkdownTableProps = ComponentProps<"table"> & { node?: unknown };

const markdownComponents = {
  table: ({ children, node: _node, ...props }: MarkdownTableProps) => (
    <div className="rm-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
};

function renderInlineCode(text: string) {
  const parts = text.split(/`([^`]+)`/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code
        key={i}
        className="rounded px-1.5 py-0.5 font-mono text-[13px] bg-[var(--rm-bg-inset)] text-[var(--rm-link)]"
      >
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** Whether a row is a tool call (the desktop's own test, kept in one place). */
function isToolItem(item: TimelineItem): boolean {
  return item.itemType === "tool" || item.role === "tool";
}

function isThinkingOnlyItem(item: TimelineItem): boolean {
  if (isToolItem(item)) return false;
  if (item.itemType === "compaction" || item.role === "system" || item.role === "user") return false;
  return !item.text.trim() && Boolean(item.thinking?.trim());
}

function isEmptyAssistantPlaceholder(item: TimelineItem): boolean {
  if (isToolItem(item)) return false;
  if (item.itemType === "compaction" || item.role === "system" || item.role === "user") return false;
  return !item.text.trim() && !item.thinking?.trim();
}

export function ChatTimeline({ items, lastFailure, pendingText }: ChatTimelineProps) {
  const { t } = useTranslation();
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => {
    setOpenItems((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Drop empty assistant placeholders first so they never split consecutive tool calls.
  const visibleItems = items.filter((item) => !isEmptyAssistantPlaceholder(item));

  /**
   * Rows in the order the timeline draws them: consecutive tool calls and any
   * silent thinking steps between them become one `ToolRun`, while everything
   * else stays its own row.
   */
  const rows = groupConsecutiveToolRuns(visibleItems, (item) =>
    isToolItem(item) ? "tool" : isThinkingOnlyItem(item) ? "thinking" : "other",
  );

  if (visibleItems.length === 0 && !pendingText && !lastFailure) {
    return (
      <div className="py-12 text-center text-[14px] text-[var(--rm-text-muted)]">
        {t("session.empty")}
      </div>
    );
  }

  return (
    <ul className="flex flex-col py-3 list-none p-0 m-0">
      {rows.map((row, rowIndex) => {
        const prevRow = rowIndex > 0 ? rows[rowIndex - 1] : undefined;
        const prevIsUser =
          prevRow?.kind === "single" && visibleItems[prevRow.index]?.role === "user";
        const prevIsToolRun =
          prevRow?.kind === "run" &&
          visibleItems.slice(prevRow.start, prevRow.end).some(isToolItem);

        if (row.kind === "run") {
          const burst = visibleItems.slice(row.start, row.end);
          const hasTools = burst.some(isToolItem);
          if (hasTools) {
            const topGap = rowIndex === 0 ? "" : prevIsToolRun ? "mt-0 " : prevIsUser ? "mt-2 " : "mt-0.5 ";
            return (
              <li
                key={`run-${burst[0]?.id ?? row.start}`}
                className={`${topGap}flex flex-col self-start max-w-[95%]`}
              >
                <ToolRun items={burst} active={burst.some((entry) => entry.status === "streaming")} />
              </li>
            );
          }
          // A run of only thinking steps (no tool calls yet) renders its latest thinking toggle.
          const item = burst[burst.length - 1]!;
          const thinkKey = `think-${item.id || row.start}`;
          const isThinkOpen = !!openItems[thinkKey];
          const topGap = rowIndex === 0 ? "" : prevIsUser ? "mt-2.5 " : "mt-1 ";
          return (
            <li
              key={item.id || row.start}
              data-item-id={item.id}
              className={`${topGap}flex flex-col self-start max-w-[95%]`}
            >
              <button
                type="button"
                onClick={() => toggle(thinkKey)}
                className="flex items-center gap-1 py-0.5 text-[13px] leading-[18px] text-[var(--rm-text-muted)] hover:text-[var(--rm-text-secondary)] cursor-pointer"
                aria-expanded={isThinkOpen}
              >
                <span>{t("timeline.thinking")}</span>
                {isThinkOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              {isThinkOpen && item.thinking ? (
                <div className="my-1 border-l-2 border-[var(--rm-separator)] pl-3 text-[13px] leading-[20px] text-[var(--rm-text-muted)] whitespace-pre-wrap break-words">
                  {item.thinking}
                </div>
              ) : null}
            </li>
          );
        }

        const idx = row.index;
        const item = visibleItems[idx];
        const isUser = item.role === "user";
        const isCompaction = item.itemType === "compaction" || item.role === "system";

        if (isCompaction) {
          return (
            <li
              key={item.id || idx}
              data-item-id={item.id}
              className="my-2.5 flex items-center gap-2.5 text-[12px] text-[var(--rm-text-muted)] before:h-px before:flex-1 before:bg-[var(--rm-separator)] after:h-px after:flex-1 after:bg-[var(--rm-separator)]"
            >
              <span>
                {item.text || t(item.itemType === "compaction" ? "timeline.compaction" : "timeline.system")}
              </span>
            </li>
          );
        }

        if (isUser) {
          const isPending = item.status === "streaming";
          return (
            <li
              key={item.id || idx}
              data-item-id={item.id}
              className={`${rowIndex > 0 ? "mt-3.5 " : ""}self-end max-w-[85%] rounded-[18px_18px_6px_18px] px-3.5 py-2.5 text-[15px] leading-[22px] bg-[var(--rm-bg-bubble)] border border-[var(--rm-bubble-border)] text-[var(--rm-text-primary)] break-words whitespace-pre-wrap ${
                isPending ? "opacity-60" : ""
              }`}
            >
              {item.text ? renderInlineCode(item.text) : null}
              {item.attachments && item.attachments.length > 0 ? (
                <div className={`${item.text ? "mt-1.5 " : ""}text-[12px] leading-[16px] text-[var(--rm-text-secondary)]`}>
                  {t("timeline.attachments", {
                    count: item.attachments.length,
                    names: item.attachments.map((attachment) => attachment.name).join(", "),
                  })}
                </div>
              ) : null}
              {isPending && (
                <div className="mt-1 flex items-center justify-end gap-1 text-[12px] text-[var(--rm-text-muted)]">
                  <Clock size={12} />
                  <span>{t("timeline.sending")}</span>
                </div>
              )}
            </li>
          );
        }

        // Assistant / Agent response
        const thinkKey = `think-${item.id || idx}`;
        const isThinkOpen = !!openItems[thinkKey];
        const topGap =
          rowIndex === 0 ? "" : prevIsUser ? "mt-2.5 " : prevIsToolRun ? "mt-0.5 " : "mt-1.5 ";
        return (
          <li
            key={item.id || idx}
            data-item-id={item.id}
            className={`${topGap}flex flex-col self-start max-w-[95%]`}
          >
            {item.agentName ? (
              <div className="mb-0.5 text-[12px] text-[var(--rm-text-muted)]">
                {t("timeline.agent", { agent: item.agentName })}
              </div>
            ) : null}
            {item.text ? (
              <div className="rm-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {item.text}
                </ReactMarkdown>
              </div>
            ) : null}
            {item.thinking ? (
              <div className={item.text ? "mt-1" : ""}>
                <button
                  type="button"
                  onClick={() => toggle(thinkKey)}
                  className="flex items-center gap-1 py-0.5 text-[13px] leading-[18px] text-[var(--rm-text-muted)] hover:text-[var(--rm-text-secondary)] cursor-pointer"
                  aria-expanded={isThinkOpen}
                >
                  <span>{t("timeline.thinking")}</span>
                  {isThinkOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                {isThinkOpen && (
                  <div className="my-1 border-l-2 border-[var(--rm-separator)] pl-3 text-[13px] leading-[20px] text-[var(--rm-text-muted)] whitespace-pre-wrap break-words">
                    {item.thinking}
                  </div>
                )}
              </div>
            ) : null}
          </li>
        );
      })}

      {/* Optimistic pending message if provided */}
      {pendingText ? (
        <li className="mt-3.5 self-end max-w-[85%] rounded-[18px_18px_6px_18px] px-3.5 py-2.5 text-[15px] leading-[22px] bg-[var(--rm-bg-bubble)] border border-[var(--rm-bubble-border)] text-[var(--rm-text-primary)] break-words whitespace-pre-wrap opacity-60">
          {renderInlineCode(pendingText)}
          <div className="mt-1 flex items-center justify-end gap-1 text-[12px] text-[var(--rm-text-muted)]">
            <Clock size={12} />
            <span>{t("timeline.sending")}</span>
          </div>
        </li>
      ) : null}

      {/* Turn Failure banner */}
      {lastFailure?.message ? (
        <li className="mt-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-[14px] leading-relaxed text-[var(--rm-error)]">
          {t("session.turn.failed", { reason: lastFailure.message })}
        </li>
      ) : null}
    </ul>
  );
}
