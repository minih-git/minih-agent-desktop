/**
 * Compress the body of a request bound for the Minih Router gateway.
 *
 * Every round of a turn re-sends the whole conversation, so the request body is
 * most of this runtime's uplink traffic. The Router's data plane has accepted
 * `Content-Encoding: identity | gzip | br | deflate | zstd` since 0c33cd4a: it
 * decodes the body, drops the header and forwards the decoded bytes, so the
 * vendor that finally answers receives exactly the bytes it received before and
 * its prompt cache is untouched. Only the representation on the wire changes,
 * and the saving is proportional to how well JSON text compresses (several
 * times for a chat transcript).
 *
 * Two rules keep that safe:
 *
 * - The body is taken as the bytes the adapter already serialized. It is never
 *   parsed, re-serialized or edited here; a single changed byte would invalidate
 *   the provider's cached prefix (`keep-warm.ts`) and the caller's own body is
 *   kept for the fallback re-send.
 * - Only the gateway is trusted to decode, and a gateway old enough to predate
 *   this contract says so with HTTP 415 instead of failing. That answer is
 *   turned into an uncompressed re-send plus a process-wide memory for the
 *   origin, so a stale Router costs one request rather than every turn.
 */

import * as zlib from "node:zlib";
import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Bodies at or above this size are worth encoding.
 *
 * Below it the header and the gateway's decode cost more than the bytes saved,
 * and almost every small request in this app is a handshake or a metadata call.
 */
export const ROUTER_REQUEST_COMPRESSION_MIN_BYTES = 1024;

/** What a gateway that refuses the body answers (`Unsupported Media Type`). */
const UNSUPPORTED_ENCODING_STATUS = 415;

/**
 * The zstd window this runtime asks for: 2 MiB.
 *
 * The Router decodes with an 8 MiB window limit, and a frame that declares more
 * is a hard `invalid_content_encoding` failure rather than a retry. Pinning the
 * window keeps a body of any size inside that limit, and the ratio a larger
 * window would buy is negligible for JSON text.
 */
const ZSTD_WINDOW_LOG = 21;

/** zstd's own default level: text compresses well long before level 10 costs. */
const ZSTD_COMPRESSION_LEVEL = 3;

type RequestEncoding = "zstd" | "gzip";

type EncodedBody = { body: Uint8Array; encoding: RequestEncoding };

/**
 * Origins that answered a compressed body with 415.
 *
 * Keyed by origin rather than by base URL: a provider row's base URL carries the
 * API path, while the component that decodes the body owns the origin. The
 * runtime rebuilds its request wrapper per request, so this memory cannot live
 * in the wrapper closure.
 */
const refusedOrigins = new Set<string>();

/**
 * Whether a compressed body still goes to `origin`. Answers false once that
 * origin refused one; exposed so diagnostics and tests can read the memory.
 */
export function routerAcceptsCompressedBody(origin: string): boolean {
  return !refusedOrigins.has(origin);
}

function zstdEncode(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    zlib.zstdCompress(
      bytes,
      {
        params: {
          [zlib.constants.ZSTD_c_windowLog]: ZSTD_WINDOW_LOG,
          [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL,
        },
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
}

function gzipEncode(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    zlib.gzip(bytes, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

/**
 * zstd needs Node 22.15+/23.8+ (`zlib.zstdCompress`). The sidecar runs on
 * Electron's Node, which qualifies today, but the declared floor of this package
 * does not, so the encoder is chosen by what this process actually has rather
 * than by a version number. gzip decodes at every Router that decodes zstd.
 */
async function encodeBody(bytes: Uint8Array): Promise<EncodedBody> {
  if (typeof zlib.zstdCompress === "function") {
    return { body: await zstdEncode(bytes), encoding: "zstd" };
  }
  return { body: await gzipEncode(bytes), encoding: "gzip" };
}

/**
 * The request body as bytes, or undefined when this wrapper must not touch it.
 *
 * Adapters hand over an already serialized string or buffer. A stream, a Blob
 * or a form is left alone: consuming one here would leave nothing for the
 * re-send paths (`withEndpointFallback`, the retry loop), and reading it is
 * exactly the "serialize it again" step this module refuses to do.
 */
function requestBodyBytes(body: BodyInit | null | undefined): Uint8Array | undefined {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return undefined;
}

function requestOrigin(input: RequestInfo | URL): string | undefined {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * A request that already carries its own coding is not encoded twice: the Codex
 * Responses adapter zstd-compresses its own SSE body and names it, and one
 * `Content-Encoding` describes one layer.
 */
function alreadyEncoded(headers: HeadersInit | undefined): boolean {
  const declared = new Headers(headers).get("content-encoding")?.trim().toLowerCase();
  return Boolean(declared && declared !== "identity");
}

function encodedInit(init: RequestInit | undefined, encoded: EncodedBody): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("content-encoding", encoded.encoding);
  // The declared length described the bytes this call is replacing; the
  // transport derives the real one from the body it is given.
  headers.delete("content-length");
  return { ...(init ?? {}), headers, body: encoded.body as BodyInit };
}

/**
 * Wrap the fetch a Minih Router row sends with, as the outermost step of the
 * request chain: every other wrapper has finished with the request by then, and
 * all of them observe the same encoded bytes when they re-send it.
 */
export function withRouterRequestCompression(fetchFn: FetchFunction): FetchFunction {
  return async (input, init) => {
    const bytes = requestBodyBytes(init?.body);
    const origin = requestOrigin(input);
    if (
      !bytes ||
      bytes.byteLength < ROUTER_REQUEST_COMPRESSION_MIN_BYTES ||
      !origin ||
      refusedOrigins.has(origin) ||
      alreadyEncoded(init?.headers)
    ) {
      return fetchFn(input, init);
    }
    const encoded = await encodeBody(bytes);
    // A body that does not actually shrink would buy nothing and still depend
    // on the gateway decoding it.
    if (encoded.body.byteLength >= bytes.byteLength) return fetchFn(input, init);
    const response = await fetchFn(input, encodedInit(init, encoded));
    if (response.status !== UNSUPPORTED_ENCODING_STATUS) return response;
    // A Router older than its own content-coding support answers 415 and
    // advertises what it does decode in `Accept-Encoding`, rather than failing
    // the turn. This response belongs to the retry below, so release it first.
    await response.body?.cancel().catch(() => undefined);
    refusedOrigins.add(origin);
    console.warn(
      `[provider] ${origin} refused a ${encoded.encoding} request body (415); sending uncompressed requests from now on`,
    );
    return fetchFn(input, init);
  };
}