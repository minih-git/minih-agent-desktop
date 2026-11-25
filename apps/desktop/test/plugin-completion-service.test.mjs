import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";
import { createSystemProxyFetch } from "@minih-agent/agent-runtime";
import { startSystemProxyRelay } from "@minih-agent/agent-runtime/system-proxy-relay";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPluginCompletionService } = await import("../electron/main/plugin-completion-service.ts");

test("plugin completion reaches the provider through Node while global Chromium fetch is broken", async () => {
  let payload;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    payload = JSON.parse(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "deepseek-flash" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Book organization" }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const relay = await startSystemProxyRelay(async () => "DIRECT");
  const transport = createSystemProxyFetch(relay.url);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Chromium transport is unavailable"); };
  try {
    const service = createPluginCompletionService({
      getHost: () => ({ call: async method => {
        assert.equal(method, "settings.get");
        return {};
      } }),
      resolveRuntimeModel: async () => ({
        providerId: "fixture", modelId: "deepseek-flash", thinkingLevel: "off",
        provider: {
          id: "fixture", name: "Fixture", modelId: "deepseek-flash",
          apiKey: "test-key", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiStyle: "chat_completions", supportsReasoning: false, supportedThinkingLevels: ["off"],
        },
      }),
      vendorOAuth: { resolveAuth: async () => { throw new Error("Unexpected OAuth call"); } },
      providerFetch: transport.fetch,
    });
    const result = await service({
      modelKey: "fixture/deepseek-flash", messages: [{ role: "user", content: "Generate a bookshelf title" }],
      maxOutputTokens: 128, signal: AbortSignal.timeout(2000),
    });
    assert.equal(result.text, "Book organization");
    assert.equal(result.modelKey, "fixture/deepseek-flash");
    assert.equal(payload.max_completion_tokens ?? payload.max_tokens, 128);
  } finally {
    globalThis.fetch = originalFetch;
    await transport.close();
    await relay.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
