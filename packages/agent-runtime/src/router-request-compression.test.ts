import { randomBytes } from "node:crypto";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import {
  providerRequestFetch,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import {
  ROUTER_REQUEST_COMPRESSION_MIN_BYTES,
  routerAcceptsCompressedBody,
} from "./router-request-compression.js";

/**
 * The Router decodes a request body with an 8 MiB window limit
 * (`ZstdHTTPMaxWindowBytes`) and fails the turn on anything larger, so the
 * frames this runtime emits must stay inside it.
 */
const ROUTER_ZSTD_MAX_WINDOW_BYTES = 8 << 20;

type SeenRequest = {
  url: string;
  headers: Headers;
  body: Uint8Array;
};

function row(overrides: Partial<RuntimeProviderConfig>): RuntimeProviderConfig {
  return {
    id: "row-1",
    name: "Row",
    baseUrl: "https://api.acme.test/v1",
    modelId: "acme-1",
    apiKey: "sk-test",
    authKind: "api_key_and_base_url",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    ...overrides,
  };
}

function routerRow(baseUrl: string): RuntimeProviderConfig {
  return row({ vendorKey: "minih-router", baseUrl });
}

function recordRequests(
  respond: (request: SeenRequest, attempt: number) => Response | Promise<Response>,
): { fetchFn: FetchFunction; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetchFn: FetchFunction = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = { url, headers: new Headers(init?.headers), body: bodyBytes(init?.body) };
    seen.push(request);
    return respond(request, seen.length);
  };
  return { fetchFn, seen };
}

function bodyBytes(body: RequestInit["body"]): Uint8Array {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error(`unexpected request body: ${Object.prototype.toString.call(body)}`);
}

/** The bytes the gateway would decode back before forwarding them upstream. */
function decodedBody(request: SeenRequest): Buffer {
  switch (request.headers.get("content-encoding")) {
    case "zstd":
      return zlib.zstdDecompressSync(request.body);
    case "gzip":
      return zlib.gunzipSync(request.body);
    case null:
      return Buffer.from(request.body);
    default:
      throw new Error(`unexpected content encoding: ${request.headers.get("content-encoding")}`);
  }
}

/** A conversation-sized body: the case compression exists for. */
function transcriptBody(messageCount = 60): string {
  return JSON.stringify({
    model: "gpt-4.1",
    stream: true,
    messages: Array.from({ length: messageCount }, (_unused, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `step ${index}: the workspace ignore rules are unchanged, rerunning the check`,
    })),
  });
}

/** Window size a zstd frame declares, read from its frame header descriptor. */
function zstdWindowBytes(frame: Uint8Array): number {
  const descriptor = frame[5]!;
  const windowLog = 10 + (descriptor >> 3);
  const mantissa = descriptor & 7;
  return (1 << windowLog) + ((1 << windowLog) / 8) * mantissa;
}

describe("Minih Router request-body compression", () => {
  it("sends a zstd body the gateway decodes back to the adapter's exact bytes", async () => {
    const baseUrl = "https://router-compress.example/v1";
    const requestBody = transcriptBody();
    const { fetchFn, seen } = recordRequests(() => new Response("ok", { status: 200 }));
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      routerRow(baseUrl),
    )!;

    const response = await requestFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      body: requestBody,
      // A length the encoded body no longer matches must not survive.
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(requestBody, "utf8")),
      },
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("content-encoding")).toBe("zstd");
    expect(seen[0]!.headers.get("content-length")).toBeNull();
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.body.byteLength).toBeLessThan(Buffer.byteLength(requestBody, "utf8") / 2);
    expect(Buffer.compare(decodedBody(seen[0]!), Buffer.from(requestBody, "utf8"))).toBe(0);
  });

  it("keeps the zstd window inside the gateway's decoder limit for a large body", async () => {
    const baseUrl = "https://router-window.example/v1";
    // Larger than the window limit itself: the frame must not grow with the body.
    const requestBody = transcriptBody(100_000);
    expect(requestBody.length).toBeGreaterThan(ROUTER_ZSTD_MAX_WINDOW_BYTES);
    const { fetchFn, seen } = recordRequests(() => new Response("ok", { status: 200 }));
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      routerRow(baseUrl),
    )!;

    await requestFetch(`${baseUrl}/chat/completions`, { method: "POST", body: requestBody });

    expect(seen[0]!.headers.get("content-encoding")).toBe("zstd");
    expect(zstdWindowBytes(seen[0]!.body)).toBeLessThanOrEqual(ROUTER_ZSTD_MAX_WINDOW_BYTES);
    expect(Buffer.compare(decodedBody(seen[0]!), Buffer.from(requestBody, "utf8"))).toBe(0);
  });

  it("leaves a direct vendor row's request untouched", async () => {
    const requestBody = transcriptBody();
    const { fetchFn, seen } = recordRequests(() => new Response("ok", { status: 200 }));
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      row({ vendorKey: "openai", baseUrl: "https://api.openai.com/v1" }),
    );
    // Nothing to wrap: the adapter keeps its own transport.
    expect(requestFetch).toBe(fetchFn);

    const response = await requestFetch!("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(seen[0]!.headers.get("content-encoding")).toBeNull();
    expect(seen[0]!.body.byteLength).toBe(Buffer.byteLength(requestBody, "utf8"));
  });

  it("does not encode a body below the threshold", async () => {
    const baseUrl = "https://router-small.example/v1";
    const requestBody = "x".repeat(ROUTER_REQUEST_COMPRESSION_MIN_BYTES - 1);
    const { fetchFn, seen } = recordRequests(() => new Response("ok", { status: 200 }));
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      routerRow(baseUrl),
    )!;

    await requestFetch(`${baseUrl}/chat/completions`, { method: "POST", body: requestBody });

    expect(seen[0]!.headers.get("content-encoding")).toBeNull();
    expect(decodedBody(seen[0]!).toString("utf8")).toBe(requestBody);
  });

  it("does not encode a body that would not shrink", async () => {
    const baseUrl = "https://router-incompressible.example/v1";
    const body = randomBytes(4_096);
    const { fetchFn, seen } = recordRequests(() => new Response("ok", { status: 200 }));
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      routerRow(baseUrl),
    )!;

    await requestFetch(`${baseUrl}/chat/completions`, { method: "POST", body });

    expect(seen[0]!.headers.get("content-encoding")).toBeNull();
    expect(Buffer.compare(Buffer.from(seen[0]!.body), body)).toBe(0);
  });

  it("does not encode a body the adapter already encoded itself", async () => {
    // The Codex Responses adapter zstd-compresses its own SSE body and names it.
    const baseUrl = "https://router-codex.example/v1";
    const body = zlib.zstdCompressSync(Buffer.from(transcriptBody(), "utf8"));
    const { fetchFn, seen } = recordRequests(() => new Response("ok", { status: 200 }));
    const requestFetch = providerRequestFetch(
      "openai-codex-responses",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      routerRow(baseUrl),
    )!;

    await requestFetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { "content-encoding": "zstd" },
      body,
    });

    expect(seen[0]!.headers.get("content-encoding")).toBe("zstd");
    expect(Buffer.compare(Buffer.from(seen[0]!.body), body)).toBe(0);
  });

  it("re-sends the uncompressed body after a 415 and stops encoding for that gateway", async () => {
    const baseUrl = "https://router-legacy.example/v1";
    const requestBody = transcriptBody();
    const { fetchFn, seen } = recordRequests((_request, attempt) =>
      attempt === 1
        ? new Response("unsupported content encoding", {
            status: 415,
            // A Router from before content coding advertises what it decodes.
            headers: { "accept-encoding": "identity" },
          })
        : new Response("ok", { status: 200 }),
    );
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      routerRow(baseUrl),
    )!;

    const response = await requestFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers.get("content-encoding")).toBe("zstd");
    expect(seen[1]!.headers.get("content-encoding")).toBeNull();
    expect(Buffer.from(seen[1]!.body).toString("utf8")).toBe(requestBody);
    expect(routerAcceptsCompressedBody("https://router-legacy.example")).toBe(false);

    // The runtime rebuilds its wrapper per request; the memory is per gateway.
    const retryFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      routerRow(baseUrl),
    )!;
    await retryFetch(`${baseUrl}/chat/completions`, { method: "POST", body: requestBody });
    expect(seen[2]!.headers.get("content-encoding")).toBeNull();
    expect(seen).toHaveLength(3);
  });

  it("keeps the encoded body intact when the tunnel address fails over to the public one", async () => {
    const primaryBaseUrl = "http://127.0.0.1:25891/v1";
    const fallbackBaseUrl = "https://router-failover.example/v1";
    const requestBody = transcriptBody();
    const { fetchFn, seen } = recordRequests((request) => {
      if (request.url.startsWith("http://127.0.0.1:25891/")) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:25891");
      }
      return new Response("ok", { status: 200 });
    });
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      { primaryBaseUrl, fallbackBaseUrl },
      row({ vendorKey: "minih-router", baseUrl: primaryBaseUrl }),
    )!;

    const response = await requestFetch(`${primaryBaseUrl}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(seen.map((request) => request.url)).toEqual([
      `${primaryBaseUrl}/chat/completions`,
      `${fallbackBaseUrl}/chat/completions`,
    ]);
    for (const request of seen) {
      expect(request.headers.get("content-encoding")).toBe("zstd");
      expect(Buffer.compare(decodedBody(request), Buffer.from(requestBody, "utf8"))).toBe(0);
    }
  });

  it("keeps the no-auth placeholder credential stripped from the compressed request", async () => {
    const baseUrl = "https://router-noauth.example/v1";
    const requestBody = transcriptBody();
    const { fetchFn, seen } = recordRequests(() => new Response("ok", { status: 200 }));
    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "none",
      undefined,
      routerRow(baseUrl),
    )!;

    await requestFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      body: requestBody,
      headers: {
        authorization: "Bearer minih-agent-desktop-no-auth",
        "x-api-key": "minih-agent-desktop-no-auth",
      },
    });

    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(seen[0]!.headers.get("x-api-key")).toBeNull();
    expect(seen[0]!.headers.get("content-encoding")).toBe("zstd");
    expect(Buffer.compare(decodedBody(seen[0]!), Buffer.from(requestBody, "utf8"))).toBe(0);
  });

  it("leaves the Google adapters alone, because they accept no custom fetch", () => {
    const requestFetch = providerRequestFetch(
      "google-generative-ai",
      async () => new Response("ok"),
      "api_key_and_base_url",
      undefined,
      row({ vendorKey: "minih-router", baseUrl: "https://router.example/v1" }),
    );
    expect(requestFetch).toBeUndefined();
  });
});