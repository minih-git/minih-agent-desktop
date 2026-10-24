import { Check, ChevronDown, ChevronUp, Clock, Code, Copy, ExternalLink, Globe, ImageOff, Maximize2, Pencil, RotateCcw, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { groupConsecutiveToolRuns } from "@minih-agent/shared";

import {
  clampFrameHeight,
  HTML_FRAME_DEFAULT_HEIGHT,
  readFrameHeight,
  withHeightReporting,
} from "../../lib/html-frame.js";
import type { TimelineFailure, TimelineItem } from "../../lib/timeline-types.js";
import { describeTurnFailure } from "../../lib/turn-failure.js";
import { ToolRun } from "./ToolRun.js";
import { MediaViewer, type MediaViewerItem } from "../ui/MediaViewer.js";
import type { SessionMediaState } from "../../lib/session-media.js";

export interface ChatTimelineProps {
  items: TimelineItem[];
  lastFailure?: TimelineFailure;
  pendingText?: string | null;
  resolveMedia?: (mediaId: string, name?: string) => Promise<MediaViewerItem | SessionMediaState | null>;
  onCopyMessage?: (item: TimelineItem) => void;
  onRegenerateMessage?: (item: TimelineItem) => void;
  onEditResendMessage?: (item: TimelineItem) => void;
}

type MediaEntry =
  | { kind: "ready"; item: MediaViewerItem }
  | { kind: "unsupported"; id: string }
  | { kind: "deleted"; id: string }
  | { kind: "changed"; id: string }
  | { kind: "forbidden"; id: string }
  | { kind: "failed"; id: string };

function MediaThumbnails({
  mediaIds,
  resolveMedia,
  onOpenViewer,
}: {
  mediaIds?: readonly string[];
  resolveMedia?: (mediaId: string, name?: string) => Promise<MediaViewerItem | SessionMediaState | null>;
  onOpenViewer: (items: MediaViewerItem[], index: number) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MediaEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!mediaIds || mediaIds.length === 0 || !resolveMedia) {
      setEntries([]);
      return;
    }

    setLoading(true);
    Promise.all(
      mediaIds.map(async (id): Promise<MediaEntry | null> => {
        try {
          const res = await resolveMedia(id);
          if (!res) return { kind: "deleted", id };
          if ("kind" in res) {
            if (res.kind === "ready") return { kind: "ready", item: res.item };
            return { kind: res.kind, id };
          }
          return { kind: "ready", item: res };
        } catch {
          return { kind: "failed", id };
        }
      }),
    ).then((results) => {
      if (!cancelled) {
        setEntries(results.filter((r): r is MediaEntry => r !== null));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [mediaIds, resolveMedia]);

  if (loading) {
    return (
      <div className="mt-2 flex gap-1.5">
        <div className="h-24 w-24 animate-pulse rounded-xl bg-[var(--rm-bg-inset)]" />
      </div>
    );
  }

  if (entries.length === 0) return null;

  const readyItems = entries.filter((e): e is { kind: "ready"; item: MediaViewerItem } => e.kind === "ready").map((e) => e.item);
  const statusEntries = entries.filter((e) => e.kind !== "ready");

  const count = readyItems.length;
  const gridClass =
    count === 1
      ? "flex max-w-[280px]"
      : count <= 4
        ? "grid grid-cols-2 gap-1.5 max-w-[320px]"
        : "grid grid-cols-3 gap-1.5 max-w-[340px]";

  function statusLabel(kind: MediaEntry["kind"]): string {
    switch (kind) {
      case "unsupported":
        return t("timeline.mediaUnsupported");
      case "deleted":
        return t("timeline.mediaDeleted");
      case "changed":
        return t("timeline.mediaChanged");
      case "forbidden":
        return t("timeline.mediaForbidden");
      default:
        return t("timeline.mediaFailed");
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      {readyItems.length > 0 ? (
        <div className={gridClass}>
          {readyItems.map((item, idx) => (
            <button
              key={item.id || idx}
              type="button"
              onClick={() => onOpenViewer(readyItems, idx)}
              className="group relative overflow-hidden rounded-xl bg-[var(--rm-bg-inset)] border border-[var(--rm-bubble-border)] focus:outline-none focus:ring-2 focus:ring-[var(--rm-accent)] active:opacity-90 cursor-pointer"
              style={count === 1 ? { maxHeight: "260px" } : { aspectRatio: "1/1" }}
            >
              <img
                src={item.url}
                alt={item.name ?? "Image"}
                className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}

      {statusEntries.map((statusItem, idx) => (
        <div
          key={statusItem.id || idx}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--rm-bg-inset)] border border-[var(--rm-bubble-border)] text-[var(--rm-text-muted)] text-xs max-w-[280px]"
        >
          <ImageOff className="h-4 w-4 shrink-0 opacity-70" />
          <span>{statusLabel(statusItem.kind)}</span>
        </div>
      ))}
    </div>
  );
}

type MarkdownTableProps = ComponentProps<"table"> & { node?: unknown };
type MarkdownPreProps = ComponentProps<"pre"> & { node?: unknown };
type MarkdownAnchorProps = ComponentProps<"a"> & { node?: unknown };

const MOBILE_FIT_STYLE = `<style id="minih-mobile-fit">
html, body { max-width: 100% !important; overflow-x: hidden !important; box-sizing: border-box !important; }
.am-bar, header { flex-wrap: wrap !important; max-width: 100% !important; }
svg, canvas, img, table { max-width: 100% !important; height: auto !important; }
</style>`;

function prepareHtmlForFrame(html: string): string {
  const withoutCsp = html.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "");
  if (withoutCsp.includes("minih-mobile-fit")) return withoutCsp;
  if (/<\/head>/i.test(withoutCsp)) {
    return withoutCsp.replace(/<\/head>/i, `${MOBILE_FIT_STYLE}</head>`);
  }
  return `${MOBILE_FIT_STYLE}${withoutCsp}`;
}

function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

function extractCodeBlock(children: ReactNode): { lang: string; code: string } | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: string; children?: ReactNode };
  const className = typeof props.className === "string" ? props.className : "";
  const langMatch = /language-([a-zA-Z0-9_-]+)/.exec(className);
  const lang = (langMatch?.[1] ?? "").toLowerCase();
  const raw =
    typeof props.children === "string"
      ? props.children
      : Array.isArray(props.children)
        ? props.children.map((part) => (typeof part === "string" ? part : "")).join("")
        : "";
  const code = raw.replace(/\n$/, "");
  return { lang, code };
}

function isHtmlSource(lang: string, code: string): boolean {
  if (lang === "html" || lang === "htm") return true;
  if (!lang) {
    const trimmed = code.trimStart();
    return /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  }
  return false;
}

function findHtmlInMarkdown(text: string): string | null {
  const match = /(`{3,})(?:html|htm)\s*\n([\s\S]*?)\1/i.exec(text);
  if (match?.[2]?.trim()) return match[2].trim();
  return null;
}

function findHtmlAcrossItems(items: readonly TimelineItem[], href?: string): { title: string; code: string } | null {
  const fileName = href ? href.split("/").pop()?.replace(/[?#].*$/, "") : undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.toolName === "Write" && item.toolArgs && typeof item.toolArgs === "object") {
      const args = item.toolArgs as { path?: unknown; file_path?: unknown; content?: unknown };
      const targetPath = String(args.path ?? args.file_path ?? "");
      const content = typeof args.content === "string" ? args.content : "";
      if (content && (!fileName || targetPath.endsWith(fileName) || targetPath.endsWith(".html"))) {
        return {
          title: extractHtmlTitle(content) ?? fileName ?? "HTML",
          code: content,
        };
      }
    }
    const embedded = findHtmlInMarkdown(item.text);
    if (embedded) {
      return {
        title: extractHtmlTitle(embedded) ?? fileName ?? "HTML",
        code: embedded,
      };
    }
  }
  return null;
}

function HtmlPreviewCard({
  code,
  onExpand,
}: {
  code: string;
  onExpand: (preview: { title: string; code: string }) => void;
}) {
  const { t } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  const frameHtml = useMemo(() => prepareHtmlForFrame(code), [code]);
  const title = useMemo(() => extractHtmlTitle(frameHtml) ?? "HTML", [frameHtml]);
  /**
   * The preview measures itself and posts its height, because the sandbox gives
   * this window no readable document to measure. Only this card's own frame may
   * set the height, and only inside bounds chosen here.
   */
  const srcDoc = useMemo(() => withHeightReporting(frameHtml), [frameHtml]);
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const reported = readFrameHeight(event.data);
      if (reported === null) return;
      setFrameHeight(clampFrameHeight(reported, window.innerHeight));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <div className="my-2 w-full overflow-hidden rounded-2xl border border-[var(--rm-separator)] bg-[var(--rm-bg-surface)] shadow-[var(--rm-shadow)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--rm-separator)] bg-[var(--rm-bg-inset)] px-3 py-2 text-[12px] text-[var(--rm-text-secondary)]">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-[var(--rm-text-primary)]">
          <Globe size={13} className="shrink-0 text-[var(--rm-link)]" aria-hidden="true" />
          <span className="truncate">{title}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setShowSource((prev) => !prev);
            }}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-[var(--rm-text-secondary)] active:bg-[var(--rm-bg-surface)]"
          >
            <Code size={12} aria-hidden="true" />
            <span>{showSource ? t("timeline.html.preview") : t("timeline.html.code")}</span>
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onExpand({ title, code: frameHtml });
            }}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--rm-link)] active:bg-[var(--rm-bg-surface)]"
          >
            <Maximize2 size={12} aria-hidden="true" />
            <span>{t("timeline.html.fullscreen")}</span>
          </button>
        </div>
      </div>
      {showSource ? (
        <pre className="m-0 max-h-[320px] overflow-auto p-3 font-mono text-[12px] leading-[18px] text-[var(--rm-text-secondary)]">
          <code>{code}</code>
        </pre>
      ) : (
        <iframe
          ref={frameRef}
          title={title}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          style={{ height: `${frameHeight ?? HTML_FRAME_DEFAULT_HEIGHT}px` }}
          className="block w-full border-0 bg-[var(--rm-bg-surface)]"
          loading="lazy"
        />
      )}
    </div>
  );
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

/**
 * The one line a failed turn gets: the status and the provider's own sentence,
 * never the JSON envelope it arrived in. Long reasons wrap and break inside the
 * card, because a provider that answers with one unbroken token would otherwise
 * push this row past the screen edge.
 */
function TurnFailureBanner({ failure }: { failure: TimelineFailure }) {
  const { t } = useTranslation();
  const display = describeTurnFailure(failure.message ?? "");
  if (!display.reason) return null;
  const reason = display.status === undefined ? display.reason : `${display.status} · ${display.reason}`;
  return (
    <li className="mt-2 min-w-0 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-[14px] leading-relaxed text-[var(--rm-error)]">
      <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {t("session.turn.failed", { reason })}
      </p>
    </li>
  );
}

export function ChatTimeline({
  items,
  lastFailure,
  pendingText,
  resolveMedia,
  onCopyMessage,
  onRegenerateMessage,
  onEditResendMessage,
}: ChatTimelineProps) {
  const { t } = useTranslation();
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});
  const [expandedHtml, setExpandedHtml] = useState<{ title: string; code: string } | null>(null);
  const [expandedShowSource, setExpandedShowSource] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewerState, setViewerState] = useState<{
    open: boolean;
    items: MediaViewerItem[];
    index: number;
  }>({ open: false, items: [], index: 0 });

  const handleCopy = async (item: TimelineItem) => {
    if (onCopyMessage) {
      onCopyMessage(item);
    } else if (item.text) {
      try {
        await navigator.clipboard.writeText(item.text);
      } catch {
        // ignore
      }
    }
    setCopiedId(item.id);
    setTimeout(() => {
      setCopiedId((current) => (current === item.id ? null : current));
    }, 1500);
  };

  const handleOpenViewer = (viewerItems: MediaViewerItem[], index: number) => {
    setViewerState({ open: true, items: viewerItems, index });
  };

  const toggle = (key: string) => {
    setOpenItems((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Drop empty assistant placeholders first so they never split consecutive tool calls.
  const visibleItems = useMemo(
    () => items.filter((item) => !isEmptyAssistantPlaceholder(item)),
    [items],
  );
  const lastAssistantId = useMemo(() => {
    for (let i = visibleItems.length - 1; i >= 0; i--) {
      if (visibleItems[i].role === "assistant") return visibleItems[i].id;
    }
    return null;
  }, [visibleItems]);
  const visibleItemsRef = useRef<readonly TimelineItem[]>(visibleItems);
  visibleItemsRef.current = visibleItems;

  const markdownComponents = useMemo(
    () => ({
      table: ({ children, node: _node, ...props }: MarkdownTableProps) => (
        <div className="rm-table-wrap">
          <table {...props}>{children}</table>
        </div>
      ),
      pre: ({ children, node: _node, ...props }: MarkdownPreProps) => {
        const extracted = extractCodeBlock(children);
        if (extracted && isHtmlSource(extracted.lang, extracted.code)) {
          return (
            <HtmlPreviewCard
              code={extracted.code}
              onExpand={(preview) => {
                setExpandedShowSource(false);
                setExpandedHtml(preview);
              }}
            />
          );
        }
        return <pre {...props}>{children}</pre>;
      },
      a: ({ href, children, node: _node, ...props }: MarkdownAnchorProps) => {
        const rawHref = typeof href === "string" ? href.trim() : "";
        const isLocalHtml =
          /^file:\/\//i.test(rawHref) || /\.html?(?:[?#].*)?$/i.test(rawHref);
        if (isLocalHtml) {
          return (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const found = findHtmlAcrossItems(visibleItemsRef.current, rawHref);
                if (found) {
                  setExpandedShowSource(false);
                  setExpandedHtml({
                    title: found.title,
                    code: prepareHtmlForFrame(found.code),
                  });
                }
              }}
              className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-xl bg-[var(--rm-bg-surface)] px-3 py-1.5 text-left text-[14px] font-medium text-[var(--rm-link)] shadow-[var(--rm-shadow)] ring-1 ring-[var(--rm-separator)] active:bg-[var(--rm-bg-inset)]"
            >
              <Globe size={14} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{children}</span>
            </button>
          );
        }
        return (
          <a
            {...props}
            href={rawHref || undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (/^https?:\/\//i.test(rawHref)) {
                window.open(rawHref, "_blank", "noopener,noreferrer");
              }
            }}
            className="inline-flex items-center gap-0.5 text-[var(--rm-link)] underline underline-offset-2"
          >
            <span>{children}</span>
            <ExternalLink size={12} className="inline shrink-0" aria-hidden="true" />
          </a>
        );
      },
    }),
    [],
  );

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

  const fullscreenModal =
    expandedHtml && typeof document !== "undefined"
      ? createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={expandedHtml.title}
            className="fixed inset-0 z-50 flex flex-col bg-[var(--rm-bg-page)] text-[var(--rm-text-primary)]"
          >
            <header className="rm-nav rm-gutter flex min-h-[52px] shrink-0 items-center justify-between gap-2 border-b border-[var(--rm-separator)] bg-[var(--rm-bg-surface)] pb-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Globe size={16} className="shrink-0 text-[var(--rm-link)]" aria-hidden="true" />
                <span className="truncate text-[16px] font-semibold leading-[22px]">
                  {expandedHtml.title}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setExpandedShowSource((prev) => !prev)}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--rm-bg-inset)] px-2.5 text-[13px] font-medium text-[var(--rm-text-secondary)] active:opacity-75"
                >
                  <Code size={14} aria-hidden="true" />
                  <span>{expandedShowSource ? t("timeline.html.preview") : t("timeline.html.code")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedHtml(null)}
                  aria-label={t("common.close")}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--rm-bg-inset)] text-[var(--rm-text-primary)] active:opacity-75"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="relative flex-1 overflow-hidden bg-[var(--rm-bg-surface)]">
              {expandedShowSource ? (
                <pre className="m-0 h-full w-full overflow-auto p-4 font-mono text-[12px] leading-[18px] text-[var(--rm-text-secondary)]">
                  <code>{expandedHtml.code}</code>
                </pre>
              ) : (
                <iframe
                  title={expandedHtml.title}
                  sandbox="allow-scripts"
                  srcDoc={expandedHtml.code}
                  className="block h-full w-full border-0 bg-[var(--rm-bg-surface)]"
                />
              )}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
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
                <MediaThumbnails
                  mediaIds={item.mediaIds}
                  resolveMedia={resolveMedia}
                  onOpenViewer={handleOpenViewer}
                />
                {(() => {
                  const attachments = item.attachments ?? [];
                  // An image with no media id cannot be fetched, so it has no
                  // thumbnail: name it instead of dropping it silently.
                  const unreadable = attachments.filter(
                    (att) => att.kind === "image" && !att.mediaId,
                  );
                  const nonImage = attachments.filter((att) => att.kind !== "image");
                  if (unreadable.length === 0 && nonImage.length === 0) return null;
                  return (
                    <>
                      {unreadable.length > 0 ? (
                        <div className={`${item.text ? "mt-1.5 " : ""}text-[12px] leading-[16px] text-[var(--rm-text-secondary)]`}>
                          {t("timeline.imageAttachments", {
                            names: unreadable.map((attachment) => attachment.name).join(", "),
                          })}
                        </div>
                      ) : null}
                      {nonImage.length > 0 ? (
                        <div className={`${item.text || unreadable.length > 0 ? "mt-1.5 " : ""}text-[12px] leading-[16px] text-[var(--rm-text-secondary)]`}>
                          {t("timeline.attachments", {
                            count: nonImage.length,
                            names: nonImage.map((attachment) => attachment.name).join(", "),
                          })}
                        </div>
                      ) : null}
                    </>
                  );
                })()}
                {isPending ? (
                  <div className="mt-1 flex items-center justify-end gap-1 text-[12px] text-[var(--rm-text-muted)]">
                    <Clock size={12} />
                    <span>{t("timeline.sending")}</span>
                  </div>
                ) : (
                  <div className="mt-1.5 flex items-center justify-end gap-1">
                    {item.text ? (
                      <button
                        type="button"
                        onClick={() => handleCopy(item)}
                        aria-label={copiedId === item.id ? t("message.copied") : t("message.copy")}
                        title={t("message.copy")}
                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--rm-text-muted)] hover:bg-[var(--rm-bg-surface)] hover:text-[var(--rm-text-primary)] cursor-pointer"
                      >
                        {copiedId === item.id ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                      </button>
                    ) : null}
                    {onEditResendMessage && item.text ? (
                      <button
                        type="button"
                        onClick={() => onEditResendMessage(item)}
                        aria-label={t("message.editResend")}
                        title={t("message.editResend")}
                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--rm-text-muted)] hover:bg-[var(--rm-bg-surface)] hover:text-[var(--rm-text-primary)] cursor-pointer"
                      >
                        <Pencil size={12} />
                      </button>
                    ) : null}
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
              className={`${topGap}flex flex-col self-start w-full max-w-full`}
            >
              {item.agentName ? (
                <div className="mb-0.5 text-[12px] text-[var(--rm-text-muted)]">
                  {t("timeline.agent", { agent: item.agentName })}
                </div>
              ) : null}
              {item.text ? (
                <div className="rm-prose">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    urlTransform={(url) => url}
                    components={markdownComponents}
                  >
                    {item.text}
                  </ReactMarkdown>
                </div>
              ) : null}
              {item.mediaIds && item.mediaIds.length > 0 ? (
                <MediaThumbnails
                  mediaIds={item.mediaIds}
                  resolveMedia={resolveMedia}
                  onOpenViewer={handleOpenViewer}
                />
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
              <div className="mt-1 flex items-center gap-1">
                {item.text ? (
                  <button
                    type="button"
                    onClick={() => handleCopy(item)}
                    aria-label={copiedId === item.id ? t("message.copied") : t("message.copy")}
                    title={t("message.copy")}
                    className="flex h-6 w-6 items-center justify-center rounded text-[var(--rm-text-muted)] hover:bg-[var(--rm-bg-surface)] hover:text-[var(--rm-text-primary)] cursor-pointer"
                  >
                    {copiedId === item.id ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                  </button>
                ) : null}
                {onRegenerateMessage && item.status !== "streaming" && item.id === lastAssistantId ? (
                  <button
                    type="button"
                    onClick={() => onRegenerateMessage(item)}
                    aria-label={t("message.regenerate")}
                    title={t("message.regenerate")}
                    className="flex h-6 w-6 items-center justify-center rounded text-[var(--rm-text-muted)] hover:bg-[var(--rm-bg-surface)] hover:text-[var(--rm-text-primary)] cursor-pointer"
                  >
                    <RotateCcw size={12} />
                  </button>
                ) : null}
              </div>
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
        {lastFailure?.message ? <TurnFailureBanner failure={lastFailure} /> : null}
      </ul>
      {fullscreenModal}
      <MediaViewer
        open={viewerState.open}
        items={viewerState.items}
        initialIndex={viewerState.index}
        onClose={() => setViewerState((s) => ({ ...s, open: false }))}
      />
    </>
  );
}
