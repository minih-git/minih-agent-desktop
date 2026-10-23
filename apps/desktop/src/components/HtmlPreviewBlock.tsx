import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconCheck,
  IconCircleAlert,
  IconCode,
  IconCopy,
  IconExternal,
  IconGlobe,
  IconPlay,
} from "./icons";
import { useCopy } from "../hooks/use-copy";
import { MAX_HTML_PAGE_SOURCE_LENGTH } from "../lib/html-page";
import type { SourcePositionProps } from "../lib/markdown-source";
import { TooltipButton } from "./ui";

/**
 * One page of HTML rendered inside a transcript row.
 *
 * Both entry points share it: a completed `html` fence, and a chat link to a
 * local `.html` page the host could read back. Either way the markup renders
 * through a sandboxed `srcdoc` iframe, so it never joins the host document. The
 * frame holds an opaque origin: it cannot reach the transcript DOM, and no
 * preload bridge exists inside it because the main window leaves
 * `nodeIntegrationInSubFrames` off. The app CSP still bounds what the frame
 * loads, so this feature widens no policy.
 *
 * The content is model output, so scripts stay off until the reader enables
 * them for one block; a source change returns that block to the default. A
 * block past the size cap fails closed to the source view.
 */
export function HtmlPreviewBlock({
  code,
  title = "html",
  onOpenInPanel,
  ...position
}: {
  code: string;
  /** Head label: a fence says `html`, a linked page names the page. */
  title?: string;
  /** Opens the same page in the work-panel browser, when the row has one. */
  onOpenInPanel?: () => void;
} & SourcePositionProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  // Both toggles record the source they were set for, so an edited block is
  // back on the safe default in the same render. An effect would let the new
  // source commit one frame with the previous block's permission.
  const [sourceShownFor, setSourceShownFor] = useState<string | null>(null);
  const [scriptsFor, setScriptsFor] = useState<string | null>(null);
  const showSource = sourceShownFor === code;
  const scripts = scriptsFor === code;

  const oversized = code.length > MAX_HTML_PAGE_SOURCE_LENGTH;
  const sourceVisible = showSource || oversized;

  return (
    <div {...position} className={`html-block${oversized ? " error" : ""}`}>
      <div className="html-block-head">
        <span className="html-block-title">
          <IconGlobe size={13} aria-hidden />
          <span>{title}</span>
        </span>
        <div className="html-block-actions">
          {oversized ? null : (
            <>
              <TooltipButton
                type="button"
                className={`html-action-btn${showSource ? " active" : ""}`}
                tooltip={showSource ? t("chat.showHtml") : t("chat.showHtmlSource")}
                ariaLabel={
                  showSource ? t("chat.showHtml") : t("chat.showHtmlSource")
                }
                aria-pressed={showSource}
                onClick={() => setSourceShownFor(showSource ? null : code)}
              >
                {showSource ? <IconGlobe size={13} /> : <IconCode size={13} />}
              </TooltipButton>
              {showSource ? null : (
                <TooltipButton
                  type="button"
                  className={`html-action-btn${scripts ? " active" : ""}`}
                  tooltip={t("chat.runHtmlScripts")}
                  ariaLabel={t("chat.runHtmlScripts")}
                  aria-pressed={scripts}
                  onClick={() => setScriptsFor(scripts ? null : code)}
                >
                  <IconPlay size={13} />
                </TooltipButton>
              )}
            </>
          )}
          {onOpenInPanel ? (
            <TooltipButton
              type="button"
              className="html-action-btn"
              tooltip={t("settings.linkContextMenuOpenWorkpanel")}
              ariaLabel={t("settings.linkContextMenuOpenWorkpanel")}
              onClick={onOpenInPanel}
            >
              <IconExternal size={13} />
            </TooltipButton>
          ) : null}
          <TooltipButton
            type="button"
            className={`html-action-btn${copied ? " copied" : ""}`}
            tooltip={copied ? t("chat.copied") : t("chat.copy")}
            ariaLabel={t("chat.copy")}
            onClick={() => copy(code)}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </TooltipButton>
        </div>
      </div>
      <div className="html-block-body">
        {oversized ? (
          <div className="html-block-error" role="status">
            <IconCircleAlert size={14} aria-hidden />
            <span>{t("chat.htmlPreviewTooLarge")}</span>
          </div>
        ) : null}
        {sourceVisible ? (
          <pre className="html-source">
            <code>{code}</code>
          </pre>
        ) : (
          <iframe
            key={scripts ? "scripts" : "static"}
            className="html-frame"
            title={t("chat.htmlPreview")}
            sandbox={scripts ? "allow-scripts" : ""}
            srcDoc={code}
            loading="lazy"
          />
        )}
      </div>
    </div>
  );
}