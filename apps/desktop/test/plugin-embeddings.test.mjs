import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  EMBEDDINGS_MAX_TEXTS,
  EMBEDDINGS_MAX_TEXT_BYTES,
  EMBEDDINGS_MAX_TOTAL_BYTES,
  EMBEDDINGS_RATE_MAX_CALLS,
  EmbeddingsRateLimiter,
  buildEmbeddingsRequest,
  embeddingsStatusError,
  embeddingsUrl,
  normalizeEmbeddingsInput,
  normalizeModelsListInput,
  parseEmbeddingsResponse,
  supportsEmbeddings,
} = await import("../electron/main/plugin-embeddings.ts");
const { listReadyPluginModels } = await import("../electron/main/plugin-agent-complete.ts");

// ADR plugin-embeddings: the credential stays in Electron main, every bound is
// checked before a provider is called, and the plugin only ever receives
// vectors — never the key, and never the text it sent.

const SECRET = "sk-test-never-leaks";

/** One local provider that records the request it received. */
async function mockProvider(reply) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
      const { status = 200, payload } = reply(JSON.parse(body));
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function vectorsFor(count, dims = 3) {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: dims }, (_, slot) => index + slot / 10),
    })),
    usage: { prompt_tokens: 42 },
  };
}

test("the request is the OpenAI-compatible shape and carries the credential once", async () => {
  const provider = await mockProvider((body) => ({ payload: vectorsFor(body.input.length) }));
  try {
    const input = normalizeEmbeddingsInput({
      modelKey: "router/bge-m3",
      texts: ["first note", "second note"],
      dimensions: 256,
    });
    const request = buildEmbeddingsRequest(
      { providerId: "router", providerName: "Router", baseUrl: provider.baseUrl, apiKey: SECRET },
      input,
    );
    assert.equal(request.url, `${provider.baseUrl}/embeddings`);
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);

    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    const payload = parseEmbeddingsResponse(await response.json(), input.texts.length);
    assert.equal(payload.vectors.length, 2);
    assert.equal(payload.dims, 3);
    assert.deepEqual(payload.usage, { inputTokens: 42 });

    // The wire keeps the model id the provider knows, not the host's key form.
    assert.deepEqual(provider.seen[0].body, {
      model: "bge-m3",
      input: ["first note", "second note"],
      encoding_format: "float",
      dimensions: 256,
    });
    // Nothing the plugin receives echoes the credential.
    const received = JSON.stringify(payload);
    assert.ok(!received.includes(SECRET));
    assert.ok(!received.includes("first note"));
  } finally {
    await provider.close();
  }
});

test("every bound is refused before a provider is called", () => {
  const base = { modelKey: "router/bge-m3", texts: ["ok"] };
  assert.deepEqual(normalizeEmbeddingsInput(base), base);
  assert.deepEqual(
    normalizeEmbeddingsInput({ ...base, texts: [" padded "] }).texts,
    [" padded "],
    "text is not trimmed; the caller's own string is what gets indexed",
  );
  const cases = [
    [{ ...base, modelKey: "bge-m3" }, /modelKey/],
    [{ ...base, modelKey: "" }, /modelKey/],
    [{ ...base, texts: [] }, /1 to 64/],
    [{ ...base, texts: Array.from({ length: EMBEDDINGS_MAX_TEXTS + 1 }, () => "x") }, /1 to 64/],
    [{ ...base, texts: [123] }, /string/],
    [{ ...base, texts: ["   "] }, /blank/],
    [{ ...base, texts: ["a".repeat(EMBEDDINGS_MAX_TEXT_BYTES + 1)] }, /bytes/],
    [
      { ...base, texts: Array.from({ length: 40 }, () => "y".repeat(EMBEDDINGS_MAX_TEXT_BYTES)) },
      /in total/,
    ],
    [{ ...base, dimensions: 0 }, /dimensions/],
    [{ ...base, dimensions: 2.5 }, /dimensions/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => normalizeEmbeddingsInput(input), pattern);
  }
  assert.ok(
    Array.from({ length: 40 }, () => "y".repeat(EMBEDDINGS_MAX_TEXT_BYTES)).join("").length >
      EMBEDDINGS_MAX_TOTAL_BYTES,
    "the total ceiling is smaller than 40 maximum-size texts",
  );
});

test("a provider answer is only accepted when it matches the request", () => {
  assert.deepEqual(parseEmbeddingsResponse(vectorsFor(2), 2).vectors.length, 2);
  const mismatched = [
    [vectorsFor(1), 2, /vectors for 2 texts/],
    [{ data: [{ embedding: [] }] }, 1, /malformed vector/],
    [{ data: [{ embedding: ["a"] }] }, 1, /malformed vector/],
    [{ data: [{ embedding: [1, 2] }, { embedding: [1, 2, 3] }] }, 2, /different sizes/],
    [{}, 1, /vectors for 1 texts/],
  ];
  for (const [document, expected, pattern] of mismatched) {
    assert.throws(() => parseEmbeddingsResponse(document, expected), pattern);
  }
});

test("provider failures map onto the API's own codes", () => {
  assert.equal(embeddingsStatusError(401).code, "PROVIDER_UNAUTHORIZED");
  assert.equal(embeddingsStatusError(403).code, "PROVIDER_UNAUTHORIZED");
  assert.equal(embeddingsStatusError(429).code, "PROVIDER_RATE_LIMITED");
  assert.equal(embeddingsStatusError(500).code, "NETWORK_ERROR");
  // The message names the status, never the provider's body.
  assert.ok(!String(embeddingsStatusError(500).message).includes(SECRET));
});

test("only an OpenAI-compatible endpoint is served", () => {
  assert.equal(supportsEmbeddings({}), true);
  assert.equal(supportsEmbeddings({ apiStyle: "openai" }), true);
  assert.equal(supportsEmbeddings({ authKind: "oauth" }), false);
  assert.equal(supportsEmbeddings({ apiStyle: "anthropic" }), false);
  assert.equal(embeddingsUrl("https://router.example/v1"), "https://router.example/v1/embeddings");
  assert.equal(embeddingsUrl("https://router.example/v1/"), "https://router.example/v1/embeddings");
});

test("models.list keeps its historical answer and selects a kind on request", () => {
  assert.equal(normalizeModelsListInput(undefined), "chat");
  assert.equal(normalizeModelsListInput({}), "chat");
  assert.equal(normalizeModelsListInput({ kind: "embedding" }), "embedding");
  assert.equal(normalizeModelsListInput({ kind: "all" }), "all");
  assert.throws(() => normalizeModelsListInput({ kind: "vision" }), /INVALID_ARGUMENT|kind/);

  const providers = [
    {
      id: "router",
      name: "Router",
      enabled: true,
      hasSecret: true,
      models: [
        { id: "chat-model", thinkingLevels: ["off"] },
        { id: "bge-m3", kind: "embedding" },
      ],
    },
  ];
  const settings = { defaultProviderId: "router", defaultModelId: "chat-model" };
  const chat = listReadyPluginModels(providers, settings);
  assert.deepEqual(chat.map((model) => model.modelId), ["chat-model"]);
  assert.equal(chat[0].kind, "chat");
  assert.equal(chat[0].isDefault, true);

  const embedding = listReadyPluginModels(providers, settings, "embedding");
  assert.deepEqual(embedding.map((model) => model.modelId), ["bge-m3"]);
  assert.equal(embedding[0].kind, "embedding");
  assert.equal(embedding[0].isDefault, false, "a vector model is never the launch default");

  const all = listReadyPluginModels(providers, settings, "all");
  assert.deepEqual(all.map((model) => model.kind), ["chat", "embedding"]);
});

test("the per-plugin pace stops a runaway caller", () => {
  const limiter = new EmbeddingsRateLimiter();
  const start = 1_000_000;
  for (let call = 0; call < EMBEDDINGS_RATE_MAX_CALLS; call += 1) {
    assert.equal(limiter.take("plugin-a", start + call), true);
  }
  assert.equal(limiter.take("plugin-a", start + EMBEDDINGS_RATE_MAX_CALLS), false);
  assert.equal(limiter.take("plugin-b", start + EMBEDDINGS_RATE_MAX_CALLS), true);
  // The window slides: a minute after the first calls, they no longer count.
  assert.equal(limiter.take("plugin-a", start + 60_000 + 1), true);
});
