import { describe, expect, it } from "vitest";
import { genericModelConfig, modelConfigWithBinding } from "./model-capabilities.js";
import {
  buildProviderModel,
  createProviderModels,
  type RuntimeProviderConfig,
} from "./provider-binding.js";

function providerFor(
  modelId: string,
  supportsReasoningEffort?: boolean | null,
): RuntimeProviderConfig {
  return {
    id: "custom-gateway",
    name: "Custom gateway",
    baseUrl: "https://gateway.example/v1",
    authKind: "api_key_and_base_url",
    apiKey: "fixture-key",
    apiStyle: "chat_completions",
    modelId,
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "high"],
    modelConfig: modelConfigWithBinding(genericModelConfig(modelId, "https://gateway.example/v1"), {
      contextWindow: 128_000,
      maxTokens: 8_192,
      thinkingLevels: ["off", "high"],
      supportsReasoningEffort,
    }),
  };
}

async function chatCompletionsBody(
  provider: RuntimeProviderConfig,
  reasoning: "low" | "high" | "max" | null = "high",
): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const model = buildProviderModel(provider);
  const result = await createProviderModels(provider, model).streamSimple(model, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, {
    ...(reasoning ? { reasoning } : {}),
    maxRetries: 0,
    fetch: async (input, init) => {
      bodies.push(await new Request(input, init).json() as Record<string, unknown>);
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 0,
        model: provider.modelId,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  }).result();
  expect(result.stopReason).toBe("stop");
  expect(result.content).toEqual([{ type: "text", text: "OK" }]);
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

async function responsesBody(provider: RuntimeProviderConfig): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const model = buildProviderModel(provider);
  const result = await createProviderModels(provider, model).streamSimple(model, {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  }, {
    reasoning: "high",
    maxRetries: 0,
    fetch: async (input, init) => {
      bodies.push(await new Request(input, init).json() as Record<string, unknown>);
      const completed = {
        type: "response.completed",
        response: { id: "fixture", status: "completed", output: [] },
      };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  }).result();
  expect(result.stopReason).toBe("stop");
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe("per-model Chat Completions reasoning effort override", () => {
  it.each([
    ["deepseek-v4.1-flash", undefined, undefined],
    ["deepseek-v4.1-flash", null, undefined],
    ["deepseek-v4.1-flash", true, "high"],
    ["deepseek-v4.1-flash", false, undefined],
    ["custom-reasoner", undefined, "high"],
    ["custom-reasoner", null, "high"],
    ["custom-reasoner", true, "high"],
    ["custom-reasoner", false, undefined],
  ] as const)("%s with saved override %s sends effort %s", async (modelId, override, expected) => {
    const body = await chatCompletionsBody(providerFor(modelId, override));
    expect(body.reasoning_effort).toBe(expected);
  });

  it("keeps its documented value outside the request body", () => {
    expect(buildProviderModel(providerFor("custom-reasoner", true))).not.toHaveProperty(
      "supportsReasoningEffort",
    );
    expect(buildProviderModel(providerFor("custom-reasoner", false)).compat).toMatchObject({
      supportsReasoningEffort: false,
    });
  });

  it("does not invent reasoning capability from the switch", async () => {
    const provider: RuntimeProviderConfig = {
      ...providerFor("plain-model", true),
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
      modelConfig: modelConfigWithBinding({
        ...genericModelConfig("plain-model"),
        source: "models.dev" as const,
        reasoning: false,
      }, {
        contextWindow: 128_000,
        maxTokens: 8_192,
        thinkingLevels: [],
        supportsReasoningEffort: true,
      }),
    };
    expect(buildProviderModel(provider).reasoning).toBe(false);
    expect((await chatCompletionsBody(provider)).reasoning_effort).toBeUndefined();
  });

  it.each([undefined, null, false, true])(
    "preserves the official DeepSeek saved override %s",
    async (override) => {
      const provider = {
        ...providerFor("deepseek-v4.1-flash", override),
        vendorKey: "deepseek",
        baseUrl: "https://api.deepseek.com",
      };
      const compat = buildProviderModel(provider).compat ?? {};
      if (typeof override === "boolean") {
        expect(compat).toHaveProperty("supportsReasoningEffort", override);
      } else {
        expect(compat).not.toHaveProperty("supportsReasoningEffort");
      }
      const body = await chatCompletionsBody(provider);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe(override === false ? undefined : "high");
    },
  );

  it.each([undefined, false, true])("keeps Minih Router relay defaults and saved override %s", async (override) => {
    const provider = {
      ...providerFor("deepseek-v4.1-flash", override),
      vendorKey: "minih-router",
      baseUrl: "https://router.hmini.org/v1",
    };
    expect(buildProviderModel(provider).compat).toMatchObject({
      supportsReasoningEffort: override === true,
      requiresNonEmptyReasoningReplay: true,
    });
    expect((await chatCompletionsBody(provider)).reasoning_effort)
      .toBe(override === true ? "high" : undefined);
  });

  it("does not mistake catalog compatibility for an explicit saved override", () => {
    const provider = providerFor("deepseek-v4.1-flash");
    provider.modelConfig = {
      ...provider.modelConfig!,
      compat: { ...provider.modelConfig?.compat, supportsReasoningEffort: true },
    };
    expect(buildProviderModel(provider).compat).toMatchObject({
      supportsReasoningEffort: false,
    });
  });

  it.each([true, false, null])("does not apply saved override %s to Responses", async (override) => {
    const provider = { ...providerFor("deepseek-v4.1-flash", override), apiStyle: "responses" };
    const model = buildProviderModel(provider);
    expect(model.api).toBe("openai-responses");
    expect(model.compat ?? {}).not.toHaveProperty("supportsReasoningEffort");
    const body = await responsesBody(provider);
    expect(body.reasoning).toMatchObject({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it.each([true, false, null])(
    "does not apply saved override %s to Anthropic thinking",
    async (override) => {
      const provider = {
        ...providerFor("claude-sonnet-4-6", override),
        baseUrl: "https://api.anthropic.com",
        apiStyle: "anthropic_messages",
      };
      const model = buildProviderModel(provider);
      expect(model.api).toBe("anthropic-messages");
      expect(model.compat ?? {}).not.toHaveProperty("supportsReasoningEffort");
      let body: Record<string, unknown> | undefined;
      await createProviderModels(provider, model).streamSimple(model, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      }, {
        reasoning: "high",
        maxRetries: 0,
        fetch: async (input, init) => {
          body = await new Request(input, init).json() as Record<string, unknown>;
          return new Response(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "fixture response" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      }).result();
      expect(body).toBeDefined();
      expect(body).not.toHaveProperty("reasoning_effort");
    },
  );
});

describe("official DeepSeek effort values on the wire", () => {
  it.each(["low", "high", "max", null] as const)("sends selected level %s without changing the thinking toggle", async (level) => {
    const provider: RuntimeProviderConfig = {
      ...providerFor("deepseek-v4.1-flash"),
      vendorKey: "deepseek", baseUrl: "https://api.deepseek.com/v1",
      supportedThinkingLevels: ["off", "low", "high", "max"],
      modelConfig: modelConfigWithBinding(genericModelConfig("deepseek-v4.1-flash"), {
        contextWindow: 128_000, maxTokens: 8192, thinkingLevels: ["off", "low", "high", "max"],
      }),
    };
    const body = await chatCompletionsBody(provider, level);
    expect(body.thinking).toEqual({ type: level ? "enabled" : "disabled" });
    expect(body.reasoning_effort).toBe(level ?? undefined);
  });
});