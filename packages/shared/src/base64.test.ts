import { describe, expect, it } from "vitest";

import { decodeBase64ToBytes } from "./base64.js";

/** The slice of Node's `Buffer` a test may use; the client itself must not. */
type PlatformBuffer = {
  from(input: Uint8Array): { toString(encoding: "base64"): string };
};

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe("decodeBase64ToBytes", () => {
  it("decodes standard base64 with and without padding", () => {
    expect(decodeBase64ToBytes("aGk=")).toEqual(bytes(0x68, 0x69));
    expect(decodeBase64ToBytes("aGk")).toEqual(bytes(0x68, 0x69));
    expect(decodeBase64ToBytes("aGVsbG8=")).toEqual(bytes(0x68, 0x65, 0x6c, 0x6c, 0x6f));
    expect(decodeBase64ToBytes("aGVsbG8")).toEqual(bytes(0x68, 0x65, 0x6c, 0x6c, 0x6f));
  });

  it("refuses a value that no encoder produces", () => {
    // Empty is not an image and not a zero-byte file: it is a missing field.
    expect(decodeBase64ToBytes("")).toBeNull();
    // A lone symbol carries no byte.
    expect(decodeBase64ToBytes("a")).toBeNull();
    expect(decodeBase64ToBytes("=")).toBeNull();
    expect(decodeBase64ToBytes("====")).toBeNull();
    // Padding terminates the data, so it cannot appear in the middle.
    expect(decodeBase64ToBytes("aG=k")).toBeNull();
    expect(decodeBase64ToBytes("aGk=aGk=")).toBeNull();
    // Not base64 at all.
    expect(decodeBase64ToBytes("not base64!")).toBeNull();
    expect(decodeBase64ToBytes("aG\u00e9=")).toBeNull();
  });

  it("refuses a non-canonical tail instead of decoding a shorter value", () => {
    // "aG" and "aGl" carry the high bits of a byte that a longer value would
    // continue; accepting them would turn a truncated image into a plausible
    // shorter one.
    expect(decodeBase64ToBytes("aG")).toBeNull();
    expect(decodeBase64ToBytes("aGl")).toBeNull();
  });

  it("reads exactly the string it is given", () => {
    // Whitespace is the caller's policy: this function is also handed megabytes
    // of chunked data where a stray newline means the stream is corrupt.
    expect(decodeBase64ToBytes(" aGk=")).toBeNull();
    expect(decodeBase64ToBytes("aGk=\n")).toBeNull();
  });

  it("agrees with the platform encoder on every length and tail", () => {
    // A differential check against the runtime's own encoder (test-only: the
    // phone has none) so the hand-written loop cannot drift from what encoders
    // actually emit.
    const platform = (globalThis as unknown as { Buffer?: PlatformBuffer }).Buffer;
    expect(platform).toBeDefined();
    // Length 0 is excluded: a missing field is refused above, and the encoder's
    // empty string is not a value this wire ever carries.
    for (let length = 1; length <= 64; length += 1) {
      const source = Uint8Array.from({ length }, (_, index) => (index * 37 + length) % 256);
      const encoded = platform!.from(source).toString("base64");
      expect(decodeBase64ToBytes(encoded)).toEqual(source);
      // The same value without its padding is still canonical.
      expect(decodeBase64ToBytes(encoded.replace(/=+$/, ""))).toEqual(source);
    }
  });
});