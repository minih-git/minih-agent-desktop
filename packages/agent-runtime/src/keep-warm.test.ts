import { describe, expect, it, vi } from "vitest";
import type { AssistantMessageEventStream, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  KEEP_WARM_MIN_CONTEXT_TOKENS,
  KEEP_WARM_PROMPT,
  KEEP_WARM_STALE_AFTER_MS,
  keepWarmCacheReadRatio,
  type KeepWarmSkipReason,
} from "@minih-agent/shared";
import {
  KeepWarmLedger,
  keepWarmSkipReason,
  runKeepWarmRequest,
  type KeepWarmDecisionInput,
  type KeepWarmPrefixState,
} from "./keep-warm.js";
import { keepWarmPrefixFingerprint } from "./keep-warm-fingerprint.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { assembleProviderRequest } from "./provider-request.js";

const NOW = 1_700_000_000_000;

const provider: RuntimeProviderConfig = {
  id: "router",
  name: "Minih Router",
  vendorKey: "minih-router",
  baseUrl: "https://router.test/v1",
  modelId: "claude-sonnet",
  apiKey: "sk-fixture",
  authKind: "api_key",
  apiStyle: "anthropic",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
  modelConfig: {
    source: "generic",
    name: "Claude Sonnet",
    baseUrl: "https://router.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
} as RuntimeProviderConfig;

const history = [
  { role: "system" as const, content: "You are Minih.", timestamp: NOW },
  { role: "user" as const, content: "Explain the build.", timestamp: NOW },
  { role: "assistant" as const, content: [{ type: "text" as const, text: "Done." }], timestamp: NOW },
];

function decision(overrides: Partial<KeepWarmDecisionInput> = {}): KeepWarmDecisionInput {
  return {
    busy: false,
    running: false,
    state: prefixState(),
    api: "anthropic-messages",
    providerId: "router",
    modelId: "claude-sonnet",
    thinkingLevel: "medium",
    fingerprint: "digest",
    contextTokens: KEEP_WARM_MIN_CONTEXT_TOKENS + 1,
    now: NOW,
    ...overrides,
  };
}

function prefixState(overrides: Partial<KeepWarmPrefixState> = {}): KeepWarmPrefixState {
  return {
    fingerprint: "digest",
    api: "anthropic-messages",
    providerId: "router",
    modelId: "claude-sonnet",
    thinkingLevel: "medium",
    maxTokens: 8_192,
    contextTokens: KEEP_WARM_MIN_CONTEXT_TOKENS + 1,
    requestedAt: NOW - 60_000,
    settledAt: NOW - 60_000,
    ...overrides,
  };
}

describe("keepWarmSkipReason", () => {
  it("warms an idle session whose prefix is unchanged", () => {
    expect(keepWarmSkipReason(decision())).toBeNull();
  });

  const cases: Array<[string, KeepWarmSkipReason, Partial<KeepWarmDecisionInput>]> = [
    ["a running turn", "session_busy", { busy: true }],
    ["a warm request already in flight", "already_running", { running: true }],
    ["a session this process never saw", "no_prior_request", { state: undefined }],
    [
      "another provider",
      "model_changed",
      { state: prefixState({ providerId: "other" }) },
    ],
    ["another model", "model_changed", { state: prefixState({ modelId: "gpt" }) }],
    [
      "another thinking level",
      "model_changed",
      { state: prefixState({ thinkingLevel: "high" }) },
    ],
    ["another wire API", "model_changed", { state: prefixState({ api: "openai-responses" }) }],
    [
      "a cache past its lifetime",
      "prefix_expired",
      { now: NOW + KEEP_WARM_STALE_AFTER_MS + 1 },
    ],
    ["a rebuilt prefix", "prefix_changed", { state: prefixState({ fingerprint: "other" }) }],
    [
      "a context too small to be worth it",
      "context_too_small",
      { contextTokens: KEEP_WARM_MIN_CONTEXT_TOKENS - 1 },
    ],
    ["an adapter that cannot report usage here", "protocol_unsupported", { api: "google-generative-ai" }],
  ];

  for (const [name, reason, overrides] of cases) {
    it(`refuses ${name} with ${reason}`, () => {
      expect(keepWarmSkipReason(decision(overrides))).toBe(reason);
    });
  }

  it("refuses exactly at the lifetime boundary, one millisecond at a time", () => {
    const settledAt = NOW - KEEP_WARM_STALE_AFTER_MS;
    expect(keepWarmSkipReason(decision({ state: prefixState({ settledAt }) }))).toBeNull();
    expect(
      keepWarmSkipReason(decision({ state: prefixState({ settledAt }), now: NOW + 2 })),
    ).toBe("prefix_expired");
  });

  it("measures the cache age from when the last request settled", () => {
    // The turn started long before it ended; the cache clock starts at the end.
    const state = prefixState({ requestedAt: NOW - KEEP_WARM_STALE_AFTER_MS, settledAt: NOW - 1 });
    expect(keepWarmSkipReason(decision({ state }))).toBeNull();
  });
});

describe("KeepWarmLedger", () => {
  it("records, settles and forgets one session without touching another", () => {
    const ledger = new KeepWarmLedger();
    ledger.record("a", prefixState());
    ledger.record("b", prefixState({ fingerprint: "b" }));
    ledger.settle("a", NOW);
    expect(ledger.get("a")?.settledAt).toBe(NOW);
    expect(ledger.get("a")?.fingerprint).toBe("digest");
    expect(ledger.get("b")?.settledAt).toBe(NOW - 60_000);
    ledger.forget("a");
    expect(ledger.get("a")).toBeUndefined();
    expect(ledger.size).toBe(1);
  });
});

describe("keepWarmPrefixFingerprint", () => {
  const base = {
    api: "anthropic-messages",
    baseUrl: "https://router.test/v1",
    providerId: "router",
    modelId: "claude-sonnet",
    messages: history,
  };

  it("is stable across a rebuild and object key order", () => {
    const rebuilt = history.map((message) => ({
      timestamp: message.timestamp,
      content: message.content,
      role: message.role,
    }));
    expect(keepWarmPrefixFingerprint({ ...base, messages: rebuilt })).toBe(
      keepWarmPrefixFingerprint(base),
    );
  });

  it("ignores message identity, telemetry and timestamps, which never reach the wire", () => {
    // A runtime rebuilt from history fills zeros into a reply's usage and
    // re-tags its api/provider/model. None of that is sent, so none of it may
    // decide the digest — otherwise a rebuilt runtime could never warm.
    const restamped = history.map((message, index) => ({
      ...message,
      id: `msg-${index}`,
      timestamp: NOW + index * 1_000,
      api: "openai-completions",
      provider: "local",
      model: "local-model",
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    }));
    expect(keepWarmPrefixFingerprint({ ...base, messages: restamped })).toBe(
      keepWarmPrefixFingerprint(base),
    );
  });

  it("sees the system prompt and the tool set, which this runtime keeps as sections", () => {
    // A transcript system message carries an empty `content`: the prompt lives
    // in `sections`, the tools in `toolsAdded`/`toolsRemoved`. A digest that
    // only read `content` would be blind to every prompt and tool change.
    const system = {
      role: "system" as const,
      content: "",
      sections: { runtime: "You are Minih." },
      toolsAdded: [{ name: "Read", description: "read", parameters: { type: "object" } }],
      timestamp: NOW,
    };
    const withSystem = { ...base, messages: [system, ...history] };
    const digest = keepWarmPrefixFingerprint(withSystem);
    expect(
      keepWarmPrefixFingerprint({
        ...withSystem,
        messages: [{ ...system, sections: { runtime: "You are Minih, in plan mode." } }, ...history],
      }),
    ).not.toBe(digest);
    expect(
      keepWarmPrefixFingerprint({
        ...withSystem,
        messages: [
          { ...system, toolsAdded: [...system.toolsAdded, { name: "Edit", description: "edit" }] },
          ...history,
        ],
      }),
    ).not.toBe(digest);
    expect(
      keepWarmPrefixFingerprint({
        ...withSystem,
        messages: [{ ...system, toolsRemoved: [{ name: "Read" }] }, ...history],
      }),
    ).not.toBe(digest);
  });

  it("changes when anything the provider caches changes", () => {
    const digest = keepWarmPrefixFingerprint(base);
    expect(keepWarmPrefixFingerprint({ ...base, modelId: "claude-opus" })).not.toBe(digest);
    expect(keepWarmPrefixFingerprint({ ...base, baseUrl: "https://other.test/v1" })).not.toBe(
      digest,
    );
    expect(
      keepWarmPrefixFingerprint({
        ...base,
        messages: [{ ...history[0], content: "You are Minih, updated." }, ...history.slice(1)],
      }),
    ).not.toBe(digest);
    expect(
      keepWarmPrefixFingerprint({
        ...base,
        messages: [
          ...history,
          { role: "user", content: KEEP_WARM_PROMPT, timestamp: NOW },
        ],
      }),
    ).not.toBe(digest);
  });
});

describe("keep-warm request assembly", () => {
  const model = buildProviderModel(provider);
  const context = { messages: history } as never;

  function assemble(extra?: { messages: typeof history }) {
    return assembleProviderRequest({
      provider,
      model,
      context: (extra ? { messages: extra.messages } : context) as never,
      sessionId: "session-1",
      base: {},
      withHooks: (options) => options,
      maxRetries: 0,
      capture: () => undefined,
      omitThinking: false,
    });
  }

  it("keeps the prefix digest when the warm request appends its message", () => {
    const real = assemble();
    const warm = assemble({
      messages: [
        ...history,
        { role: "user", content: KEEP_WARM_PROMPT, timestamp: NOW },
      ],
    });
    expect(warm.fingerprint).not.toBe(real.fingerprint);
    // The guard compares the warm request's *prefix* — history without the
    // appended message — with what the last real request recorded.
    const warmPrefix = assembleProviderRequest({
      provider,
      model,
      context: { messages: history } as never,
      sessionId: "session-1",
      base: {},
      withHooks: (options) => options,
      maxRetries: 0,
      capture: () => undefined,
      omitThinking: false,
    });
    expect(warmPrefix.fingerprint).toBe(real.fingerprint);
  });

  // The three protocols this feature supports, spelled the way a provider row
  // stores them. Only the Anthropic adapter reports usage early, and none of
  // them may be asked for a different answer than a real turn.
  const WIRE_STYLES = [
    { apiStyle: "anthropic_messages", api: "anthropic-messages" },
    { apiStyle: "chat", api: "openai-completions" },
    { apiStyle: "responses", api: "openai-responses" },
  ] as const;

  for (const style of WIRE_STYLES) {
    it(`asks for exactly what a turn asks for (${style.api})`, () => {
      const variant = { ...provider, apiStyle: style.apiStyle } as RuntimeProviderConfig;
      const model = buildProviderModel(variant);
      const base = { reasoning: "high", maxTokens: 8_192 } as SimpleStreamOptions;
      const assembleWith = (messages: typeof history) =>
        assembleProviderRequest({
          provider: variant,
          model,
          context: { messages } as never,
          sessionId: "session-1",
          base,
          withHooks: (options) => options,
          maxRetries: 0,
          capture: () => undefined,
          omitThinking: false,
        });
      const real = assembleWith(history);
      const warm = assembleWith([
        ...history,
        { role: "user", content: KEEP_WARM_PROMPT, timestamp: NOW },
      ]);
      const wire = (options: SimpleStreamOptions) =>
        JSON.parse(JSON.stringify(options)) as Record<string, unknown>;
      // Same output ceiling, same thinking parameter, same everything: only the
      // appended message differs.
      expect(wire(warm.options)).toEqual(wire(real.options));
      expect(warm.maxTokens).toBe(real.maxTokens);
      expect(real.options.maxTokens).not.toBe(16);
    });
  }

  it("sends the same request options the turn sends", () => {
    // The transport members are per-call closures by design (a fetch wrapper
    // and its abort signal); everything the adapter reads off the options has
    // to be equal, including the output ceiling. A protocol that reports usage
    // early is never capped, so nothing but the appended message is left.
    const wire = (options: SimpleStreamOptions) =>
      JSON.parse(JSON.stringify(options)) as Record<string, unknown>;
    const real = assemble();
    const warm = assemble();
    expect(wire(warm.options)).toEqual(wire(real.options));
    expect(warm.maxTokens).toBe(real.maxTokens);
  });

  it("only changes the request through the message the caller appends", () => {
    const real = assemble();
    const warm = assemble({
      messages: [
        ...history,
        { role: "user", content: KEEP_WARM_PROMPT, timestamp: NOW },
      ],
    });
    expect(warm.context.messages.slice(0, -1)).toEqual(real.context.messages);
    expect(warm.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: KEEP_WARM_PROMPT,
    });
  });
});

describe("runKeepWarmRequest", () => {
  function streamOf(events: unknown[]): AssistantMessageEventStream {
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            if (index >= events.length) return { done: true as const, value: undefined };
            return { done: false as const, value: events[index++] };
          },
        };
      },
    } as unknown as AssistantMessageEventStream;
  }

  const usage = { input: 40, output: 1, cacheRead: 48_000, cacheWrite: 200, cost: { total: 0.02 } };

  it("stops at the first event that reports usage", async () => {
    const aborted = vi.fn();
    const events = [
      { type: "start", partial: { usage } },
      { type: "text_delta", delta: "never read", partial: { usage } },
    ];
    const outcome = await runKeepWarmRequest({
      stream: () => streamOf(events),
      options: {} as SimpleStreamOptions,
      abort: aborted,
      earlyUsage: true,
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(aborted).toHaveBeenCalledTimes(1);
    if (outcome.ok) {
      expect(outcome.usage.cacheReadTokens).toBe(48_000);
      expect(keepWarmCacheReadRatio(outcome.usage)).toBeCloseTo(48_000 / 48_240, 6);
    }
  });

  it("reads to the end when the protocol reports usage only at the end", async () => {
    const seen: string[] = [];
    const events = [
      { type: "text_delta", delta: "a", partial: {} },
      { type: "done", message: { usage } },
    ];
    const outcome = await runKeepWarmRequest({
      stream: () =>
        ({
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              async next() {
                if (index >= events.length) return { done: true as const, value: undefined };
                seen.push(events[index]!.type);
                return { done: false as const, value: events[index++] };
              },
            };
          },
        }) as unknown as AssistantMessageEventStream,
      options: {} as SimpleStreamOptions,
      abort: () => undefined,
      earlyUsage: false,
    });
    expect(seen).toEqual(["text_delta", "done"]);
    expect(outcome).toMatchObject({ ok: true });
  });

  it("reports a provider failure and still closes the request", async () => {
    const aborted = vi.fn();
    const outcome = await runKeepWarmRequest({
      stream: () => streamOf([{ type: "error", error: { errorMessage: "502" } }]),
      options: {} as SimpleStreamOptions,
      abort: aborted,
      earlyUsage: true,
    });
    expect(outcome).toEqual({ ok: false, reason: "provider_error", message: "502" });
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it("calls an aborted signal an abort, not a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runKeepWarmRequest({
      stream: () => streamOf([{ type: "error", error: {} }]),
      options: { signal: controller.signal } as SimpleStreamOptions,
      abort: () => undefined,
      earlyUsage: true,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("treats a stream that reports no prompt tokens as a failure", async () => {
    const outcome = await runKeepWarmRequest({
      stream: () => streamOf([{ type: "done", message: {} }]),
      options: {} as SimpleStreamOptions,
      abort: () => undefined,
      earlyUsage: true,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "provider_error" });
  });
});
