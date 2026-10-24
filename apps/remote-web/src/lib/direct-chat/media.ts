import { DIRECT_IMAGE_INPUT_MAX_BYTES, sniffInlineAttachment } from "@minih-agent/shared";
import type { DirectChatMedia } from "./history-store.js";

export type ImageValidationResult =
  | { ok: true; mime: string; byteLength: number }
  | { ok: false; reason: "too-large" | "unsupported" | "corrupt" };

/**
 * Validate that bytes represent an allowed raster image format (PNG, JPEG, GIF, WebP)
 * within safe input byte budgets, using sniffing rather than trusted filenames.
 */
export function validateRasterImageBytes(
  bytes: Uint8Array,
  maxBytes: number = DIRECT_IMAGE_INPUT_MAX_BYTES,
): ImageValidationResult {
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, reason: "corrupt" };
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: "too-large" };
  }
  const sniffed = sniffInlineAttachment(bytes);
  if (!sniffed || sniffed.kind !== "image") {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: true, mime: sniffed.mimeType, byteLength: bytes.byteLength };
}

/**
 * Probe image dimensions safely in a browser/DOM environment.
 * Gracefully returns null if Image/createImageBitmap is unavailable or fails.
 */
export async function probeImageDimensions(
  data: Uint8Array | Blob,
  mime: string,
): Promise<{ width: number; height: number } | null> {
  if (typeof window === "undefined" || typeof Image === "undefined") {
    return null;
  }
  const blob = data instanceof Blob ? data : new Blob([data.slice()], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<{ width: number; height: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        resolve(null);
      };
      img.src = objectUrl;
    });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Create a transient blob URL for displaying saved media.
 * Callers or viewers should revoke it when unmounting.
 */
export function createMediaUrl(media: Pick<DirectChatMedia, "mime" | "data">): string {
  const blob = media.data instanceof Blob ? media.data : new Blob([media.data.slice()], { type: media.mime });
  return URL.createObjectURL(blob);
}

/**
 * Revoke a transient blob URL if it was created via URL.createObjectURL.
 */
export function revokeMediaUrl(url: string | undefined): void {
  if (url && url.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore invalid or already revoked URLs
    }
  }
}

/**
 * Convert a Blob to Uint8Array safely.
 */
export async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Convert Uint8Array to base64 string without overflowing the stack.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Decode standard base64 string to Uint8Array safely.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
