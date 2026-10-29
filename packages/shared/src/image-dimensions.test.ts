import { describe, expect, it } from "vitest";
import { imageExceedsInlineDimensions, MAX_INLINE_IMAGE_EDGE_PX, omittedImageNotice, probeBase64ImageDimensions, probeImageDimensions } from "./image-dimensions.js";
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}
function jpeg(width: number, height: number, exifBytes = 16, segments = 1): Uint8Array {
  const app1 = [0xff, 0xe1, ((exifBytes + 2) >> 8) & 0xff, (exifBytes + 2) & 0xff];
  const sof = [0xff, 0xc2, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
  const segment = app1.length + exifBytes;
  const bytes = new Uint8Array(2 + segment * segments + sof.length + 9);
  bytes.set([0xff, 0xd8]);
  for (let index = 0; index < segments; index++) bytes.set(app1, 2 + segment * index);
  bytes.set(sof, 2 + segment * segments);
  return bytes;
}
function riff(chunk: string, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(16 + payload.length);
  bytes.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from(chunk)]);
  bytes.set(payload, 16); return bytes;
}
describe("image dimensions", () => {
  it("reads PNG, JPEG and GIF headers", () => {
    expect(probeImageDimensions(png(780, 14182))).toEqual({ width: 780, height: 14182 });
    expect(probeImageDimensions(jpeg(1688, 1514))).toEqual({ width: 1688, height: 1514 });
    expect(probeImageDimensions(Uint8Array.from([...Buffer.from("GIF89a"), 0x40, 1, 0xc8, 0, 0, 0, 0])))
      .toEqual({ width: 320, height: 200 });
  });
  it("reads all WebP layouts", () => {
    expect(probeImageDimensions(riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0x0b, 3, 0, 0x65, 0x37, 0])))
      .toEqual({ width: 780, height: 14182 });
    const bits = (780 - 1) | ((1000 - 1) << 14);
    expect(probeImageDimensions(riff("VP8L", [0, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, bits >>> 24])))
      .toEqual({ width: 780, height: 1000 });
    expect(probeImageDimensions(riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x9d, 1, 0x2a, 0x0c, 3, 0xe8, 3])))
      .toEqual({ width: 780, height: 1000 });
  });
  it("keeps unknown or truncated headers undecided", () => {
    for (const bytes of [new TextEncoder().encode("unknown"), png(10, 10).slice(0, 20), Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])]) {
      expect(probeImageDimensions(bytes)).toBeUndefined();
    }
    expect(probeBase64ImageDimensions("%%%")).toBeUndefined();
  });
  it("supports nonzero byte offsets", () => {
    const bytes = new Uint8Array(40); bytes.set(png(12, 34), 5);
    expect(probeImageDimensions(bytes.subarray(5))).toEqual({ width: 12, height: 34 });
  });
  it("finds JPEG geometry beyond large EXIF blocks", () => {
    expect(probeBase64ImageDimensions(Buffer.from(png(780, 14182)).toString("base64"))).toEqual({ width: 780, height: 14182 });
    expect(probeBase64ImageDimensions(Buffer.from(jpeg(9000, 600, 60000, 2)).toString("base64"))).toEqual({ width: 9000, height: 600 });
  });
  it("rejects only known edges exceeding 8000 pixels", () => {
    expect(imageExceedsInlineDimensions({ width: 780, height: 14182 })).toBe(true);
    expect(imageExceedsInlineDimensions({ width: MAX_INLINE_IMAGE_EDGE_PX, height: 10 })).toBe(false);
    expect(imageExceedsInlineDimensions(undefined)).toBe(false);
    expect(omittedImageNotice({ width: 780, height: 14182 })).toBe("[Image omitted: 780x14182 px exceeds the 8000 px longest-edge limit for model input.]");
  });
});
