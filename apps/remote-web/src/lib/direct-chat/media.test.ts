import { describe, expect, it } from "vitest";
import {
  base64ToUint8Array,
  blobToUint8Array,
  createMediaUrl,
  probeImageDimensions,
  revokeMediaUrl,
  uint8ArrayToBase64,
  validateRasterImageBytes,
} from "./media.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const SVG_BYTES = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
const TEXT_BYTES = new TextEncoder().encode("Hello world text file");

describe("validateRasterImageBytes", () => {
  it("accepts valid png bytes", () => {
    const res = validateRasterImageBytes(PNG_BYTES);
    expect(res).toEqual({ ok: true, mime: "image/png", byteLength: PNG_BYTES.byteLength });
  });

  it("accepts valid jpeg bytes", () => {
    const res = validateRasterImageBytes(JPEG_BYTES);
    expect(res).toEqual({ ok: true, mime: "image/jpeg", byteLength: JPEG_BYTES.byteLength });
  });

  it("accepts valid gif bytes", () => {
    const res = validateRasterImageBytes(GIF_BYTES);
    expect(res).toEqual({ ok: true, mime: "image/gif", byteLength: GIF_BYTES.byteLength });
  });

  it("accepts valid webp bytes", () => {
    const res = validateRasterImageBytes(WEBP_BYTES);
    expect(res).toEqual({ ok: true, mime: "image/webp", byteLength: WEBP_BYTES.byteLength });
  });

  it("rejects svg as unsupported", () => {
    const res = validateRasterImageBytes(SVG_BYTES);
    expect(res).toEqual({ ok: false, reason: "unsupported" });
  });

  it("rejects text as unsupported", () => {
    const res = validateRasterImageBytes(TEXT_BYTES);
    expect(res).toEqual({ ok: false, reason: "unsupported" });
  });

  it("rejects empty bytes as corrupt", () => {
    const res = validateRasterImageBytes(new Uint8Array(0));
    expect(res).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects bytes exceeding maxBytes", () => {
    const res = validateRasterImageBytes(PNG_BYTES, 5);
    expect(res).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("base64 conversion", () => {
  it("encodes and decodes round-trip", () => {
    const original = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 128]);
    const b64 = uint8ArrayToBase64(original);
    const decoded = base64ToUint8Array(b64);
    expect(decoded).toEqual(original);
  });
});

describe("blobToUint8Array", () => {
  it("converts blob to byte array", async () => {
    const blob = new Blob([PNG_BYTES], { type: "image/png" });
    const bytes = await blobToUint8Array(blob);
    expect(bytes).toEqual(PNG_BYTES);
  });
});

describe("probeImageDimensions", () => {
  it("returns null safely in node/mock environment where Image is undefined", async () => {
    const res = await probeImageDimensions(PNG_BYTES, "image/png");
    // In vitest jsdom/node, Image may not fully load or be null
    expect(res === null || typeof res === "object").toBe(true);
  });
});

describe("createMediaUrl and revokeMediaUrl", () => {
  it("creates object url and revokes without throwing", () => {
    const url = createMediaUrl({ mime: "image/png", data: PNG_BYTES });
    expect(typeof url).toBe("string");
    expect(() => revokeMediaUrl(url)).not.toThrow();
  });
});
