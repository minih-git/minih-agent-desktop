import { describe, expect, it } from "vitest";

import {
  declaredMimeMatches,
  decodeInlineAttachmentData,
  RACP_INLINE_ATTACHMENT_MAX_BYTES,
  sniffInlineAttachment,
} from "./racp-inline-attachments.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The slice of Node's `Buffer` a test may use; the client itself must not. */
type PlatformBuffer = {
  from(input: Uint8Array): { toString(encoding: "base64"): string };
};

/** Bytes shaped like a PNG, large enough to be one real generated image. */
function pngBytes(byteLength: number): Uint8Array {
  const image = new Uint8Array(byteLength);
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let index = 8; index < byteLength; index += 1) image[index] = (index * 31) % 256;
  return image;
}

/**
 * The Host takes what the bytes are, not what the client says they are.
 *
 * Every case here is a decision a phone can get wrong by accident (a screenshot
 * labelled `image/jpg`) or on purpose (a script labelled `image/png`).
 */
describe("sniffInlineAttachment", () => {
  it("recognises the four image formats a model reads", () => {
    expect(sniffInlineAttachment(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toEqual({
      mimeType: "image/png",
      kind: "image",
    });
    expect(sniffInlineAttachment(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00))).toEqual({
      mimeType: "image/jpeg",
      kind: "image",
    });
    expect(sniffInlineAttachment(text("GIF89a...."))).toEqual({ mimeType: "image/gif", kind: "image" });
    expect(sniffInlineAttachment(text("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ mimeType: "image/webp", kind: "image" });
  });

  it("takes UTF-8 text and refuses binary", () => {
    expect(sniffInlineAttachment(text("const a = 1\nconsole.log(a)\n"))).toEqual({
      mimeType: "text/plain; charset=utf-8",
      kind: "file",
    });
    // A NUL byte is the cheapest honest signal that a reader will see mojibake.
    expect(sniffInlineAttachment(bytes(0x61, 0x00, 0x62))).toBeNull();
    // Invalid UTF-8 is not text either; a lossy decode would hide that.
    expect(sniffInlineAttachment(bytes(0xff, 0xfe, 0xfd))).toBeNull();
    expect(sniffInlineAttachment(new Uint8Array())).toBeNull();
  });

  it("refuses SVG, which is markup rather than a picture", () => {
    expect(sniffInlineAttachment(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual({
      mimeType: "text/plain; charset=utf-8",
      kind: "file",
    });
  });
});

describe("declaredMimeMatches", () => {
  const png = { mimeType: "image/png", kind: "image" as const };
  const plain = { mimeType: "text/plain; charset=utf-8", kind: "file" as const };

  it("accepts an absent label and a matching one", () => {
    expect(declaredMimeMatches(undefined, png)).toBe(true);
    expect(declaredMimeMatches("image/png", png)).toBe(true);
    expect(declaredMimeMatches("IMAGE/PNG; charset=binary", png)).toBe(true);
  });

  it("refuses a label that disagrees with the bytes", () => {
    // `image/jpg` is not a type any registry defines; the bytes are the truth.
    expect(declaredMimeMatches("image/jpg", png)).toBe(false);
    expect(declaredMimeMatches("image/jpeg", png)).toBe(false);
    expect(declaredMimeMatches("text/plain", png)).toBe(false);
    // The dangerous direction: text dressed up as a picture a model would trust.
    expect(declaredMimeMatches("image/png", plain)).toBe(false);
  });

  it("lets a text file keep a text-ish description", () => {
    expect(declaredMimeMatches("text/markdown", plain)).toBe(true);
    expect(declaredMimeMatches("application/json", plain)).toBe(true);
    expect(declaredMimeMatches("application/ld+json", plain)).toBe(true);
  });
});

describe("decodeInlineAttachmentData", () => {
  it("decodes standard base64 with or without padding", () => {
    expect(Array.from(decodeInlineAttachmentData("aGk=") ?? [])).toEqual([0x68, 0x69]);
    expect(Array.from(decodeInlineAttachmentData("aGk") ?? [])).toEqual([0x68, 0x69]);
  });

  it("refuses a data URL, a truncated tail, and non-base64", () => {
    // The prefix is the client's habit, not the contract: refusing it keeps one
    // reading of the field instead of two.
    expect(decodeInlineAttachmentData("data:image/png;base64,aGk=")).toBeNull();
    expect(decodeInlineAttachmentData("aGk=aGk=")).toBeNull();
    expect(decodeInlineAttachmentData("not base64!")).toBeNull();
    expect(decodeInlineAttachmentData("")).toBeNull();
  });

  it("decodes a multi-megabyte image where the phone has no Buffer global", () => {
    // Regression: this used `Buffer.from`, which WKWebView does not have. The
    // ReferenceError was swallowed by a `catch` that read it as "not an image",
    // so a successful gateway answer surfaced as "the model gateway failed".
    const image = pngBytes(3 * 1024 * 1024 + 7);
    const platform = (globalThis as unknown as { Buffer?: PlatformBuffer }).Buffer;
    expect(platform).toBeDefined();
    const encoded = platform!.from(image).toString("base64");

    const globals = globalThis as unknown as { Buffer?: unknown };
    const original = globals.Buffer;
    let decoded: Uint8Array | null = null;
    try {
      delete globals.Buffer;
      decoded = decodeInlineAttachmentData(encoded);
    } finally {
      globals.Buffer = original;
    }

    expect(encoded.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(decoded?.byteLength).toBe(image.byteLength);
    // Length alone would pass for a value that decoded from the wrong offset;
    // the ends prove the whole string was read.
    expect(Array.from(decoded?.subarray(0, 8) ?? [])).toEqual(Array.from(image.subarray(0, 8)));
    expect(decoded?.at(-1)).toBe(image.at(-1));
  });
});

describe("inline budget", () => {
  it("fits one attachment and a paragraph inside maxPromptBytes", () => {
    // Base64 inflates by 4/3; the whole prompt is what has to fit, so the
    // per-attachment budget must leave room for the text as well.
    expect(RACP_INLINE_ATTACHMENT_MAX_BYTES * (4 / 3) + 16 * 1024).toBeLessThan(256 * 1024);
  });
});
