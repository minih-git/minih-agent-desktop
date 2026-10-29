/** Header-only image admission adapted from upstream 49f23668d (#1913). */
export const MAX_INLINE_IMAGE_EDGE_PX = 8000;
export type ImageDimensions = { width: number; height: number };

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  return bytes.length >= offset + text.length &&
    [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
}
function u16(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return littleEndian
    ? bytes[offset]! | (bytes[offset + 1]! << 8)
    : (bytes[offset]! << 8) | bytes[offset + 1]!;
}
function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}
function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16(bytes, offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return { width: u16(bytes, offset + 7), height: u16(bytes, offset + 5) };
    }
    offset += 2 + length;
  }
  return undefined;
}

/** Unknown and truncated headers remain subject to the existing byte limit. */
export function probeImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (ascii(bytes, 0, "\x89PNG\r\n\x1a\n")) {
    if (bytes.length < 24 || !ascii(bytes, 12, "IHDR")) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegDimensions(bytes);
  if (ascii(bytes, 0, "GIF8") && bytes.length >= 10) {
    return { width: u16(bytes, 6, true), height: u16(bytes, 8, true) };
  }
  if (!ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return undefined;
  if (ascii(bytes, 12, "VP8X") && bytes.length >= 30) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (ascii(bytes, 12, "VP8L") && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(bytes, 12, "VP8 ") && bytes.length >= 30 &&
      bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: u16(bytes, 26, true) & 0x3fff, height: u16(bytes, 28, true) & 0x3fff };
  }
  return undefined;
}

function decodePrefix(data: string, chars: number): Uint8Array | undefined {
  const prefix = data.slice(0, chars - (chars % 4)).replace(/=+$/, "");
  try {
    const binary = atob(prefix.length % 4 === 1 ? prefix.slice(0, -1) : prefix);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}
const BASE64_HEADER_CHARS = 87_384;

/** Decode only the header, except JPEGs with large EXIF segments before SOF. */
export function probeBase64ImageDimensions(data: string): ImageDimensions | undefined {
  const head = decodePrefix(data, BASE64_HEADER_CHARS);
  if (!head) return undefined;
  const dimensions = probeImageDimensions(head);
  if (dimensions || data.length <= BASE64_HEADER_CHARS) return dimensions;
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return undefined;
  const full = decodePrefix(data, data.length + 4);
  return full ? probeImageDimensions(full) : undefined;
}

export function imageExceedsInlineDimensions(
  dimensions: ImageDimensions | undefined,
): dimensions is ImageDimensions {
  return dimensions !== undefined && Math.max(dimensions.width, dimensions.height) > MAX_INLINE_IMAGE_EDGE_PX;
}
export function omittedImageNotice(dimensions: ImageDimensions): string {
  return `[Image omitted: ${dimensions.width}x${dimensions.height} px exceeds the ${MAX_INLINE_IMAGE_EDGE_PX} px longest-edge limit for model input.]`;
}
