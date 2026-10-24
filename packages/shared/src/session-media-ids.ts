/**
 * The identity of a session image, shared by every path that hands one to a
 * client.
 *
 * A phone can only reopen an image through `session/mediaRead`, and it can only
 * name one when the item it received carries a `mediaId`. Two projections build
 * those items — the history read (`session/history`) and the live event stream —
 * and a client that received the live item never refetches history, so both must
 * agree. They live here rather than in the Host runtime for that reason, and
 * because the encoding is a wire format the clients already hold.
 *
 * Nothing here touches a Node global: the same module is bundled into the phone.
 */
import type { MessageAttachment } from "./types/messages.js";

/** Prefix of every session media id. */
export const SESSION_MEDIA_ID_PREFIX = "media_";

/**
 * Raster types `session/mediaRead` can serve. SVG is markup that can carry
 * script and is deliberately absent, exactly as inline attachments treat it.
 */
export const SESSION_MEDIA_RASTER_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** `attachments/<sha256>`: the only ref shape the Host can read back as media. */
export const SESSION_MEDIA_REF: RegExp = /^attachments\/[0-9a-f]{64}$/;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Base64url of UTF-8 text, without padding.
 *
 * Written out instead of `Buffer.from(..., "base64url")` because this module is
 * bundled into the phone; the bytes are ids and short row names, so the loop is
 * trivial and the output is byte-identical to the Node built-in.
 */
function base64UrlOfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >> 2];
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    encoded += BASE64URL_ALPHABET[third & 0x3f];
  }
  return encoded;
}

/**
 * The opaque media id of one attachment row.
 *
 * The row id belongs to one message, so it is unique inside a session (the
 * desktop mints `att-<uuid>` / `a-<n>` row ids), but scoping it to the message
 * makes a collision across two sessions structurally unable to resolve: the id
 * is only ever matched in the transcript the caller named.
 *
 * The id is base64url of `<messageId>/<rowId>` with a `media_` prefix. Both
 * halves are literal strings, so the separator is unambiguous.
 */
export function encodeSessionMediaId(messageId: string, rowId: string): string {
  return `${SESSION_MEDIA_ID_PREFIX}${base64UrlOfText(`${messageId}/${rowId}`)}`;
}

/**
 * The identity of one attachment row inside its message.
 *
 * The desktop mints row ids for attachments it stores itself (`att-<uuid>`,
 * `a-<n>`), and an attachment that carries one keeps using it. A message read
 * back from a Host session record has no such field — host-core's
 * `MessageAttachment` is kind/name/ref/mimeType/size and nothing to address it
 * by — so the row's position in the message is the identity that always exists.
 * It is stable: the transcript hands the same array back on every read, and both
 * the writer ({@link withSessionMediaIds}) and the reader walk it in the same
 * order.
 */
export function sessionAttachmentRowId(attachment: Pick<MessageAttachment, "id">, index: number): string {
  const explicit = String(attachment.id ?? "").trim();
  return explicit || `idx-${index}`;
}

/**
 * Whether `session/mediaRead` could serve this attachment.
 *
 * An item names a `mediaId` only where the reader would accept the row, so a
 * client is never handed an id for an image the Host cannot read back: a
 * workspace PDF, a session link, an SVG, or a legacy absolute path stays a plain
 * attachment and is described by name instead.
 */
export function isSessionMediaAttachment(attachment: MessageAttachment): boolean {
  if (attachment.kind !== "image") return false;
  const mimeType = String(attachment.mimeType ?? "").trim().toLowerCase();
  if (!SESSION_MEDIA_RASTER_MIME.has(mimeType)) return false;
  return SESSION_MEDIA_REF.test(String(attachment.ref ?? "").trim().replace(/\\/g, "/"));
}

/**
 * The message a client receives, with a `mediaId` on every readable image.
 *
 * Every other field is passed through untouched, and a message without readable
 * media is returned as the same object — the projection must not copy on the
 * hot path of a transcript read.
 */
export function withSessionMediaIds<
  T extends { id: string; attachments?: MessageAttachment[]; role?: string; toolResult?: unknown },
>(message: T): T {
  const existing = Array.isArray(message.attachments) ? message.attachments : [];
  // A generated image is reported by the tool, not attached by the user: its
  // rows are synthesized here so the reader, the Host projections and the phone
  // all see one attachment list.
  const generated = generatedImageAttachments(message);
  const attachments = generated.length > 0 ? [...existing, ...generated] : existing;
  if (!message.id || attachments.length === 0) return message;
  let projected = false;
  const annotated = attachments.map((attachment, index) => {
    if (!isSessionMediaAttachment(attachment)) return attachment;
    projected = true;
    return { ...attachment, mediaId: encodeSessionMediaId(message.id, sessionAttachmentRowId(attachment, index)) };
  });
  return projected ? ({ ...message, attachments: annotated } as T) : message;
}


/** Row id of the n-th image a generation tool reported. */
export function generatedImageRowId(index: number): string {
  return `img-${index}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** The result entries of a `generated-images` tool payload, if this is one. */
function generatedImagesOf(message: { role?: string; toolResult?: unknown }): unknown[] {
  if (message.role !== "tool") return [];
  const result = asObject(asJson(message.toolResult));
  const fromContent = Array.isArray(result?.content)
    ? result.content
        .map((block) => asObject(asJson(asObject(block)?.text)))
        .find((payload) => payload?.kind === "generated-images")
    : undefined;
  const payload = fromContent ?? (result?.kind === "generated-images" ? result : undefined);
  return Array.isArray(payload?.results) ? payload.results : [];
}

/**
 * The images a generation tool reported, as attachment rows.
 *
 * The tool writes PNGs into the session's scratch directory and reports them by
 * absolute path, which only the computer that produced them can open. When it
 * also stored the bytes as `attachments/<sha256>`, that ref is what a remote
 * client reads back, so the tool's own result becomes the message's media and
 * the row id is its position in that list (`img-<n>`).
 */
export function generatedImageAttachments(message: {
  role?: string;
  toolResult?: unknown;
}): MessageAttachment[] {
  const attachments: MessageAttachment[] = [];
  for (const [index, entry] of generatedImagesOf(message).entries()) {
    const item = asObject(entry);
    if (!item) continue;
    // A failed or cancelled operation has no image to serve.
    if (item.status !== undefined && item.status !== "succeeded") continue;
    const ref = typeof item.ref === "string" ? item.ref.trim() : "";
    if (!SESSION_MEDIA_REF.test(ref.replace(/\\/g, "/"))) continue;
    const mimeType = typeof item.mimeType === "string" ? item.mimeType.trim().toLowerCase() : "image/png";
    if (!SESSION_MEDIA_RASTER_MIME.has(mimeType)) continue;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `image-${index + 1}.png`;
    attachments.push({
      kind: "image",
      name,
      ref,
      mimeType,
      ...(typeof item.size === "number" ? { size: item.size } : {}),
      id: generatedImageRowId(index),
    });
  }
  return attachments;
}
/** An attachment that carries the id a client uses to read its bytes back. */
export type SessionMediaAttachment = MessageAttachment & { mediaId: string };