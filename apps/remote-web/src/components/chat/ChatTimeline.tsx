import { AlertCircle, Check, ChevronDown, ChevronUp, Clock, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { TimelineFailure, TimelineItem } from "../../lib/timeline-types.js";

export interface ChatTimelineProps {
  items: TimelineItem[];
  lastFailure?: TimelineFailure;
  pendingText?: string | null;
}

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

export function ChatTimeline({ items, lastFailure, pendingText }: ChatTimelineProps) {
  const { t } = useTranslation();
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => {
    setOpenItems((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (items.length === 0 && !pendingText && !lastFailure) {
    return (
      <div className="py-12 text-center text-[14px] text-[var(--rm-text-muted)]">
        {t("session.empty")}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3.5 py-4 list-none p-0 m-0">
      {items.map((item, idx) => {
        const isUser = item.role === "user";
        const isTool = item.itemType === "tool" || item.role === "tool";
        const isCompaction = item.itemType === "compaction" || item.role === "system";

        if (isCompaction) {
          return (
            <li
              key={item.id || idx}
              data-item-id={item.id}
              className="my-2 flex items-center gap-2.5 text-[12px] text-[var(--rm-text-muted)] before:h-px before:flex-1 before:bg-[var(--rm-separator)] after:h-px after:flex-1 after:bg-[var(--rm-separator)]"
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
              className={`self-end max-w-[85%] rounded-[18px_18px_6px_18px] px-3.5 py-2.5 text-[15px] leading-[22px] bg-[var(--rm-bg-bubble)] text-[var(--rm-text-primary)] break-words whitespace-pre-wrap ${
                isPending ? "opacity-60" : ""
              }`}
            >
              {renderInlineCode(item.text)}
              {isPending && (
                <div className="mt-1 flex items-center justify-end gap-1 text-[12px] text-[var(--rm-text-muted)]">
                  <Clock size={12} />
                  <span>{t("timeline.sending")}</span>
                </div>
              )}
            </li>
          );
        }

        if (isTool) {
          const toolKey = `tool-${item.id || idx}`;
          const isOpen = !!openItems[toolKey];
          return (
            <li
              key={item.id || idx}
              data-item-id={item.id}
              className={`rounded-xl border border-[var(--rm-separator)] bg-[var(--rm-bg-surface)] overflow-hidden ${
                item.isError ? "border-red-500/40" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => toggle(toolKey)}
                className="flex items-center gap-2.5 w-full p-2.5 min-h-[44px] text-left hover:bg-[var(--rm-bg-inset)]/40 transition-colors cursor-pointer"
                aria-expanded={isOpen}
              >
                <span className="sr-only">Tool </span>
                {item.status === "streaming" ? (
                  <Loader2 size={16} className="text-[var(--rm-running)] animate-spin shrink-0" />
                ) : item.isError ? (
                  <AlertCircle size={16} className="text-[var(--rm-error)] shrink-0" />
                ) : (
                  <Check size={16} className="text-[var(--rm-success)] stroke-[2.5] shrink-0" />
                )}
                <span className="font-mono text-[13px] font-semibold text-[var(--rm-text-primary)]">
                  {item.toolName || t("timeline.tool")}
                </span>
                <span className="flex-1 min-w-0 text-[13px] text-[var(--rm-text-secondary)] truncate">
                  {item.text}
                </span>
                {isOpen ? (
                  <ChevronUp size={16} className="text-[var(--rm-text-faint)] shrink-0" />
                ) : (
                  <ChevronDown size={16} className="text-[var(--rm-text-faint)] shrink-0" />
                )}
              </button>
              {isOpen && item.text && (
                <div className="m-2.5 mt-0 rounded-lg bg-[var(--rm-bg-inset)] p-2.5 font-mono text-[12px] leading-[18px] text-[var(--rm-text-secondary)] whitespace-pre overflow-x-auto max-h-[220px]">
                  {item.text}
                </div>
              )}
            </li>
          );
        }

        // Assistant / Agent response
        const thinkKey = `think-${item.id || idx}`;
        const isThinkOpen = !!openItems[thinkKey];
        return (
          <li key={item.id || idx} data-item-id={item.id} className="flex flex-col self-start max-w-[95%]">
            {item.agentName ? (
              <div className="mb-1 text-[12px] text-[var(--rm-text-muted)]">
                {t("timeline.agent", { agent: item.agentName })}
              </div>
            ) : null}
            {item.text ? (
              <div className="text-[15px] leading-[22px] text-[var(--rm-text-primary)] break-words whitespace-pre-wrap">
                {renderInlineCode(item.text)}
              </div>
            ) : null}
            {item.thinking ? (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => toggle(thinkKey)}
                  className="flex items-center gap-1 py-1 text-[13px] text-[var(--rm-text-muted)] hover:text-[var(--rm-text-secondary)] cursor-pointer"
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
        <li className="self-end max-w-[85%] rounded-[18px_18px_6px_18px] px-3.5 py-2.5 text-[15px] leading-[22px] bg-[var(--rm-bg-bubble)] text-[var(--rm-text-primary)] break-words whitespace-pre-wrap opacity-60">
          {renderInlineCode(pendingText)}
          <div className="mt-1 flex items-center justify-end gap-1 text-[12px] text-[var(--rm-text-muted)]">
            <Clock size={12} />
            <span>{t("timeline.sending")}</span>
          </div>
        </li>
      ) : null}

      {/* Turn Failure banner */}
      {lastFailure?.message ? (
        <li className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-[14px] leading-relaxed text-[var(--rm-error)]">
          {t("session.turn.failed", { reason: lastFailure.message })}
        </li>
      ) : null}
    </ul>
  );
}
