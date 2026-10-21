/**
 * One tool call as a phone row: an icon for what it did, one line of what it
 * acted on, and its output only after a second tap (spec §15.11).
 *
 * The row is deliberately not a card per call. A burst of thirty calls used to
 * be thirty bordered cards, each printing the raw tool name and a truncated
 * copy of the tool's own output, which is both the widest and the least
 * informative thing on the screen. The classification, the summary and the
 * burst summary come from `@minih-agent/shared` — the same functions the
 * desktop transcript uses — so a phone and a desktop describe one call
 * identically.
 */
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  describeToolRun,
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  summarizeToolRun,
  toolIconCategory,
  type ToolIconCategory,
} from "@minih-agent/shared";

import type { TimelineItem } from "../../lib/timeline-types.js";

const ICONS: Record<ToolIconCategory, LucideIcon> = {
  read: FileText,
  list: FolderOpen,
  search: Search,
  write: Pencil,
  edit: Pencil,
  run: Terminal,
  fetch: Globe,
  delegate: Users,
  todo: ListChecks,
  tool: Wrench,
};

/** The icon a tool call draws, by the category the shared rules assign it. */
export function toolIcon(toolName: string | undefined): LucideIcon {
  return ICONS[toolIconCategory(toolName)];
}

type ToolState = "running" | "error" | "denied" | "success";

function toolState(item: TimelineItem): ToolState {
  if (item.toolStatus) return item.toolStatus;
  if (item.status === "streaming") return "running";
  return item.isError ? "error" : "success";
}

function StatusMark({ state }: { state: ToolState }) {
  if (state === "running") {
    return <Loader2 size={14} className="shrink-0 animate-spin text-[var(--rm-running)]" aria-hidden="true" />;
  }
  if (state === "error") {
    return <AlertCircle size={14} className="shrink-0 text-[var(--rm-error)]" aria-hidden="true" />;
  }
  if (state === "denied") {
    return <AlertCircle size={14} className="shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />;
  }
  return <Check size={14} className="shrink-0 stroke-[2.5] text-[var(--rm-success)]" aria-hidden="true" />;
}

/** The one-line summary: what the call acted on, never its output. */
function summaryOf(item: TimelineItem): string {
  return getToolSummary(item.toolName, item.toolArgs) || getToolDisplayName(item.toolName);
}

/**
 * A burst of consecutive tool calls, folded into one row.
 *
 * Collapsed it says what the burst did ("5 commands"); expanded it lists each
 * call, and each of those expands once more to its output. Two taps is the
 * right depth for a phone: the first answers "what happened here", the second
 * "show me that one".
 */
export function ToolRun({ items, active }: { items: TimelineItem[]; active: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});
  const summary = summarizeToolRun(
    items.map((item) => ({
      action: getToolAction(item.toolName),
      failed: toolState(item) === "error" || toolState(item) === "denied",
    })),
  );
  const grouped = items.length > 1;
  // "5 commands, 2 files edited" rather than one category: a phone row is one
  // line, and the mix is what the reader is asking about.
  const parts = describeToolRun(summary);
  const label =
    parts.length > 1
      ? parts.map((part) => t(`timeline.run.${part.key}`, { count: part.count })).join(", ")
      : t(`timeline.run.${summary.key}`, { count: summary.count });

  const rows = items.map((item, index) => {
    const key = item.id || String(index);
    const expanded = openItems[key] === true;
    const Icon = toolIcon(item.toolName);
    return (
      <li key={key} data-item-id={item.id} className="min-w-0">
        <button
          type="button"
          onClick={() => setOpenItems((current) => ({ ...current, [key]: !expanded }))}
          className="flex min-h-[32px] w-full items-center gap-2 py-1 text-left active:opacity-60"
          aria-expanded={expanded}
        >
          <Icon size={14} className="shrink-0 text-[var(--rm-text-muted)]" aria-hidden="true" />
          <span className="shrink-0 text-[13px] text-[var(--rm-text-secondary)]">
            {getToolDisplayName(item.toolName) || t("timeline.tool")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--rm-text-muted)]">
            {summaryOf(item)}
          </span>
          <StatusMark state={toolState(item)} />
          {item.text ? (
            expanded ? (
              <ChevronDown size={13} className="shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
            )
          ) : null}
        </button>
        {expanded && item.text ? (
          <pre className="mb-2 max-h-[220px] overflow-x-auto whitespace-pre rounded-lg bg-[var(--rm-bg-inset)] p-2.5 font-mono text-[12px] leading-[18px] text-[var(--rm-text-secondary)]">
            {item.text}
          </pre>
        ) : null}
      </li>
    );
  });

  if (!grouped) return <ul className="m-0 list-none p-0">{rows}</ul>;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-[32px] w-full items-center gap-2 py-1 text-left active:opacity-60"
        aria-expanded={open}
      >
        <Wrench size={14} className="shrink-0 text-[var(--rm-text-muted)]" aria-hidden="true" />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            active ? "text-[var(--rm-running)]" : "text-[var(--rm-text-secondary)]"
          }`}
        >
          {label}
        </span>
        {summary.failures > 0 ? (
          <span className="shrink-0 text-[12px] text-[var(--rm-error)]">
            {t("timeline.run.failures", { count: summary.failures })}
          </span>
        ) : null}
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
        )}
      </button>
      {open ? <ul className="m-0 list-none border-l border-[var(--rm-separator)] pl-2.5">{rows}</ul> : null}
    </div>
  );
}
