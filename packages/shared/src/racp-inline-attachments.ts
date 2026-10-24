/**
 * Inline attachments for `turn/start` (RACP §10 step 1, §16.2).
 *
 * A phone has no way to hand a Host a file path, so the first supported form
 * carries the bytes inside the prompt. Two rules make that safe and keep it
 * honest:
 *
 * - the Host believes the bytes, not the label: the MIME type is sniffed from
 *   magic numbers (or from the fact that the bytes decode as UTF-8 text), and a
 *   declared type that disagrees with the content is refused rather than
 *   trusted; and
 * - the whole prompt, text and encoded attachments together, stays inside
 *   `maxPromptBytes`, so an inline request can never approach `maxFrameBytes`.
 *
 * The budget is small on purpose. A phone photo is several megabytes, so the
 * client downscales an image before sending it; what crosses the wire is what a
 * model reads, not what the camera wrote.
 */
import Type, { type Static } from "typebox";

import { decodeBase64ToBytes } from "./base64.js";
/**
 * Raw bytes one inline attachment may carry.
 *
 * Base64 inflates by 4/3, so 160 KiB of bytes arrive as ~213 KiB of text; with a
 * paragraph of prompt beside it the request still clears `maxPromptBytes`
 * (256 KiB) instead of exactly reaching it. Several attachments share that same
 * prompt budget, which the Host checks as a sum.
 */
export const RACP_INLINE_ATTACHMENT_MAX_BYTES = 160 * 1024;

/** How many attachments one prompt may carry; each also counts against the budget. */
export const RACP_INLINE_ATTACHMENT_MAX_COUNT = 6;

/**
 * Encoded bytes one prompt may spend on attachments.
 *
 * The prompt text keeps the rest of `maxPromptBytes` (256 KiB), and the request
 * as a whole stays far under `maxFrameBytes`. In practice this is about one
 * downscaled photograph or several small text files per message, which is the
 * honest limit of a form that travels inside the prompt.
 */
export const RACP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES = 224 * 1024;

/**
 * One attachment inside `turn/start`.
 *
 * `data` is standard base64 with no data-URL prefix. `mimeType` is what the
 * client believes the bytes are — the Host re-derives it and refuses a
 * disagreement instead of forwarding the claim to a model.
 */
export const RacpInlineAttachmentSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  mimeType: Type.Optional(Type.String({ maxLength: 255 })),
  data: Type.String({ minLength: 1 }),
});
export type RacpInlineAttachment = Static<typeof RacpInlineAttachmentSchema>;

export type SniffedAttachment = {
  /** The type the bytes really are, parameters included where it matters. */
  mimeType: string;
  kind: "image" | "file";
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * What these bytes are, or `null` when the answer is "something we do not take".
 *
 * Only the four image formats a model can read are recognised by signature; SVG
 * is deliberately absent (it is markup that can carry script) and everything
 * else must be UTF-8 text, which is the one non-image form a phone can usefully
 * send inline. A NUL byte anywhere means binary: a file the model cannot read is
 * refused rather than shipped as mojibake.
 */
export function sniffInlineAttachment(bytes: Uint8Array): SniffedAttachment | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, PNG_SIGNATURE)) return { mimeType: "image/png", kind: "image" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", kind: "image" };
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return { mimeType: "image/gif", kind: "image" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { mimeType: "image/webp", kind: "image" };
  }
  if (bytes.includes(0)) return null;
  try {
    // `fatal` is the point: a decoding failure means these are not text, and a
    // lossy decode would turn one binary blob into plausible-looking prose.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return { mimeType: "text/plain; charset=utf-8", kind: "file" };
}

/**
 * Whether the client's label agrees with the bytes.
 *
 * A label is advice, so it may be absent, and a text file may be described by
 * any text-ish type. It may not turn text into an image or one image into
 * another: that is the shape of an attempt to make the Host hand a model
 * something it did not choose.
 */
export function declaredMimeMatches(declared: string | undefined, sniffed: SniffedAttachment): boolean {
  if (!declared) return true;
  const base = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!base) return true;
  const sniffedBase = sniffed.mimeType.split(";", 1)[0]?.toLowerCase() ?? sniffed.mimeType;
  if (sniffed.kind === "image") return base === sniffedBase;
  if (base.startsWith("image/")) return false;
  return base.startsWith("text/") || base === "application/json" || base === "application/xml" || base.endsWith("+json") || base.endsWith("+xml");
}
/**
 * Base64 as it arrives on the wire; a data-URL prefix is refused, not stripped.
 *
 * The bytes come from the shared decoder rather than `Buffer.from`: this function
 * is reachable from the phone client, where `Buffer` does not exist, and a bare
 * `Buffer.from` there threw inside a `catch` that read it as "not an image".
 */
export function decodeInlineAttachmentData(data: string): Uint8Array | null {
  if (data.startsWith("data:")) return null;
  const compact = data.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  // The decoder refuses a non-canonical tail as well, so a truncated value stays
  // a refusal instead of decoding to a shorter byte string.
  return decodeBase64ToBytes(compact);
}
