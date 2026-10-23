import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { loadLocalHtmlPage, type LocalHtmlPage } from "../lib/html-page";
import { useOpenChatFileRef } from "../hooks/use-preview-target";
import { useSlotSessionId } from "../plugins/renderer-slots/use-slots";
import { useAppStore } from "../stores/app-store";
import { HtmlPreviewBlock } from "./HtmlPreviewBlock";

/** The visible text of a link's children, used as the page's head label. */
export function linkText(children: ReactNode): string {
  if (typeof children === "string") return children.trim();
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) {
    return children.map((child) => linkText(child)).join("").trim();
  }
  return "";
}

/**
 * A chat link to a local `.html` page, shown as the page it names.
 *
 * An answer that renders HTML renders a page, and `answer-me-with-html` writes
 * one to disk and links it rather than pasting a fence. That link renders here
 * through the same sandboxed frame an `html` fence uses, so the page lands in
 * the transcript instead of waiting behind a click into the work panel.
 *
 * The host owns the read: the renderer asks for the path with the session it
 * belongs to, so roots, remote workspaces and the size cap stay where they
 * always were. Every outcome other than a `text` read the cap allows — scripts
 * still off, oversized, binary, missing, or a rejected read — keeps the link
 * the message already wrote, and its click still opens the page (ADR 0163).
 */
export function LocalHtmlPageLink({
  path,
  name,
  baseDir,
  fallback,
}: {
  path: string;
  /** Link text, used as the page head label. */
  name?: string;
  baseDir?: string;
  /** Rendered until the read lands, and instead of it when it can't. */
  fallback: ReactNode;
}) {
  const paneSessionId = useSlotSessionId();
  const sessionId = useAppStore((s) => paneSessionId || s.activeSessionId);
  const openFileRef = useOpenChatFileRef();
  const [page, setPage] = useState<LocalHtmlPage>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPage({ status: "loading" });
    void loadLocalHtmlPage(() =>
      api.fsRead(path, "text/html", sessionId),
    ).then((next) => {
      if (!cancelled) setPage(next);
    });
    return () => {
      cancelled = true;
    };
  }, [path, sessionId]);

  /*
    The read is one host call away, and until it lands the link stays exactly
    what the message wrote. The wrapper keeps that handover in one node, so the
    link slot is findable without changing how it reads or clicks.
  */
  if (page.status !== "ready") {
    return <span className="html-page-slot">{fallback}</span>;
  }
  return (
    <span className="html-block-inline">
      <HtmlPreviewBlock
        code={page.code}
        title={name || "html"}
        onOpenInPanel={() => openFileRef(path, baseDir)}
      />
    </span>
  );
}