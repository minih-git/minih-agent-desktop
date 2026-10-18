/**
 * Plain-text transcript (PR-4).
 *
 * No markdown, no HTML: the H5 client renders the text the Host sent, which is
 * also why the CSP can stay at `script-src 'self'` without a sanitizer.
 */
import { useTranslation } from "react-i18next";

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
    <li
      className={`rounded-xl border p-3 ${
        mine
          ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
          : "border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900/60"
      } ${item.isError ? "border-red-300 dark:border-red-900" : ""}`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-700 dark:text-slate-200">{t(labelKey(item))}</span>
        {item.toolName ? <span className="app-mono">{item.toolName}</span> : null}
        {item.agentName ? <span>{t("timeline.agent", { agent: item.agentName })}</span> : null}
        {item.status === "streaming" ? <span aria-hidden="true">…</span> : null}
        {item.truncated ? <span>{t("timeline.truncated")}</span> : null}
      </div>
      {item.text ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.text}</p>
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
