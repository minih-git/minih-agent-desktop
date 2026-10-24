/**
 * Reading a remote session's own media over RACP (D6, rollout B4).
 *
 * A remote screenshot or a generated image has to reopen after the phone
 * forgets everything, and the transcript only carries the attachment's name and
 * ref — never the bytes. This helper turns one of those transcript rows into a
 * `MediaViewerItem` by asking the Host for the image in bounded chunks.
 *
 * What it deliberately is not:
 *
 * - **not a filesystem reader.** The only input is an opaque media id taken from
 *   a transcript row's attachments; there is no path, URL, or ref parameter, so
 *   the phone cannot ask for a file the transcript did not record.
 * - **not a cache.** The object URL lives for one viewer and is revoked by
 *   `disposeSessionMedia`; nothing here writes to the durable direct-history
 *   database.
 * - **not a silent fallback.** An old Host (`CAPABILITY_UNAVAILABLE`), a blob the
 *   computer no longer has, and an image that changed on the Host each map to a
 *   distinct state the screen names, so a missing image never looks like a
 *   broken one.
 */
import {
  decodeBase64ToBytes,
  type SessionMediaReadRequest,
  type SessionMediaReadResponse,
} from "@minih-agent/shared";

import type { MediaViewerItem } from "../components/ui/MediaViewer.js";
import { failureFrom, type OperationFailure } from "./errors.js";

/** The narrow slice of the host client this helper needs. */
export type SessionMediaClient = {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type SessionMediaState =
  | { kind: "ready"; item: MediaViewerItem }
  /** The Host does not serve session media: the image needs a newer computer version. */
  | { kind: "unsupported" }
  /** The image was deleted or not found on the computer. */
  | { kind: "deleted" }
  /** The image content changed on the computer. */
  | { kind: "changed" }
  /** Access to this image is forbidden. */
  | { kind: "forbidden" }
  | { kind: "failed"; failure: OperationFailure };

/**
 * Chunk size requested per call.
 *
 * The Host refuses anything above `RACP_SESSION_MEDIA_MAX_CHUNK_BYTES`, so this
 * is that constant spelled out where a bundle does not need to carry it. It
 * keeps every answer well under the default frame limit.
 */
export const SESSION_MEDIA_CHUNK_BYTES = 512 * 1024;

/**
 * Ceiling on one full image. A transcript image is a screenshot or a generated
 * picture; anything larger is a file this viewer was never meant to open, and
 * refusing it keeps a phone from downloading a 200 MB blob over a cellular link.
 */
export const SESSION_MEDIA_MAX_IMAGE_BYTES = 32 * 1024 * 1024;


function reasonOf(error: unknown): string | undefined {
  const details = (error as { details?: unknown } | null)?.details;
  if (!details || typeof details !== "object") return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * One image from its chunks, in the order the Host sent them.
 *
 * Each chunk is decoded on its own before this, because the Host encodes each
 * one separately: joining the base64 text first would put a chunk's padding in
 * the middle of the value, where it means corruption rather than an ending.
 */
function joinChunks(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return joined;
}

function mediaUrl(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
}

/**
 * Read one transcript media item in bounded sequential chunks.
 *
 * Sequential on purpose: the chunks have to be concatenated in order, and a
 * parallel fan-out would multiply the peak memory by the concurrency for no gain
 * on a phone connection. A chunk that does not continue exactly where the last
 * one ended ends the read rather than producing a corrupt image.
 */
export async function readSessionMedia(
  client: SessionMediaClient,
  input: { sessionId: string; mediaId: string; name?: string },
): Promise<SessionMediaState> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let totalBytes = 0;
  let mime = "";
  try {
    for (;;) {
      const params: SessionMediaReadRequest = {
        sessionId: input.sessionId,
        mediaId: input.mediaId,
        offset,
        length: SESSION_MEDIA_CHUNK_BYTES,
      };
      const chunk = await client.request<SessionMediaReadResponse>("session/mediaRead", params);
      if (typeof chunk?.data !== "string" || typeof chunk.totalBytes !== "number" || typeof chunk.offset !== "number") {
        return { kind: "failed", failure: { code: "INTERNAL", message: "the host sent no media chunk", retriable: true } };
      }
      if (chunk.offset !== offset) {
        return {
          kind: "failed",
          failure: { code: "INTERNAL", message: "the host sent a media chunk out of order", retriable: true },
        };
      }
      if (chunk.totalBytes > SESSION_MEDIA_MAX_IMAGE_BYTES) {
        return {
          kind: "failed",
          failure: { code: "PAYLOAD_TOO_LARGE", message: "this image is too large to open", retriable: false },
        };
      }
      if (!mime) mime = chunk.mime;
      totalBytes = chunk.totalBytes;
      const bytes = decodeBase64ToBytes(chunk.data);
      if (!bytes) {
        return {
          kind: "failed",
          failure: { code: "INTERNAL", message: "the host sent a media chunk that is not base64", retriable: false },
        };
      }
      // The Host encodes each chunk on its own, so what advances the read is the
      // byte count of the decoded chunk: a chunk boundary that does not fall on a
      // 3-byte group leaves padding the next chunk cannot share.
      if (bytes.byteLength === 0) {
        return { kind: "failed", failure: { code: "INTERNAL", message: "the host sent an empty media chunk", retriable: true } };
      }
      parts.push(bytes);
      offset += bytes.byteLength;
      if (offset >= totalBytes) break;
    }
    const bytes = joinChunks(parts);
    return {
      kind: "ready",
      item: { id: input.mediaId, url: mediaUrl(bytes, mime), mime, ...(input.name ? { name: input.name } : {}) },
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "CAPABILITY_UNAVAILABLE") return { kind: "unsupported" };
    if (code === "FORBIDDEN" || code === "REMOTE_PATH_FORBIDDEN") return { kind: "forbidden" };
    const reason = reasonOf(error);
    if (reason === "media-changed") return { kind: "changed" };
    if (
      reason === "media-unavailable" ||
      reason === "media-not-in-session" ||
      code === "NOT_FOUND" ||
      code === "REMOTE_PATH_NOT_FOUND"
    ) {
      return { kind: "deleted" };
    }
    return { kind: "failed", failure: failureFrom(error) };
  }
}

/** Release the transient bytes of one item; a revoked view calls this. */
export function disposeSessionMedia(item: MediaViewerItem | null | undefined): void {
  if (!item) return;
  if (item.url.startsWith("blob:")) URL.revokeObjectURL(item.url);
}