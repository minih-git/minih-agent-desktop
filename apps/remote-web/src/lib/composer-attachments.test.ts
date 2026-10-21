import { describe, expect, it } from "vitest";

import {
  RACP_INLINE_ATTACHMENT_MAX_BYTES,
  RACP_INLINE_ATTACHMENT_MAX_COUNT,
  RACP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES,
} from "@minih-agent/shared";

import {
  attachmentPayload,
  attemptSignature,
  canAddAttachment,
  encodedBytes,
  type PendingAttachment,
  prepareAttachment,
  toBase64,
} from "./composer-attachments.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const text = (value: string) => new TextEncoder().encode(value);

const noDownscale = async () => null;

function pending(overrides: Partial<PendingAttachment> = {}): PendingAttachment {
  const data = toBase64(PNG);
  return {
    id: "a1",
    name: "shot.png",
    mimeType: "image/png",
    kind: "image",
    size: PNG.byteLength,
    data,
    ...overrides,
  };
}

/**
 * The client half of §10 step 1: what it is willing to put in a prompt.
 *
 * The Host re-checks all of this, so these tests exist to keep the phone from
 * finding out about a refusal after a round trip — and to keep the two budgets
 * (per file, per prompt) reading the same numbers the Host reads.
 */
describe("prepareAttachment", () => {
  it("takes a small picture as it is", async () => {
    const result = await prepareAttachment({ name: "shot.png", bytes: PNG, id: "a1" }, noDownscale);
    expect(result.ok && result.attachment).toMatchObject({ kind: "image", mimeType: "image/png", size: PNG.byteLength });
    expect(result.ok && result.attachment.previewUrl?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("takes a text file without a preview", async () => {
    const result = await prepareAttachment({ name: "main.ts", bytes: text("const a = 1\n"), id: "a2" }, noDownscale);
    expect(result.ok && result.attachment.kind).toBe("file");
    expect(result.ok && result.attachment.previewUrl).toBeUndefined();
  });

  it("refuses bytes no reader could use", async () => {
    const binary = Uint8Array.from([0x61, 0x00, 0x62]);
    expect(await prepareAttachment({ name: "blob", bytes: binary, id: "a3" }, noDownscale)).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("downscales an over-budget picture and re-reads what it produced", async () => {
    const huge = new Uint8Array(RACP_INLINE_ATTACHMENT_MAX_BYTES + 1);
    huge.set(PNG.subarray(0, 8), 0);
    const shrunk = await prepareAttachment({ name: "big.png", bytes: huge, id: "a4" }, async () => ({ bytes: PNG }));
    expect(shrunk.ok).toBe(true);
    // The encoder here answered with a PNG, so the sniffed type stays a PNG even
    // though the source was "big.png".
    expect(shrunk.ok && shrunk.attachment.size).toBe(PNG.byteLength);
  });

  it("refuses an over-budget picture the encoder could not shrink", async () => {
    const huge = new Uint8Array(RACP_INLINE_ATTACHMENT_MAX_BYTES + 1);
    huge.set(PNG.subarray(0, 8), 0);
    expect(await prepareAttachment({ name: "big.png", bytes: huge, id: "a5" }, noDownscale)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("refuses an over-budget text file instead of truncating it", async () => {
    const big = new Uint8Array(RACP_INLINE_ATTACHMENT_MAX_BYTES + 1).fill(0x61);
    expect(await prepareAttachment({ name: "log.txt", bytes: big, id: "a6" }, noDownscale)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});

describe("budgets", () => {
  it("counts the encoded bytes the Host will count", () => {
    const attachment = pending();
    // `toBase64` of a 10-byte payload is 16 characters, which is 12 bytes decoded;
    // the composer must count raw bytes, not the larger encoded string.
    expect(encodedBytes([attachment])).toBe(PNG.byteLength);
    expect(attachment.data.length).toBeGreaterThan(PNG.byteLength);
  });

  it("stops at the per-file ceiling", () => {
    const big = pending({ size: RACP_INLINE_ATTACHMENT_MAX_BYTES + 1 });
    expect(canAddAttachment([], big)).toEqual({ ok: false, reason: "too-large" });
  });

  it("stops when the prompt budget is spent even though each file fits", () => {
    const chunk = pending({ size: RACP_INLINE_ATTACHMENT_MAX_BYTES, data: toBase64(new Uint8Array(RACP_INLINE_ATTACHMENT_MAX_BYTES)) });
    const accepted: PendingAttachment[] = [];
    // Fill the prompt until the next file would cross the total, and check the
    // refusal is the total one rather than the per-file one.
    while (accepted.length < RACP_INLINE_ATTACHMENT_MAX_COUNT) {
      const verdict = canAddAttachment(accepted, chunk);
      if (!verdict.ok) {
        expect(verdict.reason).toBe("too-large");
        expect(encodedBytes(accepted)).toBeLessThanOrEqual(RACP_INLINE_ATTACHMENT_MAX_TOTAL_BYTES);
        return;
      }
      accepted.push({ ...chunk, id: `a${accepted.length}` });
    }
    throw new Error("the prompt budget never ran out");
  });

  it("stops at the count ceiling", () => {
    const one = pending();
    const full = Array.from({ length: RACP_INLINE_ATTACHMENT_MAX_COUNT }, (_, index) => ({ ...one, id: `a${index}` }));
    expect(canAddAttachment(full, one)).toEqual({ ok: false, reason: "too-many" });
  });
});

describe("the wire form", () => {
  it("sends name, sniffed type, and bytes — never the id or a data URL", () => {
    const payload = attachmentPayload([pending()]);
    expect(payload).toEqual([{ name: "shot.png", mimeType: "image/png", data: toBase64(PNG) }]);
    expect(payload[0]).not.toHaveProperty("previewUrl");
  });

  it("keeps a retry the same attempt only while the files are the same", () => {
    const first = attachmentPayload([pending()]);
    const same = attachmentPayload([pending()]);
    const more = attachmentPayload([pending(), pending({ id: "a2", name: "second.png" })]);
    expect(attemptSignature("look", first)).toBe(attemptSignature("look", same));
    // Adding a picture after a failed send must produce a new key, or the Host
    // replays the first attempt and the picture is dropped.
    expect(attemptSignature("look", first)).not.toBe(attemptSignature("look", more));
    expect(attemptSignature("look", first)).not.toBe(attemptSignature("look again", first));
  });
});

describe("toBase64", () => {
  it("encodes without a data-URL prefix", () => {
    expect(toBase64(text("hi"))).toBe("aGk=");
  });
});
