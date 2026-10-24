/**
 * Standard base64 into bytes, with no dependency on any runtime's globals.
 *
 * Shared code runs in three places that disagree about what exists: the
 * Electron main process, the desktop renderer, and a phone's WKWebView. Only the
 * first has `Buffer`; `atob` exists in the two browser ones but not in Node
 * before v16 and, more importantly, hands back a byte-per-character string. A
 * generated image is megabytes of base64, and on a phone that string is the
 * difference between decoding and being killed for memory.
 *
 * So this is written out: one pass, one output array, no intermediate string.
 *
 * The input is strict on purpose. Padding is allowed only at the very end, the
 * length must be one base64 can produce, and the unused bits of the final symbol
 * must be zero — otherwise a truncated or re-encoded value would decode to
 * plausible-looking shorter bytes instead of being refused. Callers that accept
 * whitespace strip it first; this function reads exactly the string it is given.
 */

/** Base64 alphabet, standard form. There is no URL-safe variant on this wire. */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Symbol value by character code, or `-1` for "not base64".
 *
 * An `Int16Array` rather than a `Map`: a lookup per character is the whole inner
 * loop, and a character past the ASCII range indexes nothing (`undefined`).
 */
const BASE64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/**
 * Decode standard base64 into bytes, or `null` when the text is not base64.
 *
 * `null` is the only failure: callers turn it into a named refusal ("this
 * attachment is not usable") rather than an exception an outer `catch` would
 * swallow into a generic error.
 */
export function decodeBase64ToBytes(text: string): Uint8Array | null {
  if (text.length === 0) return null;

  // Padding terminates the data; anything after it must be padding too, so one
  // `=` before the tail means the value is not base64.
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const end = text.length - padding;
  if (end === 0) return null;
  // A lone symbol cannot carry a byte, so no encoder produces one.
  if (end % 4 === 1) return null;
  if (padding > 0 && text.indexOf("=") !== end) return null;

  const output = new Uint8Array(Math.floor((end * 3) / 4));
  let written = 0;

  // Four symbols are exactly three bytes, so a fixed group keeps the arithmetic
  // inside 32 bits whatever the length of the string.
  const whole = end - (end % 4);
  for (let index = 0; index < whole; index += 4) {
    const first = BASE64_LOOKUP[text.charCodeAt(index)] ?? -1;
    const second = BASE64_LOOKUP[text.charCodeAt(index + 1)] ?? -1;
    const third = BASE64_LOOKUP[text.charCodeAt(index + 2)] ?? -1;
    const fourth = BASE64_LOOKUP[text.charCodeAt(index + 3)] ?? -1;
    if (first < 0 || second < 0 || third < 0 || fourth < 0) return null;
    const group = (first << 18) | (second << 12) | (third << 6) | fourth;
    output[written] = (group >> 16) & 0xff;
    output[written + 1] = (group >> 8) & 0xff;
    output[written + 2] = group & 0xff;
    written += 3;
  }

  const remainder = end % 4;
  if (remainder > 0) {
    // 2 symbols carry one byte and leave 4 bits unused; 3 carry two bytes and
    // leave 2. Those bits must be zero, which is what makes the input canonical
    // rather than a truncated tail of a longer value.
    let group = 0;
    const positions = end - remainder;
    for (let index = positions; index < end; index += 1) {
      const value = BASE64_LOOKUP[text.charCodeAt(index)] ?? -1;
      if (value < 0) return null;
      group = (group << 6) | value;
    }
    const bits = remainder * 6;
    const bytes = Math.floor(bits / 8);
    if ((group & ((1 << (bits - bytes * 8)) - 1)) !== 0) return null;
    for (let offset = 0; offset < bytes; offset += 1) {
      output[written] = (group >> (bits - 8 * (offset + 1))) & 0xff;
      written += 1;
    }
  }

  return written === output.length ? output : output.subarray(0, written);
}