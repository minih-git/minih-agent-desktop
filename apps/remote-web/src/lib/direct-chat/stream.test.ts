import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import { SseDecoder, decodeSse } from "./sse.js";
import {
  decodeStreamEvent,
  streamBody,
  streamDirectReply,
  streamPath,
  type DirectRequestInput,
  type DirectStreamEvent,
} from "./stream.js";

const ORIGIN = "https://models.example.test";
const KEY = "sk-gl-sentinel-key-0001";
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

const model: MinihRouterModel = {
  id: "gpt-4.1",
  upstreamIds: [],
  vendor: "[OI]",
  category: "chat",
  protocols: ["openai-completions"],
  price: { input: null, output: null, cacheRead: null, cacheWrite: null },
  multiplePrices: false,
  tieredPricing: false,
  contextWindow: null,
  maxOutput: null,
};

const request: DirectRequestInput & { authKey: string } = {
  model,
  protocol: "openai-completions",
  history: [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi" },
  ],
  message: "how are you?",
  authKey: KEY,
};

/**
 * A `fetch` that answers with the given chunks, one read at a time, and records
 * the request. Chunks are handed over exactly as written, so a test can split a
 * line, a field, or a character between them.
 */
function streamingFetch(chunks: string[], init: { status?: number; body?: string } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, options: RequestInit) => {
    calls.push({ url, init: options });
    if (init.status && init.status >= 400) {
      return new Response(init.body ?? "{}", { status: init.status });
    }
    const queue = chunks.map((chunk) => bytes(chunk));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** The chunks a Chat Completions reply arrives in. */
const completionsChunks = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
  "data: [DONE]\n\n",
];

/**
 * The data plane is where a reply becomes text, so these tests are about the
 * three things that break it in the field: a chunk that splits a line, an error
 * that arrives mid-stream, and a stop that must not lose what arrived.
 */
describe("the SSE decoder", () => {
  it("decodes an event split across chunks at every position", () => {
    const full = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    for (let cut = 1; cut < full.length; cut += 1) {
      const events = decodeSse([bytes(full.slice(0, cut)), bytes(full.slice(cut))]);
      expect(events.map((event) => event.data), `cut at ${cut}`).toEqual(['{"a":1}', '{"b":2}']);
    }
  });

  it("keeps a multi-byte character that was split between chunks", () => {
    const text = 'data: {"t":"你好"}\n\n';
    const all = bytes(text);
    // Cut inside the first three-byte character.
    const cut = text.indexOf("你") + 1;
    const decoder = new SseDecoder();
    const events = [...decoder.push(all.slice(0, cut)), ...decoder.push(all.slice(cut)), ...decoder.end()];
    expect(events[0]?.data).toBe('{"t":"你好"}');
  });

  it("ignores keep-alive comments and unknown fields", () => {
    const events = decodeSse([bytes(": keep-alive\n\nretry: 3000\ndata: x\n\n")]);
    expect(events.map((event) => event.data)).toEqual(["x"]);
  });

  it("accumulates several data lines into one payload", () => {
    expect(decodeSse([bytes("data: a\ndata: b\n\n")])[0]?.data).toBe("a\nb");
  });

  it("dispatches a trailing event that never got its blank line", () => {
    expect(decodeSse([bytes('data: {"x":1}')])[0]?.data).toBe('{"x":1}');
  });

  it("handles CRLF line endings", () => {
    expect(decodeSse([bytes("data: a\r\n\r\n")])[0]?.data).toBe("a");
  });
});

describe("request shape", () => {
  it("posts to the path its protocol streams from", () => {
    expect(streamPath("openai-completions")).toBe("/v1/chat/completions");
    expect(streamPath("openai-responses")).toBe("/v1/responses");
  });

  it("sends completed history plus the new message, and no provider-side id", () => {
    const body = streamBody(request);
    expect(body.model).toBe("gpt-4.1");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
    ]);
    expect(body).not.toHaveProperty("previous_response_id");
  });

  it("sends the thinking level in each protocol's own field, and nothing on default", () => {
    // Chat Completions takes a flat string; Responses takes an object. A turn
    // with no level sends neither, so the gateway's own default applies.
    const completions = streamBody({ ...request, reasoningLevel: "high" });
    expect(completions.reasoning_effort).toBe("high");
    expect(completions).not.toHaveProperty("reasoning");

    const responses = streamBody({
      ...request,
      protocol: "openai-responses",
      reasoningLevel: "high",
    });
    expect(responses.reasoning).toEqual({ effort: "high" });
    expect(responses).not.toHaveProperty("reasoning_effort");

    expect(streamBody({ ...request, protocol: "openai-responses" })).not.toHaveProperty(
      "reasoning",
    );
    expect(streamBody(request)).not.toHaveProperty("reasoning_effort");
  });

  it("sends the gateway's own words for the two ends of the ladder", () => {
    // `none` and `ultra` are the gateway's vocabulary, not the desktop's. They
    // travel verbatim: mapping `none` onto `off` would name a level upstream
    // does not know, and dropping `ultra` would silently weaken the request.
    for (const level of ["none", "ultra", "persistent"]) {
      expect(streamBody({ ...request, reasoningLevel: level }).reasoning_effort).toBe(level);
      expect(
        streamBody({ ...request, protocol: "openai-responses", reasoningLevel: level }).reasoning,
      ).toEqual({ effort: level });
    }
  });

  it("uses the Responses envelope for that protocol", () => {
    const body = streamBody({ ...request, protocol: "openai-responses" });
    expect(body).not.toHaveProperty("messages");
    expect(Array.isArray(body.input)).toBe(true);
    const input = body.input as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(input).toHaveLength(3);
    expect(input[1]?.content[0]?.type).toBe("output_text");
    expect(input[2]).toEqual({ role: "user", content: [{ type: "input_text", text: "how are you?" }] });
  });

  /**
   * Image input (ADR mobile-experience-completeness D5). The bytes go inline as
   * a data URL, and the text part is omitted when the user sent only an image:
   * an empty `input_text` is a different request from no text at all.
   */
  it("carries images inline for Chat Completions, as a part list", () => {
    const body = streamBody({
      ...request,
      message: "what is this?",
      images: [
        { mimeType: "image/png", dataBase64: "AAAA" },
        { mimeType: "image/jpeg", dataBase64: "BBBB" },
      ],
    });
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
        ],
      },
    ]);
  });

  it("carries images inline for the Responses envelope, as input parts", () => {
    const body = streamBody({
      ...request,
      protocol: "openai-responses",
      message: "what is this?",
      images: [{ mimeType: "image/webp", dataBase64: "CCCC" }],
    });
    const input = body.input as Array<{ role: string; content: unknown }>;
    expect(input[2]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/webp;base64,CCCC" },
      ],
    });
  });

  it("keeps a text-only turn a plain string when another turn has an image", () => {
    const historyWithImage = [
      {
        role: "user" as const,
        text: "look",
        images: [{ mimeType: "image/png", dataBase64: "DDDD" }],
      },
      { role: "assistant" as const, text: "seen" },
    ];
    const completions = streamBody({ ...request, history: historyWithImage, message: "and now?" });
    expect(completions.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,DDDD" } },
        ],
      },
      { role: "assistant", content: "seen" },
      { role: "user", content: "and now?" },
    ]);

    const responses = streamBody({
      ...request,
      protocol: "openai-responses",
      history: historyWithImage,
      message: "and now?",
    });
    const input = responses.input as Array<{ role: string; content: unknown }>;
    expect(input[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,DDDD" },
      ],
    });
    expect(input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "seen" }] });
    expect(input[2]).toEqual({ role: "user", content: [{ type: "input_text", text: "and now?" }] });
  });

  it("omits the text part for an image-only message, in both envelopes", () => {
    const images = [{ mimeType: "image/png", dataBase64: "EEEE" }];
    const completions = streamBody({ ...request, history: [], message: "", images });
    expect(completions.messages).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,EEEE" } }] },
    ]);
    const responses = streamBody({ ...request, protocol: "openai-responses", history: [], message: "", images });
    expect(responses.input).toEqual([
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,EEEE" }] },
    ]);
  });
});

describe("streaming a reply", () => {
  it("collects the text and reports completion, usage and done", async () => {
    const events: DirectStreamEvent[] = [];
    const { fetchImpl, calls } = streamingFetch(completionsChunks);
    const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl, onEvent: (event) => events.push(event) });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Hello");
      expect(result.stopped).toBe(false);
      expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 2 });
    }
    expect(events.map((event) => event.type)).toEqual(["text", "text", "done", "usage", "done"]);
    // One request, to the configured origin, with the key only in the header.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/chat/completions`);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.url).not.toContain(KEY);
  });

  it("reads a reply split across chunks at every boundary", async () => {
    const full = completionsChunks.join("");
    for (const cut of [1, 7, 23, 40, 61, 90]) {
      const { fetchImpl } = streamingFetch([full.slice(0, cut), full.slice(cut)]);
      const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl });
      expect(result.ok && result.text, `cut at ${cut}`).toBe("Hello");
    }
  });

  it("stops on [DONE] without waiting for the stream to end", async () => {
    const { fetchImpl } = streamingFetch([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      "data: [DONE]\n\n",
      // Anything after the sentinel must not be read as more reply.
      'data: {"choices":[{"delta":{"content":"LATE"}}]}\n\n',
    ]);
    const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl });
    expect(result.ok && result.text).toBe("a");
  });

  it("decodes a Responses stream into the same events", async () => {
    const { fetchImpl, calls } = streamingFetch([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
    ]);
    const result = await streamDirectReply(
      { ...request, protocol: "openai-responses" },
      { origin: ORIGIN, fetchImpl },
    );
    expect(calls[0]?.url).toBe(`${ORIGIN}/v1/responses`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("Hi there");
      expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    }
  });

  it("reports an error event that arrives mid-stream", async () => {
    const { fetchImpl } = streamingFetch([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"upstream failed"}}\n\n',
    ]);
    const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("gateway");
      expect(result.failure.message).toContain("upstream failed");
    }
  });

  it("reports a Responses failure event", async () => {
    const { fetchImpl } = streamingFetch([
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"model refused"}}}\n\n',
    ]);
    const result = await streamDirectReply({ ...request, protocol: "openai-responses" }, { origin: ORIGIN, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain("model refused");
  });

  it("keeps the partial text and says it was stopped", async () => {
    // A stream that never closes: the abort is what ends it.
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, options: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(bytes('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          // Never closes on its own.
          options.signal?.addEventListener("abort", () => {
            streamController.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const pending = streamDirectReply(request, { origin: ORIGIN, fetchImpl }, controller.signal);
    // Let the first chunk arrive, then stop.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stopped).toBe(true);
      expect(result.text).toBe("partial");
    }
  });

  it("sends nothing when the stop landed before the call", async () => {
    const { fetchImpl, calls } = streamingFetch(completionsChunks);
    const controller = new AbortController();
    controller.abort();
    const events: DirectStreamEvent[] = [];
    const result = await streamDirectReply(
      request,
      { origin: ORIGIN, fetchImpl, onEvent: (event) => events.push(event) },
      controller.signal,
    );
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(result).toEqual({ ok: true, text: "", usage: null, stopped: true });
  });

  it("emits nothing read after the stop, even from the same chunk", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      // One chunk, two deltas: Stop lands while the first one is delivered.
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            bytes(
              'data: {"choices":[{"delta":{"content":"one"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"two"}}]}\n\n',
            ),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const texts: string[] = [];
    const result = await streamDirectReply(
      request,
      {
        origin: ORIGIN,
        fetchImpl,
        onEvent: (event) => {
          if (event.type !== "text") return;
          texts.push(event.text);
          controller.abort();
        },
      },
      controller.signal,
    );
    expect(texts).toEqual(["one"]);
    expect(result.ok && result.text).toBe("one");
    expect(result.ok && result.stopped).toBe(true);
  });

  it("keeps the partial text when the body stream errors", async () => {
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes('data: {"choices":[{"delta":{"content":"kept"}}]}\n\n'));
          controller.error(new Error("socket closed"));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("transport");
  });

  it("separates a rejected key, a quota answer and a range refusal", async () => {
    const cases: Array<{ status: number; body: string; kind: string }> = [
      { status: 401, body: '{"error":{"message":"bad key"}}', kind: "unauthorized" },
      { status: 429, body: '{"error":{"message":"slow down"}}', kind: "quota" },
      // The gateway's own codes. Both arrive as a bare status otherwise, and both
      // would be described as something they are not.
      {
        status: 503,
        body: '{"code":"no_available_candidate","message":"No available upstream candidate."}',
        kind: "no-route",
      },
      {
        status: 429,
        body: '{"code":"upstream_cooldown","message":"The gateway is holding requests for this upstream candidate."}',
        kind: "upstream-busy",
      },
      // A real quota code keeps the quota wording: telling the user to wait could
      // not be more wrong than telling them their key is spent.
      { status: 429, body: '{"code":"access_key_rate_limited","message":"Access key rate limit exceeded."}', kind: "quota" },
      { status: 402, body: '{"error":{"message":"no balance"}}', kind: "quota" },
      { status: 403, body: '{"error":{"message":"source ip not in allowed_peer_cidrs"}}', kind: "network-range" },
      { status: 500, body: '{"error":{"message":"boom"}}', kind: "gateway" },
    ];
    for (const { status, body, kind } of cases) {
      const { fetchImpl } = streamingFetch([], { status, body });
      const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl });
      expect(result.ok, kind).toBe(false);
      if (!result.ok) expect(result.failure.kind, kind).toBe(kind);
    }
  });

  it("refuses to send without an origin or a key", async () => {
    const { calls, fetchImpl } = streamingFetch(completionsChunks);
    const noOrigin = await streamDirectReply(request, { origin: null, fetchImpl });
    expect(noOrigin.ok).toBe(false);
    const noKey = await streamDirectReply({ ...request, authKey: "  " }, { origin: ORIGIN, fetchImpl });
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.failure.kind).toBe("unauthorized");
    expect(calls).toHaveLength(0);
  });

  it("never echoes the key from a refusal or a transport error", async () => {
    const echoing = streamingFetch([], { status: 401, body: `{"error":{"message":"invalid ${KEY}"}}` });
    const refused = await streamDirectReply(request, { origin: ORIGIN, fetchImpl: echoing.fetchImpl });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure.message).not.toContain(KEY);
      expect(refused.failure.message).toContain("[redacted]");
    }

    const throwing = (async () => {
      throw new Error(`connect failed with Bearer ${KEY}`);
    }) as unknown as typeof fetch;
    const broken = await streamDirectReply(request, { origin: ORIGIN, fetchImpl: throwing });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.failure.message).not.toContain(KEY);
  });
});

describe("event decoding", () => {
  it("treats an unreadable payload as an error instead of dropping it", () => {
    const events = decodeStreamEvent("openai-completions", { event: "", data: "not json" });
    expect(events.events[0]?.type).toBe("error");
    expect(events.terminal).toBe(true);
  });

  it("maps a length finish to its own reason", () => {
    const events = decodeStreamEvent("openai-completions", {
      event: "",
      data: '{"choices":[{"delta":{},"finish_reason":"length"}]}',
    });
    expect(events.events).toEqual([{ type: "done", reason: "length" }]);
    // A finish reason is not the end of the stream: usage may still follow.
    expect(events.terminal).toBe(false);
  });

  it("maps a content filter finish", () => {
    const events = decodeStreamEvent("openai-completions", {
      event: "",
      data: '{"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
    });
    expect(events.events).toEqual([{ type: "done", reason: "content-filter" }]);
  });

  it("reads an incomplete Responses reply as truncated, not complete", () => {
    const events = decodeStreamEvent("openai-responses", {
      event: "response.incomplete",
      data: '{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
    });
    expect(events.events).toContainEqual({ type: "done", reason: "length" });
    expect(events.terminal).toBe(true);
  });

  it("ignores lifecycle events it does not need", () => {
    const events = decodeStreamEvent("openai-responses", {
      event: "response.created",
      data: '{"type":"response.created"}',
    });
    expect(events.events).toEqual([]);
    expect(events.terminal).toBe(false);
  });
});

describe("a reply that does not fit the model's context", () => {
  it("is its own kind, so the remedy is a new conversation", async () => {
    const cases: Array<{ status: number; message: string }> = [
      { status: 400, message: "This model's maximum context length is 128000 tokens" },
      { status: 400, message: "context_length_exceeded: your messages resulted in 200000 tokens" },
      { status: 413, message: "prompt is too long" },
      { status: 422, message: "the request exceeds the context window" },
    ];
    for (const { status, message } of cases) {
      const { fetchImpl } = streamingFetch([], { status, body: JSON.stringify({ error: { message } }) });
      const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl });
      expect(result.ok, message).toBe(false);
      if (!result.ok) expect(result.failure.kind, message).toBe("context-overflow");
    }
  });

  it("does not call an unrelated 400 a context problem", async () => {
    const { fetchImpl } = streamingFetch([], {
      status: 400,
      body: JSON.stringify({ error: { message: "invalid parameter: temperature" } }),
    });
    const result = await streamDirectReply(request, { origin: ORIGIN, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("gateway");
  });
});
