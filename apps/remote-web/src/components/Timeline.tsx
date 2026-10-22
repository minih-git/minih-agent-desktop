/**
 * Plain-text transcript (PR-4; tool rows in rollout D).
 *
 * No markdown, no HTML: the H5 client renders the text the Host sent, which is
 * also why the CSP can stay at `script-src 'self'` without a sanitizer. A tool
 * row shows the tool's own name and the state the Host recorded, and its
 * arguments or result — a recorded call used to arrive as an unnamed, empty box
 * because history rows were projected without their tool fields.
 */
import { useTranslation } from "react-i18next";

import { Pill } from "./Chrome.js";
import type { TimelineItem } from "../lib/timeline.js";

function roleKey(role: TimelineItem["role"]): string {
  if (role === "user") return "timeline.you";
  if (role === "system") return "timeline.system";
  if (role === "tool") return "timeline.tool";
  return "timeline.assistant";
}

function labelKey(item: TimelineItem): string {
  if (item.itemType === "tool") return "timeline.tool";
  if (item.itemType === "compaction") return "timeline.compaction";
  return roleKey(item.role);
}

/** The state the Host recorded for a tool call, when it recorded one. */
function toolStateKey(item: TimelineItem): string | undefined {
  if (item.toolStatus === undefined) return undefined;
  return `timeline.toolStatus.${item.toolStatus}`;
}

function toolStateTone(status: TimelineItem["toolStatus"]): "ok" | "warn" | "bad" | "neutral" {
  if (status === "success") return "ok";
  if (status === "running") return "warn";
  if (status === "error" || status === "denied") return "bad";
  return "neutral";
}

export function TimelineView({ items }: { items: TimelineItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return <p className="px-1 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t("session.empty")}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <TimelineRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const { t } = useTranslation();
  const mine = item.role === "user";
  return (
    // `data-item-id` is how the scroll hook puts the row the reader was looking
    // at back where it was after older rows are inserted above (see
    // `useTimelineScroll`).
    <li
      data-item-id={item.id}
      // `[overflow-anchor:none]` keeps the engine from selecting this row as its
      // own anchor node: the position is restored by `useTimelineScroll`, which
      // is the same code on every engine (iOS WebKit has no anchoring at all).
      className={`[overflow-anchor:none] rounded-xl border p-3 ${
        mine
          ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
          : "border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900/60"
      } ${item.isError ? "border-red-300 dark:border-red-900" : ""}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-200">{t(labelKey(item))}</span>
        {item.toolName ? <span className="app-mono">{item.toolName}</span> : null}
        {item.agentName ? <span>{t("timeline.agent", { agent: item.agentName })}</span> : null}
        {item.sideNote ? <span>{t("timeline.sideNote")}</span> : null}
        {toolStateKey(item) ? (
          <Pill tone={toolStateTone(item.toolStatus)}>{t(toolStateKey(item) as string)}</Pill>
        ) : item.status === "streaming" ? (
          <span aria-hidden="true">…</span>
        ) : null}
        {item.truncated ? <span>{t("timeline.truncated")}</span> : null}
      </div>
      {item.text ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.text}</p>
      ) : null}
      {item.attachments && item.attachments.length > 0 ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {t("timeline.attachments", {
            count: item.attachments.length,
            names: item.attachments.map((attachment) => attachment.name).join(", "),
          })}
        </p>
      ) : null}
      {item.thinking ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">{t("timeline.thinking")}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-slate-300">
            {item.thinking}
          </p>
        </details>
      ) : null}
    </li>
  );
}
