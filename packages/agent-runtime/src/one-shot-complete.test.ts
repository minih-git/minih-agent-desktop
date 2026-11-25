import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { fetch as nodeFetch } from "undici";
import { completeOneShot } from "./one-shot-complete.js";

const provider = {
  id: "title-test", name: "Title test", apiKey: "fixture-key",
  modelId: "deepseek-flash", apiStyle: "chat_completions",
  supportsReasoning: false, supportedThinkingLevels: ["off"] as const,
};
const context = { messages: [{ role: "user" as const, content: "Name this conversation", timestamp: 1 }] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function serve(handler: import("node:http").RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return `http://127.0.0.1:${address.port}/v1`;
}
const explicitFetch = nodeFetch as unknown as typeof fetch;
function fixtureResponse(response: import("node:http").ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: "deepseek-flash" };
  response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Book organization" }, finish_reason: null }] })}\n\n`);
  response.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
}
it("uses the explicit Node transport even when Electron's global fetch fails", async () => {
  let outputLimit: number | undefined;
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const input = JSON.parse(body);
    outputLimit = input.max_completion_tokens ?? input.max_tokens;
    fixtureResponse(response);
  });
  const chromiumFetch = vi.fn().mockRejectedValue(new Error("Chromium transport unavailable"));
  vi.stubGlobal("fetch", chromiumFetch);
  const result = await completeOneShot({ ...provider, supportedThinkingLevels: ["off"], baseUrl }, context, "off", {
    fetch: explicitFetch, maxOutputTokens: 128, signal: AbortSignal.timeout(2000),
  });
  expect(result.text).toBe("Book organization");
  expect(outputLimit).toBe(128);
  expect(chromiumFetch).not.toHaveBeenCalled();
});
it("aborts an unanswered explicit-transport request", async () => {
  const controller = new AbortController();
  const baseUrl = await serve((_request, _response) => controller.abort());
  await expect(completeOneShot({ ...provider, supportedThinkingLevels: ["off"], baseUrl }, context, "off", {
    fetch: explicitFetch, signal: controller.signal,
  })).rejects.toMatchObject({ errorCode: "TURN_ABORTED" });
});
it("keeps the explicit transport when a failed primary falls back", async () => {
  const primary = await serve((_request, response) => { response.writeHead(503); response.end(); });
  const fallback = await serve((_request, response) => fixtureResponse(response));
  const chromiumFetch = vi.fn().mockRejectedValue(new Error("Chromium transport unavailable"));
  vi.stubGlobal("fetch", chromiumFetch);
  const result = await completeOneShot({ ...provider, supportedThinkingLevels: ["off"], baseUrl: primary, fallbackBaseUrl: fallback }, context, "off", {
    fetch: explicitFetch, signal: AbortSignal.timeout(2000),
  });
  expect(result.text).toBe("Book organization");
  expect(chromiumFetch).not.toHaveBeenCalled();
});
