import { fileOperationPath } from "./tool-path-arguments.js";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UiMessage } from "@minih-agent/shared";
import { classifyAgentError } from "./agent-errors.js";
import { classifyProviderError } from "./provider-retry.js";
import { estimateOutputCapInputTokens, clampOutputToContext } from "./output-cap.js";
import { prepareCompaction } from "./pi-runtime-compaction-plan.js";
import { withPiFileOpToolNames } from "./pi-file-ops.js";
import type { Entry } from "./pi-runtime-types.js";
import { chainRowsToMessages } from "./delegation-history.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";
import { DesktopAgentRuntime, toolResultFromUi, type RuntimeMatchConfig } from "./runtime.js";
import { usageToPi } from "./agent-messages.js";

// Selected upstream sources and Minih-specific invariants are recorded in
// docs/project/upstream-import-2026-11-01.md. These tests use no provider I/O.
describe("selected upstream reliability regressions", () => {
  it.each(["中", "こ", "カ", "안", "\u1100", "\u3131", "\u31f0", "\uf900"])(
    "counts %s in text and tool payloads without changing the ASCII baseline", (character) => {
      const tool = (content: string) => ({ messages: [{ role: "assistant", content: [
        { type: "toolCall", name: "Write", arguments: { content } },
      ] }] });
      expect(estimateOutputCapInputTokens({ messages: [{ role: "user", content: character.repeat(1000) }] })).toBe(1000);
      expect(estimateOutputCapInputTokens(tool(character.repeat(1000)))).toBe(1005);
      expect(estimateOutputCapInputTokens(tool("a".repeat(1000)))).toBe(255);
      const context = tool(character.repeat(110_000));
      expect(clampOutputToContext({ contextWindow: 128_000, maxTokens: 32_768 }, context, 32_768)).toBe(13_899);
    },
  );

  it.each([
    ["402: arbitrary body", "PROVIDER_ERROR", false],
    ["Insufficient credits", "PROVIDER_ERROR", false],
    ["This request requires more credits", "PROVIDER_ERROR", false],
    ["Payment Required", "PROVIDER_ERROR", false],
    ["429: Insufficient credits", "PROVIDER_ERROR", false],
    ["credits", "PROVIDER_ERROR", true],
    ["insufficient credentials", "PROVIDER_ERROR", true],
    ["429: credits remaining", "PROVIDER_RATE_LIMITED", true],
  ] as const)("classifies credit exhaustion without changing rate limits: %s", (message, code, retriable) => {
    expect(classifyAgentError(message)).toMatchObject({ code, retriable });
    expect(classifyProviderError({ role: "assistant", stopReason: "error", errorMessage: message })).toMatchObject({ code, retriable });
  });

  it.each([
    [400, "unsupported location", "PROVIDER_ERROR", false],
    [400, "input token count exceeds the maximum number of tokens allowed", "CONTEXT_TOO_LARGE", false],
    [402, "arbitrary body", "PROVIDER_ERROR", false],
    [404, "not found", "MODEL_NOT_CONFIGURED", false],
    [429, "Resource exhausted", "PROVIDER_RATE_LIMITED", true],
    [429, "Insufficient credits", "PROVIDER_ERROR", false],
    [503, "unavailable", "PROVIDER_ERROR", true],
  ] as const)("reads a nested JSON HTTP status %s", (status, message, code, retriable) => {
    const errorMessage = JSON.stringify({ error: { code: status, message, status: "INVALID_ARGUMENT" } });
    expect(classifyAgentError(new Error(errorMessage))).toMatchObject({ code, retriable, details: { providerStatus: status } });
    expect(classifyProviderError({ role: "assistant", stopReason: "error", errorMessage })).toMatchObject({ code, retriable });
  });

  it("accepts a Google RPC status but rejects unrelated or malformed JSON codes", () => {
    expect(classifyAgentError(JSON.stringify({ code: 400, status: "INVALID_ARGUMENT", message: "bad" }))).toMatchObject({ retriable: false, details: { providerStatus: 400 } });
    for (const value of [
      { code: 400 }, { code: 400, status: "bad status" }, { error: { code: "400" } },
      { error: { code: 399 } }, { error: { code: 600 } }, { error: { code: 400.5 } }, [], null,
    ]) expect(classifyAgentError(JSON.stringify(value)).details?.providerStatus).toBeUndefined();
    expect(classifyAgentError("{invalid JSON").details?.providerStatus).toBeUndefined();
    expect(classifyAgentError(Object.assign(new Error('{"error":{"code":400}}'), { status: 429 }))).toMatchObject({ code: "PROVIDER_RATE_LIMITED", retriable: true });
  });

  it("collects checkpoint file aliases using execution precedence, including an empty canonical path", () => {
    const calls: Array<[string, Record<string, string>]> = [
      ["Read", { file_path: "src/a.txt" }], ["Edit", { filepath: "src/b.ts", filePath: "ignored" }],
      ["Write", { file: "src/c.ts" }], ["Read", { path: "canonical", file_path: "ignored" }],
      ["Write", { path: "", file_path: "ignored" }], ["Read", { filename: "name", fileName: "ignored" }],
      ["Read", { fileName: "camel", file: "ignored" }], ["Read", { filePath: "pathCamel" }],
    ];
    const message: AgentMessage = { role: "assistant", api: "openai-completions",
      provider: "test", model: "test-model", stopReason: "toolUse", timestamp: 2,
      usage: usageToPi(undefined), content: calls.map(([name, args], index) => ({
        type: "toolCall", name, arguments: args, id: `call-${index}`,
      })) };
    const entries: Entry[] = [
      { type: "message", id: "u", parentId: null, seq: 1, timestamp: 1, message: { role: "user", content: "change files", timestamp: 1 } },
      { type: "message", id: "a", parentId: "u", seq: 2, timestamp: 2, message },
      { type: "message", id: "last", parentId: "a", seq: 3, timestamp: 3, message: { role: "user", content: "next", timestamp: 3 } },
    ];
    const result = prepareCompaction(withPiFileOpToolNames(entries), { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 });
    if (!result.ok || !result.value) throw new Error("Expected compaction preparation");
    expect([...result.value.fileOps.read]).toEqual(["src/a.txt", "canonical", "name", "camel", "pathCamel"]);
    expect([...result.value.fileOps.edited]).toEqual(["src/b.ts"]);
    expect([...result.value.fileOps.written]).toEqual(["src/c.ts"]);
  });

  it.each([
    { path: "shot.png", images: [{ data: "IMAGE_BYTES", mimeType: "image/png" }] },
    { content: [{ type: "resource", resource: { uri: "file:///a.ts", text: "body" } }] },
    { content: [{ type: "text", text: "ok" }, { type: "resource", resource: { text: "body" } }, { type: "resource_link", uri: "file:///large", name: "large" }] },
  ])("restores a delegate's tool content like its parent: %j", (toolResult) => {
    const row: UiMessage = { id: "tool", role: "tool", content: "", toolName: "Read", toolCallId: "call",
      toolStatus: "success", toolResult, createdAt: "2026-11-01T00:00:00Z" };
    const provider: RuntimeProviderConfig = { id: "test", name: "Test", modelId: "test-model", apiStyle: "openai-completions", apiKey: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] };
    const restored = chainRowsToMessages([row], provider, buildProviderModel(provider)).find((entry) => entry.role === "toolResult");
    expect(restored?.content).toEqual(toolResultFromUi(row, Date.parse(row.createdAt)).content);
    if (restored?.role !== "toolResult") throw new Error("Missing restored result");
    for (const block of restored.content) if (block.type === "text") expect(block.text).not.toContain("IMAGE_BYTES");
    expect(restored.isError).toBe(false);
  });
});

describe("runtime rebuild diagnostics preserve Minih configuration", () => {
  it("names the changed field without exposing its value or relaxing reuse", async () => {
    const provider: RuntimeProviderConfig = { id: "test", modelId: "test-model", apiStyle: "openai-completions",
      name: "Test", supportsReasoning: false, supportedThinkingLevels: ["off"],
      apiKey: "fixture", fallbackBaseUrl: "https://fallback.example/v1" };
    const config: RuntimeMatchConfig = { mode: "agent", provider, thinkingLevel: "off",
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      modelSystemPrompt: "model instructions", learnedMemoryRead: true };
    const runtime = new DesktopAgentRuntime({ ...config, sessionId: "diagnostics",
      host: { async call() { throw new Error("Unexpected Host I/O"); } }, onEvent() {} });
    try {
      expect(runtime.firstMismatch(config)).toBeNull();
      expect(runtime.matches(config)).toBe(true);
      const cases: Array<[string, Partial<RuntimeMatchConfig>]> = [
        ["provider.fallbackBaseUrl", { provider: { ...provider, fallbackBaseUrl: "https://other.example/v1" } }],
        ["provider.apiKey", { provider: { ...provider, apiKey: "changed-fixture" } }],
        ["modelSystemPrompt", { modelSystemPrompt: "different instructions" }],
        ["learnedMemoryRead", { learnedMemoryRead: false }],
        ["projectMemory", { projectMemory: "new project memory" }],
        ["mode", { mode: "plan" }],
      ];
      for (const [field, override] of cases) {
        expect(runtime.firstMismatch({ ...config, ...override })).toBe(field);
        expect(runtime.matches({ ...config, ...override })).toBe(false);
      }
      expect(runtime.firstMismatch({ ...config, modelSystemPrompt: " model instructions " })).toBeNull();
    } finally { await runtime.dispose(); }
    expect(runtime.firstMismatch({ ...config, provider: { ...provider, apiKey: "other" } })).toBe("disposed");
  });
});

describe("persisted tool compatibility", () => {
  it("keeps absent, invalid and canonical path values authoritative", () => {
    for (const args of [undefined, null, [], 42, {}, { path: null, file_path: "ignored" }, { path: "", file: "ignored" }]) {
      expect(fileOperationPath(args)).toBeUndefined();
    }
    expect(fileOperationPath({ filePath: "camel", file: "ignored" })).toBe("camel");
  });

  it.each(["running", "error", "denied"] as const)("retains %s tool details and activation metadata on both restore paths", (toolStatus) => {
    const row: UiMessage = { id: "activation", role: "tool", content: "", createdAt: "2026-11-01T00:00:00Z",
      toolName: "ToolSearch", toolCallId: "activation-call", toolStatus, toolResult: {
        content: [{ type: "text", text: "activated" }], addedToolNames: ["Read"], details: { retained: "metadata" },
      } };
    const provider: RuntimeProviderConfig = { id: "test", name: "Test", modelId: "test-model",
      apiStyle: "openai-completions", apiKey: "fixture", supportsReasoning: false, supportedThinkingLevels: ["off"] };
    const parent = toolResultFromUi(row, Date.parse(row.createdAt));
    const child = chainRowsToMessages([row], provider, buildProviderModel(provider)).find((entry) => entry.role === "toolResult");
    for (const result of [parent, child]) {
      expect(result).toMatchObject({ isError: true, details: { retained: "metadata", addedToolNames: ["Read"] } });
    }
  });
});
