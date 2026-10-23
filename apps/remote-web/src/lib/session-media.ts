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
import type { SessionMediaReadRequest, SessionMediaReadResponse } from "@minih-agent/shared";

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

/** Base64 alphabet, standard form (the Host never emits URL-safe here). */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) table[BASE64_ALPHABET.charCodeAt(index)] = index;
  return table;
})();

/**
 * Decode standard base64 into bytes, or `null` when the text is not base64.
 *
 * Written out rather than delegated to `atob`: a multi-chunk image is megabytes
 * of base64, and a decoder over the whole string must neither depend on a
 * particular runtime's input ceiling nor allocate a second byte-per-char string.
 * Padding is accepted only at the end.
 */
export function base64ToBytes(text: string): Uint8Array | null {
  // A standard base64 string is a whole number of 4-character groups, with at
  // most two `=` of padding at the very end.
  if (text.length % 4 !== 0) return null;
  // `=` both terminates the data and pads it to the group boundary, so the
  // first one is where decoding stops — everything after it is padding.
  const terminator = text.indexOf("=");
  const end = terminator < 0 ? text.length : terminator;
  if (end % 4 === 1) return null;
  const output = new Uint8Array(Math.floor((end * 3) / 4));
  let written = 0;
  // Four symbols are exactly three bytes, so a fixed group keeps the arithmetic
  // in 32-bit range whatever the length of the string.
  for (let index = 0; index < end - (end % 4); index += 4) {
    const first = BASE64_LOOKUP[text.charCodeAt(index)];
    const second = BASE64_LOOKUP[text.charCodeAt(index + 1)];
    const third = BASE64_LOOKUP[text.charCodeAt(index + 2)];
    const fourth = BASE64_LOOKUP[text.charCodeAt(index + 3)];
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined ||
      first < 0 ||
      second < 0 ||
      third < 0 ||
      fourth < 0
    ) {
      // A character past ASCII indexes nothing, and a non-base64 one answered
      // `-1`; both mean this is not base64, never a byte to guess at.
      return null;
    }
    const group = (first << 18) | (second << 12) | (third << 6) | fourth;
    output[written] = (group >> 16) & 0xff;
    output[written + 1] = (group >> 8) & 0xff;
    output[written + 2] = group & 0xff;
    written += 3;
  }
  // The final partial group (only reachable without padding) still carries the
  // high bits of the bytes it holds.
  const remainder = end % 4;
  if (remainder > 0) {
    const base = end - remainder;
    let group = 0;
    let bits = 0;
    for (let index = base; index < end; index += 1) {
      const value = BASE64_LOOKUP[text.charCodeAt(index)];
      if (value === undefined || value < 0) return null;
      group = (group << 6) | value;
      bits += 6;
    }
    const bytes = Math.floor(bits / 8);
    for (let offset = 0; offset < bytes; offset += 1) {
      output[written] = (group >> (bits - 8 * (offset + 1))) & 0xff;
      written += 1;
    }
  }
  return written === output.length ? output : output.subarray(0, written);
}

/** How many bytes one base64 chunk carries, without decoding it twice. */
function decodedLength(base64: string): number {
  const end = base64.endsWith("==") ? base64.length - 2 : base64.endsWith("=") ? base64.length - 1 : base64.length;
  return Math.floor((end * 3) / 4);
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
  const chunks: string[] = [];
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
      chunks.push(chunk.data);
      const advanced = decodedLength(chunk.data);
      if (advanced <= 0) {
        return { kind: "failed", failure: { code: "INTERNAL", message: "the host sent an empty media chunk", retriable: true } };
      }
      offset += advanced;
      if (offset >= totalBytes) break;
    }
    const bytes = base64ToBytes(chunks.join(""));
    if (!bytes) {
      return { kind: "failed", failure: { code: "INTERNAL", message: "the image bytes could not be decoded", retriable: false } };
    }
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