import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconImage } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { GeneratedImageViewer } from "./GeneratedImageViewer";
import type { GeneratedImageRef } from "./GeneratedImageThumbnail";
import { useToolImageDataUrl } from "./use-tool-image-data-url";
import { useImageStripDrag } from "./use-image-strip-drag";
import type { TurnToolImage } from "./turn-tool-images";
import "../../../styles/generated-images.css";

/**
 * One small tile. The tile is the button: a press opens the viewer, a press
 * that drags scrolls the row instead (the row drops that click), and an image
 * whose bytes never arrive keeps its place as a placeholder rather than
 * collapsing the strip.
 */
function ToolImageTile({
  image,
  onOpen,
}: {
  image: GeneratedImageRef;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation();
  const source = useToolImageDataUrl(image);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const dataUrl = source !== failedSource ? source : null;
  const label = image.label ?? t("chat.imagePreview.title");
  return (
    <TooltipButton
      type="button"
      className={`tool-image-strip-item${dataUrl ? "" : " is-unavailable"}`}
      tooltip={label}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {dataUrl ? (
        <img src={dataUrl} alt={label} draggable={false} onError={() => setFailedSource(dataUrl)} />
      ) : (
        <span className="tool-image-strip-placeholder">
          <IconImage size={18} aria-hidden />
          <span className="sr-only">{t("chat.imagePreview.error")}</span>
        </span>
      )}
    </TooltipButton>
  );
}

/**
 * The turn's tool images as one row of small tiles.
 *
 * Evidence a tool produced — a screenshot, a Read of an image, an MCP capture —
 * is context, not the answer, so it takes a row rather than a 420px card each.
 * The row scrolls sideways with the wheel or a trackpad, or by pressing and
 * dragging it; a tile opens the shared full-window viewer, which walks the
 * whole row with arrow keys and returns focus to the tile it was opened from.
 */
export function ToolImageStrip({ images }: { images: TurnToolImage[] }) {
  const { t } = useTranslation();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const { scrollerRef, dragging, handlers } = useImageStripDrag();
  if (!images.length) return null;
  const labelled = images.map((image, position) => ({
    ...image,
    label: `${t("chat.toolImages")} ${position + 1}`,
  }));
  const selected = viewerIndex === null ? undefined : labelled[viewerIndex];
  return (
    <div className="tool-images" role="group" aria-label={t("chat.toolImages")}>
      <div
        ref={scrollerRef}
        className={`tool-image-strip${dragging ? " is-dragging" : ""}`}
        onPointerDown={handlers.onPointerDown}
        onClickCapture={handlers.onClickCapture}
      >
        {labelled.map((image, position) => (
          <ToolImageTile
            key={image.key}
            image={image}
            onOpen={(trigger) => {
              focusReturnRef.current = trigger;
              setViewerIndex(position);
            }}
          />
        ))}
      </div>
      {selected ? (
        <GeneratedImageViewer
          images={labelled}
          selectedIndex={viewerIndex ?? 0}
          onSelect={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          focusReturnRef={focusReturnRef}
        />
      ) : null}
    </div>
  );
}
