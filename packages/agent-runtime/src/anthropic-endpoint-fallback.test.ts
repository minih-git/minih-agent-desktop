import { normalizeContext } from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { assembleProviderRequest } from "./provider-request.js";
import {
  buildProviderModel,
  createProviderEndpointFallbackState,
  createProviderModels,
  type RuntimeProviderConfig,
} from "./provider-binding.js";

function messageResponse(): Response {
  const events = [
    ["message_start", { message: { id: "fixture", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ] as const;
  return new Response(events.map(([type, data]) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
  ).join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("Anthropic endpoint fallback request journey", () => {
  for (const fallbackPath of ["", "/v1", "/relay/v1/"]) {
    for (const failure of ["network", 502, 503, 504] as const) {
      it(`preserves one version segment after ${failure} with fallback ${fallbackPath || "root"}`, async () => {
        const provider: RuntimeProviderConfig = {
          id: "fixture", name: "Fixture", vendorKey: "minih-router",
          baseUrl: "http://127.0.0.1:25890/v1",
          fallbackBaseUrl: `https://fallback.example${fallbackPath}`,
          modelId: "claude-sonnet-4-5", apiStyle: "anthropic_messages",
          apiKey: "fixture-key", authKind: "api_key_and_base_url",
          supportsReasoning: false, supportedThinkingLevels: ["off"],
        };
        const model = buildProviderModel(provider);
        const registry = createProviderModels(provider, model);
        const state = createProviderEndpointFallbackState();
        const urls: string[] = [];
        let failPrimary = false;
        const baseFetch = async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? input.url : String(input);
          urls.push(url);
          if (failPrimary && new URL(url).hostname === "127.0.0.1") {
            if (failure === "network") throw new TypeError("simulated tunnel failure");
            return new Response("gateway unavailable", { status: failure });
          }
          return messageResponse();
        };
        const context = normalizeContext({ systemPrompt: "Fixture", messages: [
          { role: "user", content: "hello", timestamp: 1 },
        ], tools: [] });
        for (let turn = 0; turn < 3; turn += 1) {
          const request = assembleProviderRequest({
            provider, model, context, sessionId: "fixture-session", base: {},
            baseFetch, withHooks: (options) => options, maxRetries: 0,
            capture: () => {}, endpointFallbackState: state, omitThinking: false,
          });
          const result = await registry.streamSimple(request.model, request.context, request.options).result();
          expect(result.stopReason).toBe("stop");
          expect(result.content).toContainEqual({ type: "text", text: "OK" });
          failPrimary = true;
        }
        const fallbackRoot = fallbackPath.startsWith("/relay") ? "/relay" : "";
        expect(urls).toEqual([
          "http://127.0.0.1:25890/v1/messages?beta=true",
          "http://127.0.0.1:25890/v1/messages?beta=true",
          `https://fallback.example${fallbackRoot}/v1/messages?beta=true`,
          `https://fallback.example${fallbackRoot}/v1/messages?beta=true`,
        ]);
      });
    }
  }
});

it("continues a successful Anthropic conversation across HTTP endpoint fallback", async () => {
  const received: string[] = [];
  let failPrimary = false;
  const servers = ["primary", "fallback"].map((endpoint) => createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the real SDK request body. */ }
    received.push(`${endpoint} ${req.method} ${req.url}`);
    if (endpoint === "primary" && failPrimary) {
      res.writeHead(503).end("fixture unavailable");
      return;
    }
    if (req.url !== "/v1/messages?beta=true") {
      res.writeHead(404).end("Protocol endpoint not found.");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(await messageResponse().text());
  }));
  try {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
    const [primary, fallback] = servers.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    const provider: RuntimeProviderConfig = {
      id: "http-fixture", name: "HTTP fixture", vendorKey: "minih-router",
      baseUrl: primary, fallbackBaseUrl: fallback, modelId: "claude-sonnet-4-5",
      apiStyle: "anthropic_messages", apiKey: "fixture-key", authKind: "api_key_and_base_url",
      supportsReasoning: false, supportedThinkingLevels: ["off"],
    };
    const model = buildProviderModel(provider);
    const registry = createProviderModels(provider, model);
    const state = createProviderEndpointFallbackState();
    for (let turn = 0; turn < 3; turn += 1) {
      const request = assembleProviderRequest({
        provider, model, sessionId: "http-fixture-session", base: {}, maxRetries: 0,
        context: normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: turn }], tools: [] }),
        withHooks: (options) => options, capture: () => {},
        endpointFallbackState: state, omitThinking: false,
      });
      const result = await registry.streamSimple(request.model, request.context, request.options).result();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual({ type: "text", text: "OK" });
      failPrimary = true;
    }
    expect(received).toEqual([
      "primary POST /v1/messages?beta=true",
      "primary POST /v1/messages?beta=true",
      "fallback POST /v1/messages?beta=true",
      "fallback POST /v1/messages?beta=true",
    ]);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  }
});
