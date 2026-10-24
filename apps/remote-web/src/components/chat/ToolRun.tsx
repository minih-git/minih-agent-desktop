/**
 * Tool runs collapsed into the prototype's `<details>` glass cards with a
 * status icon (spec §15.11, ADR mobile-redesign §3 Stage 5).
 *
 * The classification, the summary and the burst summary come from
 * `@minih-agent/shared` — the same functions the desktop transcript uses — so a
 * phone and a desktop describe one call identically.
 */
import {
  describeToolRun,
  getToolAction,
  getToolDisplayName,
  getToolSummary,
  summarizeToolRun,
  toolIconCategory,
  type ToolIconCategory,
} from "@minih-agent/shared";
import {
  AlertCircle,
  Check,
  ChevronDown,
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
import { useTranslation } from "react-i18next";

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

function isTool(item: TimelineItem): boolean {
  return item.itemType === "tool" || item.role === "tool";
}

function toolState(item: TimelineItem): ToolState {
  if (item.toolStatus) return item.toolStatus;
  if (item.status === "streaming") return "running";
  return item.isError ? "error" : "success";
}

function StatusMark({ state }: { state: ToolState }) {
  if (state === "running") {
    return (
      <Loader2
        size={15}
        className="shrink-0 animate-spin text-[var(--rm-running)]"
        aria-hidden="true"
      />
    );
  }
  if (state === "error") {
    return <AlertCircle size={15} className="shrink-0 text-[var(--rm-error)]" aria-hidden="true" />;
  }
  if (state === "denied") {
    return (
      <AlertCircle size={15} className="shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
    );
  }
  return (
    <Check
      size={15}
      className="shrink-0 stroke-[2.5] text-[var(--rm-success)]"
      aria-hidden="true"
    />
  );
}

/** The one-line summary: what the call acted on, never its output. */
function summaryOf(item: TimelineItem): string {
  return getToolSummary(item.toolName, item.toolArgs) || getToolDisplayName(item.toolName);
}

/**
 * A single tool call or a burst of consecutive tool calls (and any silent
 * thinking steps between them), collapsed into a `<details>` card with a status
 * icon.
 */
export function ToolRun({ items, active }: { items: TimelineItem[]; active: boolean }) {
  const { t } = useTranslation();

  const toolItems = items.filter(isTool);
  const summary = summarizeToolRun(
    items.map((item) =>
      isTool(item)
        ? {
            action: getToolAction(item.toolName),
            failed: toolState(item) === "error" || toolState(item) === "denied",
          }
        : { action: "thinking" as const },
    ),
  );
  const grouped = toolItems.length > 1;
  const parts = describeToolRun(summary);
  const label =
    parts.length > 1
      ? parts.map((part) => t(`timeline.run.${part.key}`, { count: part.count })).join(", ")
      : t(`timeline.run.${summary.key}`, { count: summary.count });

  if (!grouped) {
    const item = toolItems[0];
    if (!item) return null;
    const Icon = toolIcon(item.toolName);
    const state = toolState(item);
    return (
      <details
        data-item-id={item.id}
        className="my-1 w-full min-w-0 overflow-hidden rounded-[14px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] backdrop-blur-md"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[14px] leading-[18px] text-[var(--rm-text-secondary)] [&::-webkit-details-marker]:hidden">
          <StatusMark state={state} />
          <Icon size={15} className="shrink-0 text-[var(--rm-text-muted)]" aria-hidden="true" />
          <span className="shrink-0 font-medium text-[var(--rm-text-primary)]">
            {getToolDisplayName(item.toolName) || t("timeline.tool")}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--rm-text-muted)]">
            {summaryOf(item)}
          </span>
          <ChevronDown
            size={14}
            className="shrink-0 text-[var(--rm-text-faint)]"
            aria-hidden="true"
          />
        </summary>
        {item.text ? (
          <pre className="m-0 max-h-[220px] overflow-x-auto whitespace-pre border-t border-[var(--rm-hair)] bg-[var(--rm-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--rm-text-muted)]">
            {item.text}
          </pre>
        ) : (
          <div className="border-t border-[var(--rm-hair)] bg-[var(--rm-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--rm-text-muted)]">
            {summaryOf(item)}
          </div>
        )}
      </details>
    );
  }

  const burstState: ToolState = active
    ? "running"
    : summary.failures > 0
      ? "error"
      : "success";

  return (
    <details className="my-1 w-full min-w-0 overflow-hidden rounded-[14px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] backdrop-blur-md">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[14px] leading-[18px] text-[var(--rm-text-secondary)] [&::-webkit-details-marker]:hidden">
        <StatusMark state={burstState} />
        <Wrench size={15} className="shrink-0 text-[var(--rm-text-muted)]" aria-hidden="true" />
        <span
          className={`min-w-0 flex-1 truncate font-medium ${
            active ? "text-[var(--rm-running)]" : "text-[var(--rm-text-primary)]"
          }`}
        >
          {label}
        </span>
        {summary.failures > 0 ? (
          <span className="shrink-0 text-[12px] leading-[16px] text-[var(--rm-error)]">
            {t("timeline.run.failures", { count: summary.failures })}
          </span>
        ) : null}
        <ChevronDown
          size={14}
          className="shrink-0 text-[var(--rm-text-faint)]"
          aria-hidden="true"
        />
      </summary>
      <ul className="m-0 list-none space-y-1.5 border-t border-[var(--rm-hair)] bg-[var(--rm-code-bg)] px-3 py-2 font-mono text-[12px] leading-[1.6] text-[var(--rm-text-muted)]">
        {toolItems.map((item, index) => {
          const key = item.id || String(index);
          const Icon = toolIcon(item.toolName);
          return (
            <li key={key} data-item-id={item.id} className="min-w-0">
              <div className="flex items-center gap-2">
                <Icon
                  size={13}
                  className="shrink-0 text-[var(--rm-text-muted)]"
                  aria-hidden="true"
                />
                <span className="shrink-0 font-sans text-[12px] font-medium text-[var(--rm-text-secondary)]">
                  {getToolDisplayName(item.toolName) || t("timeline.tool")}
                </span>
                <span className="min-w-0 flex-1 truncate">{summaryOf(item)}</span>
                <StatusMark state={toolState(item)} />
              </div>
              {item.text ? (
                <pre className="mt-1 mb-0.5 max-h-[180px] overflow-x-auto whitespace-pre rounded-lg bg-[var(--rm-bg-surface)] p-2 font-mono text-[11px] leading-[1.5] text-[var(--rm-text-secondary)]">
                  {item.text}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
