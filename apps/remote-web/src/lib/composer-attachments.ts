/**
 * What the composer does with a file the person picked (RACP §10 step 1).
 *
 * A phone sends bytes, not paths, and the inline budget is deliberately small
 * (the Host enforces the same numbers). So the work is split in two: an image is
 * downscaled until it fits, because a camera writes several megabytes and a model
 * reads a thumbnail just as well; a text file is sent as it is, or refused with a
 * reason. The sniffing is the Host's own function, imported from the shared
 * contract, so the client refuses what the Host would refuse instead of
 * discovering it after a round trip.
 */
import {
  RACP_INLINE_ATTACHMENT_MAX_BYTES,
  RACP_INLINE_ATTACHMENT_MAX_COUNT,
  RACP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES,
  sniffInlineAttachment,
  type RacpInlineAttachment,
} from "@minih-agent/shared";

/** One file on its way into a prompt. */
export type PendingAttachment = {
  /** Stable id for React keys and removal; not sent to the Host. */
  id: string;
  name: string;
  /** The type the client sniffed from the bytes, never the picker's claim. */
  mimeType: string;
  kind: "image" | "file";
  /** Raw bytes after any downscaling; this is what the per-file budget counts. */
  size: number;
  data: string;
  /** A data URL for the chip thumbnail; images only. */
  previewUrl?: string;
};

export type AttachmentRejection = "too-large" | "unsupported" | "too-many";

export type PrepareResult =
  | { ok: true; attachment: PendingAttachment }
  | { ok: false; reason: AttachmentRejection };

/** How many encoded bytes the prompt already spends on attachments. */
export function encodedBytes(attachments: readonly PendingAttachment[]): number {
  return attachments.reduce((total, attachment) => total + base64Length(attachment.data), 0);
}

function base64Length(data: string): number {
  const compact = data.replace(/\s+/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

/**
 * Whether one more file may join the prompt.
 *
 * Both ceilings come from the shared contract: a single attachment may not exceed
 * the per-file budget, and the prompt as a whole may not exceed the total one.
 * The total counts encoded bytes, because that is what crosses the wire; counting
 * raw bytes there would let a set of files pass here and fail at the Host.
 */
export function canAddAttachment(
  existing: readonly PendingAttachment[],
  attachment: Pick<PendingAttachment, "size" | "data">,
): { ok: true } | { ok: false; reason: AttachmentRejection } {
  if (existing.length >= RACP_INLINE_ATTACHMENT_MAX_COUNT) return { ok: false, reason: "too-many" };
  if (attachment.size > RACP_INLINE_ATTACHMENT_MAX_BYTES) return { ok: false, reason: "too-large" };
  if (encodedBytes(existing) + base64Length(attachment.data) > RACP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true };
}

/** The wire form `turn/start` takes. */
export function attachmentPayload(attachments: readonly PendingAttachment[]): RacpInlineAttachment[] {
  return attachments.map((attachment) => ({
    name: attachment.name,
    mimeType: attachment.mimeType,
    data: attachment.data,
  }));
}

/**
 * A fingerprint of a send attempt, so a retry is the same attempt only when the
 * files are the same files.
 *
 * Without the attachments in it, a failed send followed by adding a picture would
 * resend the first attempt's text under its old idempotency key and quietly drop
 * what the person added.
 */
export function attemptSignature(text: string, attachments: readonly { name: string; data: string }[]): string {
  return JSON.stringify([text, attachments.map((attachment) => [attachment.name, attachment.data])]);
}

export type DownscaleResult = { bytes: Uint8Array } | null;

/**
 * Read one picked file into a pending attachment, downscaling an image when it
 * has to.
 *
 * `downscale` is injected because the browser is where a canvas lives: this module
 * stays a decision table a unit test can drive with fixtures.
 */
export async function prepareAttachment(
  input: { name: string; bytes: Uint8Array; id: string },
  downscale: (bytes: Uint8Array, mimeType: string) => Promise<DownscaleResult>,
): Promise<PrepareResult> {
  const sniffed = sniffInlineAttachment(input.bytes);
  if (!sniffed) return { ok: false, reason: "unsupported" };
  let bytes = input.bytes;
  let mimeType = sniffed.mimeType;
  if (bytes.byteLength > RACP_INLINE_ATTACHMENT_MAX_BYTES) {
    // Only a picture can be made smaller without lying about it; a text file that
    // does not fit is refused rather than truncated behind the reader's back.
    if (sniffed.kind !== "image") return { ok: false, reason: "too-large" };
    const shrunk = await downscale(bytes, sniffed.mimeType);
    if (!shrunk) return { ok: false, reason: "too-large" };
    // The re-encoded bytes are sniffed again: the encoder may have produced a JPEG
    // where the source was a PNG, and the Host will read whatever these bytes are.
    const reshiffed = sniffInlineAttachment(shrunk.bytes);
    if (!reshiffed || reshiffed.kind !== "image") return { ok: false, reason: "too-large" };
    bytes = shrunk.bytes;
    mimeType = reshiffed.mimeType;
    if (bytes.byteLength > RACP_INLINE_ATTACHMENT_MAX_BYTES) return { ok: false, reason: "too-large" };
  }
  const data = toBase64(bytes);
  const attachment: PendingAttachment = {
    id: input.id,
    name: input.name,
    mimeType,
    kind: sniffed.kind,
    size: bytes.byteLength,
    data,
    ...(sniffed.kind === "image" ? { previewUrl: `data:${mimeType};base64,${data}` } : {}),
  };
  return { ok: true, attachment };
}

/** Base64 without a data-URL prefix: the one form the Host decodes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Spreading a multi-megabyte array over the arguments would overflow the stack;
  // this walks it in slices the engine can take.
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
