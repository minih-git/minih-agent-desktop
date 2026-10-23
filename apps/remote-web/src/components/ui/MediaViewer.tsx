import { useEffect, useState, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Share2,
  X,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export interface MediaViewerItem {
  id: string;
  url: string;
  mime?: string;
  name?: string;
  width?: number;
  height?: number;
}
async function urlToBase64(url: string): Promise<string> {
  if (url.startsWith("data:")) {
    const commaIndex = url.indexOf(",");
    return commaIndex >= 0 ? url.slice(commaIndex + 1) : url;
  }
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const commaIndex = dataUrl.indexOf(",");
      resolve(commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function urlToFile(url: string, filename: string, mime?: string): Promise<File> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], filename, { type: mime || blob.type || "image/png" });
}
export function triggerWebDownload(url: string, filename: string): void {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}


export function isAbortOrCancel(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("abort") || msg.includes("cancel") || msg.includes("dismiss")) return true;
  }
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    if (record.name === "AbortError") return true;
    if (typeof record.message === "string") {
      const msg = record.message.toLowerCase();
      if (msg.includes("abort") || msg.includes("cancel") || msg.includes("dismiss")) return true;
    }
  }
  const str = String(err).toLowerCase();
  return str.includes("abort") || str.includes("cancel") || str.includes("dismiss");
}

export async function prepareCacheFileForShare(item: MediaViewerItem): Promise<{ path: string; uri: string }> {
  const filename = item.name ?? `image-${item.id}.png`;
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const cachePath = `share_${Date.now()}_${sanitizedFilename}`;
  const base64Data = await urlToBase64(item.url);
  const fileResult = await Filesystem.writeFile({
    path: cachePath,
    data: base64Data,
    directory: Directory.Cache,
    recursive: true,
  });
  return { path: cachePath, uri: fileResult.uri };
}

export async function cleanupCacheFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await Filesystem.deleteFile({
        path,
        directory: Directory.Cache,
      });
    } catch {
      // Ignore cleanup error if already removed
    }
  }
}

export interface MediaViewerProps {
  open: boolean;
  onClose: () => void;
  items: readonly MediaViewerItem[];
  initialIndex?: number;
}

export function MediaViewer({
  open,
  onClose,
  items,
  initialIndex = 0,
}: MediaViewerProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tempFilesRef = useRef<string[]>([]);

  const cleanupCurrentTempFiles = useCallback(async () => {
    if (tempFilesRef.current.length === 0) return;
    const paths = [...tempFilesRef.current];
    tempFilesRef.current = [];
    await cleanupCacheFiles(paths);
  }, []);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      void cleanupCurrentTempFiles();
    };
  }, [cleanupCurrentTempFiles]);

  useEffect(() => {
    if (open) {
      setIndex(Math.max(0, Math.min(initialIndex, items.length - 1)));
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [open, initialIndex, items.length]);

  // Handle Back button / History popstate so Back closes the viewer first
  useEffect(() => {
    if (!open) return;
    const handlePopState = () => {
      void cleanupCurrentTempFiles();
      onClose();
    };

    // Push dummy state to capture back button
    window.history.pushState({ mediaViewer: true }, "");
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [open, onClose]);

  // Handle Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void cleanupCurrentTempFiles();
        onClose();
      } else if (e.key === "ArrowLeft") {

        setIndex((prev) => (prev > 0 ? prev - 1 : prev));
        setZoom(1);
        setPan({ x: 0, y: 0 });
      } else if (e.key === "ArrowRight") {
        setIndex((prev) => (prev < items.length - 1 ? prev + 1 : prev));
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose, items.length]);

  const currentItem = items[index];

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 0.5, 4));
  const handleZoomOut = () => {
    setZoom((prev) => {
      const next = Math.max(prev - 0.5, 1);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };
  const handleResetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleNativeSaveOrShare = useCallback(async () => {
    if (!currentItem) return;
    try {
      const { path, uri } = await prepareCacheFileForShare(currentItem);
      tempFilesRef.current.push(path);
      await Share.share({
        title: currentItem.name ?? "Image",
        url: uri,
        dialogTitle: currentItem.name ?? "Share Image",
      });
    } catch (err) {
      if (!isAbortOrCancel(err)) {
        showToast(t("mediaViewer.shareFailed"));
      }
    }
  }, [currentItem, showToast, t]);

  const handleDownload = useCallback(async () => {
    if (!currentItem) return;
    const filename = currentItem.name ?? `image-${currentItem.id}.png`;
    try {
      triggerWebDownload(currentItem.url, filename);
      showToast(t("mediaViewer.downloadStarted"));
    } catch {
      showToast(t("mediaViewer.saveFailed"));
    }
  }, [currentItem, showToast, t]);

  const handleShare = useCallback(async () => {
    if (!currentItem) return;
    const filename = currentItem.name ?? `image-${currentItem.id}.png`;

    if (typeof navigator !== "undefined" && typeof navigator.canShare === "function") {
      try {
        const file = await urlToFile(currentItem.url, filename, currentItem.mime);
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: currentItem.name ?? "Image",
            files: [file],
          });
          return;
        }
      } catch (err) {
        if (isAbortOrCancel(err)) {
          return;
        }
        showToast(t("mediaViewer.shareFailed"));
        return;
      }
    }

    showToast(t("mediaViewer.shareUnsupported"));
  }, [currentItem, showToast, t]);

  const handleDoubleClick = () => {
    if (zoom > 1) {
      handleResetZoom();
    } else {
      setZoom(2);
    }
  };

  if (!open || !currentItem) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white select-none animate-[fade-in_0.2s_ease-out]"
    >
      {/* Top Toolbar */}
      <header className="relative z-10 flex h-14 w-full items-center justify-between px-4 bg-black/40 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label={t("mediaViewer.close")}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 active:bg-white/20"
          >
            <X size={22} />
          </button>
          {items.length > 1 && (
            <span className="text-[14px] font-medium text-white/70">
              {index + 1} / {items.length}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoom <= 1}
            aria-label={t("mediaViewer.zoomOut")}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 active:bg-white/20 disabled:opacity-30"
          >
            <ZoomOut size={20} />
          </button>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoom >= 4}
            aria-label={t("mediaViewer.zoomIn")}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 active:bg-white/20 disabled:opacity-30"
          >
            <ZoomIn size={20} />
          </button>
          {zoom > 1 && (
            <button
              type="button"
              onClick={handleResetZoom}
              aria-label={t("mediaViewer.resetZoom")}
              className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 active:bg-white/20"
            >
              <RotateCcw size={18} />
            </button>
          )}
          {Capacitor.isNativePlatform() ? (
            <button
              type="button"
              onClick={handleNativeSaveOrShare}
              aria-label={t("mediaViewer.saveOrShare")}
              className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 active:bg-white/20"
            >
              <Share2 size={20} />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleShare}
                aria-label={t("mediaViewer.share")}
                className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 active:bg-white/20"
              >
                <Share2 size={20} />
              </button>
              <button
                type="button"
                onClick={handleDownload}
                aria-label={t("mediaViewer.save")}
                className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 active:bg-white/20"
              >
                <Download size={20} />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main View Area */}
      <main
        className="relative flex flex-1 items-center justify-center overflow-hidden"
        onMouseDown={(e) => {
          if (zoom > 1) {
            setIsDragging(true);
            dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
          }
        }}
        onMouseMove={(e) => {
          if (isDragging && zoom > 1) {
            setPan({
              x: e.clientX - dragStart.current.x,
              y: e.clientY - dragStart.current.y,
            });
          }
        }}
        onMouseUp={() => setIsDragging(false)}
        onMouseLeave={() => setIsDragging(false)}
        onTouchStart={(e) => {
          if (e.touches.length === 1 && zoom > 1) {
            setIsDragging(true);
            dragStart.current = {
              x: e.touches[0].clientX - pan.x,
              y: e.touches[0].clientY - pan.y,
            };
          }
        }}
        onTouchMove={(e) => {
          if (isDragging && zoom > 1 && e.touches.length === 1) {
            setPan({
              x: e.touches[0].clientX - dragStart.current.x,
              y: e.touches[0].clientY - dragStart.current.y,
            });
          }
        }}
        onTouchEnd={() => setIsDragging(false)}
      >
        <img
          key={currentItem.id}
          src={currentItem.url}
          alt={currentItem.name ?? "Media image"}
          onDoubleClick={handleDoubleClick}
          draggable={false}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: isDragging ? "none" : "transform 0.15s ease-out",
            maxHeight: "100%",
            maxWidth: "100%",
            objectFit: "contain",
          }}
          className="cursor-grab active:cursor-grabbing select-none"
        />

        {/* Previous / Next buttons when multiple items */}
        {items.length > 1 && index > 0 && (
          <button
            type="button"
            onClick={() => {
              setIndex((prev) => prev - 1);
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            aria-label={t("mediaViewer.previous")}
            className="absolute left-3 flex h-12 w-12 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 active:bg-black/90"
          >
            <ChevronLeft size={28} />
          </button>
        )}
        {items.length > 1 && index < items.length - 1 && (
          <button
            type="button"
            onClick={() => {
              setIndex((prev) => prev + 1);
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            aria-label={t("mediaViewer.next")}
            className="absolute right-3 flex h-12 w-12 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 active:bg-black/90"
          >
            <ChevronRight size={28} />
          </button>
        )}
      </main>
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 z-20 rounded-full bg-black/85 px-4 py-2 text-[13px] font-medium text-white shadow-xl backdrop-blur-md transition-all animate-[fade-in_0.15s_ease-out]"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
