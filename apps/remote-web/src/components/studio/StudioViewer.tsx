/**
 * Studio gallery cards and full-screen artwork viewer (ADR mobile-redesign D3, D4).
 *
 * `StudioArtCard` renders a generating card (blurred aurora surface + sweep
 * shimmer + stop button), a completed artwork card (with optional reveal sweep
 * when a live generation finishes), or a failed/stopped card with retry/delete.
 * `StudioViewerModal` displays a completed artwork full-screen with its prompt,
 * model tag, and the actions the client supports: Save/Share, Copy prompt,
 * Generate again (fills composer), and Delete.
 */
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import {
  Copy,
  Download,
  Loader2,
  RotateCcw,
  Share2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { copyText } from "../../lib/clipboard.js";
import type { StudioCard } from "../../lib/direct-chat/studio.js";
import { failureReasonKey } from "../../lib/direct-chat/view.js";
import { takeModalFocus } from "../../lib/modal-focus.js";
import { Button } from "../ui/Button.js";
import {
  cleanupCacheFiles,
  isAbortOrCancel,
  prepareCacheFileForShare,
  triggerWebDownload,
} from "../ui/MediaViewer.js";
import { Tag } from "../ui/StatusDot.js";

export interface StudioArtCardProps {
  card: StudioCard;
  mediaUrl: string | null;
  revealing?: boolean;
  /**
   * `banner` is the full-width slot a group gives the cards that are not
   * finished artwork — generating, failed, stopped (D). `tile` is a card in the
   * two-column masonry.
   */
  layout?: "tile" | "banner";
  onOpen: (card: StudioCard) => void;
  onStop: (card: StudioCard) => void;
  onRetry: (card: StudioCard) => void;
  onDelete: (card: StudioCard) => void;
}

export function StudioArtCard({
  card,
  mediaUrl,
  revealing = false,
  layout = "tile",
  onOpen,
  onStop,
  onRetry,
  onDelete,
}: StudioArtCardProps) {
  const { t } = useTranslation();
  const banner = layout === "banner";

  if (card.status === "generating") {
    return (
      <div
        className={`rm-image-gen overflow-hidden rounded-[18px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] ${
          banner ? "" : "mb-2.5 break-inside-avoid"
        }`}
      >
        <div
          className={`rm-image-surface w-full ${banner ? "aspect-[4/3]" : "aspect-square"}`}
          style={{
            background:
              "radial-gradient(circle at 30% 30%, var(--rm-accent-2), transparent 55%), linear-gradient(150deg, var(--rm-accent-1), var(--rm-accent-3))",
          }}
        />
        <div
          className={`absolute inset-0 z-10 flex flex-col items-center justify-center text-center text-white ${
            banner ? "gap-3 p-4" : "gap-2 p-3"
          }`}
        >
          <Loader2
            className={`animate-spin drop-shadow ${banner ? "h-12 w-12" : "h-8 w-8"}`}
            aria-hidden="true"
          />
          <span
            className={`font-bold drop-shadow ${banner ? "text-[15px] leading-[20px]" : "text-[12px]"}`}
          >
            {t("imageGen.generating")}
          </span>
          <button
            type="button"
            onClick={() => onStop(card)}
            aria-label={t("directChat.stop")}
            className={`inline-flex items-center gap-1 rounded-full bg-black/45 font-semibold text-white backdrop-blur-md transition-transform active:scale-95 ${
              banner ? "mt-1 h-9 px-3.5 text-[13px]" : "mt-1 h-7 px-2.5 text-[11px]"
            }`}
          >
            <Square className={banner ? "h-3.5 w-3.5 fill-current" : "h-3 w-3 fill-current"} aria-hidden="true" />
            <span>{t("directChat.stop")}</span>
          </button>
        </div>
        {/* Two lines of prompt in the wide slot: the one thing that says what is
            being drawn. A tile has room for one. */}
        <div
          className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/65 to-transparent px-2.5 pb-2 pt-5 text-left text-white ${
            banner ? "line-clamp-2 text-[13px] leading-[18px]" : "truncate text-[12px]"
          }`}
        >
          {card.prompt}
        </div>
      </div>
    );
  }

  if (card.status === "complete" && mediaUrl) {
    const aspectRatio =
      card.width && card.height && card.width > 0 && card.height > 0
        ? `${card.width} / ${card.height}`
        : "1 / 1";
    return (
      <button
        type="button"
        onClick={() => onOpen(card)}
        className={`relative mb-2.5 block w-full break-inside-avoid overflow-hidden rounded-[18px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] text-left transition-transform duration-150 ease-[var(--rm-ease-out)] active:scale-[0.975] ${
          revealing ? "rm-image-reveal" : ""
        }`}
      >
        <img
          src={mediaUrl}
          alt={card.prompt}
          style={{ aspectRatio }}
          className="rm-image-surface block w-full object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/65 to-transparent px-2.5 pb-2 pt-5 text-left text-[12px] text-white">
          {card.prompt}
        </div>
      </button>
    );
  }

  const reasonText =
    card.status === "stopped"
      ? t("directChat.state.stopped").split(" ·")[0]
      : t(failureReasonKey(card.errorKind));

  return (
    <div
      className={`flex flex-col justify-between gap-2.5 rounded-[18px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] p-3 backdrop-blur-md ${
        banner ? "" : "mb-2.5 break-inside-avoid"
      }`}
    >
      <div className={banner ? "flex items-center gap-3" : ""}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <Tag tone={card.status === "stopped" ? "warn" : "error"}>
              {card.status === "stopped" ? t("sessions.status.aborted") : t("directChat.state.failed")}
            </Tag>
            <Tag>{card.modelId}</Tag>
          </div>
          <p
            className={`mt-2 text-[13px] font-medium leading-[18px] text-[var(--rm-text-primary)] ${
              banner ? "line-clamp-2" : "line-clamp-3"
            }`}
          >
            {card.prompt}
          </p>
          <p className="mt-1 text-[12px] leading-[16px] text-[var(--rm-text-muted)]">{reasonText}</p>
        </div>
        {/* A wide card keeps the two actions beside the reason instead of under
            it, which is what leaves the right half of the row empty otherwise. */}
        <div className={`flex items-center gap-1.5 ${banner ? "shrink-0" : ""}`}>
          <Button
            variant="secondary"
            size="small"
            className={banner ? "" : "flex-1"}
            onClick={() => onRetry(card)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("imageGen.retry")}</span>
          </Button>
          <button
            type="button"
            onClick={() => onDelete(card)}
            aria-label={t("studio.deleteImage")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[var(--rm-error)] transition-colors hover:bg-[var(--rm-bg-surface-2)]"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

export interface StudioViewerModalProps {
  card: StudioCard | null;
  mediaUrl: string | null;
  onClose: () => void;
  onReusePrompt: (prompt: string) => void;
  onDelete: (card: StudioCard) => void;
  onToast: (message: string) => void;
}

export function StudioViewerModal({
  card,
  mediaUrl,
  onClose,
  onReusePrompt,
  onDelete,
  onToast,
}: StudioViewerModalProps) {
  const { t } = useTranslation();
  const tempFilesRef = useRef<string[]>([]);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const cleanupTemp = useCallback(async () => {
    if (tempFilesRef.current.length === 0) return;
    const paths = [...tempFilesRef.current];
    tempFilesRef.current = [];
    await cleanupCacheFiles(paths);
  }, []);

  useEffect(() => {
    return () => {
      void cleanupTemp();
    };
  }, [cleanupTemp]);

  useEffect(() => {
    if (!card) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void cleanupTemp();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [card, onClose, cleanupTemp]);

  /**
   * The viewer is a full-screen modal: focus moves to its close button on open
   * and returns to the gallery card on close, so `Escape` does not strand a
   * keyboard user at the top of the page.
   */
  useEffect(() => {
    if (!card || !mediaUrl) return undefined;
    return takeModalFocus(
      typeof document !== "undefined" ? document : null,
      closeButtonRef.current,
      dialogRef.current,
    );
  }, [card, mediaUrl]);

  if (!card || !mediaUrl) return null;

  const filename = `minih-${card.id}.png`;

  const handleSaveOrShare = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const { path, uri } = await prepareCacheFileForShare({
          id: card.id,
          url: mediaUrl,
          name: filename,
        });
        tempFilesRef.current.push(path);
        await Share.share({
          title: card.prompt.slice(0, 48) || "Image",
          url: uri,
          dialogTitle: card.prompt.slice(0, 48) || "Share Image",
        });
      } catch (err) {
        if (!isAbortOrCancel(err)) {
          onToast(t("mediaViewer.shareFailed"));
        }
      }
      return;
    }

    try {
      triggerWebDownload(mediaUrl, filename);
      onToast(t("mediaViewer.downloadStarted"));
    } catch {
      onToast(t("mediaViewer.saveFailed"));
    }
  };

  const handleCopyPrompt = async () => {
    const outcome = await copyText(card.prompt, navigator.clipboard);
    onToast(outcome.ok ? t("studio.promptCopied") : t("directChat.copyFailed"));
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={card.prompt}
      className="fixed inset-0 z-[70] flex flex-col bg-black/95 text-white select-none animate-[rm-scrim-in_0.25s_var(--rm-ease-out)]"
    >
      {/* Top bar */}
      <div className="rm-nav flex items-center justify-between px-3 pb-2">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={() => {
            void cleanupTemp();
            onClose();
          }}
          aria-label={t("mediaViewer.close")}
          className="grid h-11 w-11 place-items-center rounded-[14px] text-white/85 transition-transform active:scale-90 active:bg-white/15"
        >
          <X className="h-6 w-6" aria-hidden="true" />
        </button>
        <Tag tone="gradient">{card.modelId}</Tag>
        <div className="w-11" aria-hidden="true" />
      </div>

      {/* Artwork stage */}
      <div className="grid flex-1 place-items-center overflow-hidden px-4 py-2">
        <img
          src={mediaUrl}
          alt={card.prompt}
          className="max-h-full max-w-full rounded-[20px] object-contain shadow-2xl"
        />
      </div>

      {/* Prompt & actions */}
      <div className="rm-dock mx-auto w-full max-w-[640px] px-5 pt-2">
        <p className="line-clamp-3 text-[14px] leading-[21px] text-white/85">{card.prompt}</p>
        <div className="mt-4 flex items-center justify-around pb-2">
          <button
            type="button"
            onClick={() => void handleSaveOrShare()}
            className="flex w-[76px] flex-col items-center gap-1.5 py-1 text-[11px] font-medium text-white/90 transition-transform active:scale-90"
          >
            {Capacitor.isNativePlatform() ? (
              <Share2 className="h-6 w-6 stroke-[1.9]" aria-hidden="true" />
            ) : (
              <Download className="h-6 w-6 stroke-[1.9]" aria-hidden="true" />
            )}
            <span>
              {Capacitor.isNativePlatform() ? t("mediaViewer.saveOrShare") : t("mediaViewer.save")}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void handleCopyPrompt()}
            className="flex w-[76px] flex-col items-center gap-1.5 py-1 text-[11px] font-medium text-white/90 transition-transform active:scale-90"
          >
            <Copy className="h-6 w-6 stroke-[1.9]" aria-hidden="true" />
            <span>{t("studio.copyPrompt")}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const prompt = card.prompt;
              void cleanupTemp();
              onClose();
              onReusePrompt(prompt);
            }}
            className="flex w-[76px] flex-col items-center gap-1.5 py-1 text-[11px] font-medium text-white/90 transition-transform active:scale-90"
          >
            <RotateCcw className="h-6 w-6 stroke-[1.9]" aria-hidden="true" />
            <span>{t("studio.reusePrompt")}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const target = card;
              void cleanupTemp();
              onClose();
              onDelete(target);
            }}
            className="flex w-[76px] flex-col items-center gap-1.5 py-1 text-[11px] font-medium text-[var(--rm-error)] transition-transform active:scale-90"
          >
            <Trash2 className="h-6 w-6 stroke-[1.9]" aria-hidden="true" />
            <span>{t("studio.deleteImage")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
