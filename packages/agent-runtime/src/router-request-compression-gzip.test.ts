import * as zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { providerRequestFetch } from "./provider-binding.js";

/**
 * A Node without zstd (`zlib.zstdCompress` arrived in 22.15/23.8) is not
 * installable on demand, so this file removes the encoder instead: every Router
 * from the one that introduced content coding also decodes gzip.
 */
vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return { ...actual, zstdCompress: undefined, zstdCompressSync: undefined };
});

describe("Minih Router request-body compression without a zstd encoder", () => {
  it("falls back to gzip and the gateway decodes the adapter's exact bytes", async () => {
    const baseUrl = "https://router-gzip.example/v1";
    const requestBody = JSON.stringify({
      model: "gpt-4.1",
      messages: Array.from({ length: 40 }, (_unused, index) => ({
        role: "user",
        content: `step ${index}: rerunning the workspace check`,
      })),
    });
    let encoded: Uint8Array | undefined;
    let contentEncoding: string | null = null;
    const fetchFn: FetchFunction = async (_input, init) => {
      contentEncoding = new Headers(init?.headers).get("content-encoding");
      encoded = init?.body instanceof Uint8Array ? init.body : undefined;
      return new Response("ok", { status: 200 });
    };

    const requestFetch = providerRequestFetch(
      "openai-completions",
      fetchFn,
      "api_key_and_base_url",
      undefined,
      { vendorKey: "minih-router" },
    )!;
    const response = await requestFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(contentEncoding).toBe("gzip");
    expect(encoded).toBeDefined();
    expect(zlib.gunzipSync(encoded!).toString("utf8")).toBe(requestBody);
  });
});