/**
 * Request ids and idempotency keys (PR-4).
 *
 * A RACP request context needs a `requestId`, and a mutation that the Host
 * dedupes needs an idempotency key that stays the same across retries of the
 * same user action. Neither is a credential: they are correlation ids, so a
 * non-cryptographic fallback is acceptable when `crypto` is unavailable, and
 * the fallback is stated here rather than hidden.
 */

export type RandomSource = {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};

export function browserRandomSource(): RandomSource | undefined {
  const candidate = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
  return typeof candidate?.getRandomValues === "function" ? (candidate as RandomSource) : undefined;
}

function randomHex(byteLength: number, source: RandomSource | undefined): string {
  const bytes = new Uint8Array(byteLength);
  if (source) {
    source.getRandomValues(bytes);
  } else {
    // Fallback: unique enough for a correlation id, never used for a secret.
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function randomId(prefix: string, source: RandomSource | undefined = browserRandomSource()): string {
  return `${prefix}_${randomHex(16, source)}`;
}

/** One id per user action; reuse it when that action is retried. */
export function createIdempotencyKey(source?: RandomSource): string {
  return randomId("idem", source);
}

export function createRequestId(source?: RandomSource): string {
  return randomId("req", source);
}
