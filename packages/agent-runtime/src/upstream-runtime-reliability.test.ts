import { describe, expect, it } from "vitest";
import { classifyAgentError } from "./agent-errors.js";
import { toolResultFromUi } from "./runtime.js";

// Selected non-plugin regressions from upstream b8748f2eb, c5e53d302 and 9944b3994.
describe("transport wording is not user cancellation or credential rejection", () => {
  it.each([
    ["software caused connection abort", "NETWORK_ERROR"],
    ["connection aborted", "NETWORK_ERROR"],
    ["stream aborted", "STREAM_FAILED"],
    ["provider aborted the stream", "STREAM_FAILED"],
  ])("keeps %s retryable", (message, code) => {
    expect(classifyAgentError(new Error(message))).toMatchObject({ code, retriable: true });
  });

  it.each(["Request aborted", "The operation was aborted", "Turn aborted while compacting context"])(
    "preserves explicit Stop wording: %s", (message) => {
      expect(classifyAgentError(message)).toMatchObject({ code: "TURN_ABORTED", retriable: false });
    },
  );

  it("preserves structured cancellation and certificate verification failures", () => {
    expect(classifyAgentError(Object.assign(new Error("cancelled"), { name: "AbortError" })))
      .toMatchObject({ code: "TURN_ABORTED", retriable: false });
    expect(classifyAgentError(Object.assign(new Error("mutual TLS authentication failed"), {
      code: "CERT_HAS_EXPIRED",
    }))).toMatchObject({
      code: "NETWORK_ERROR", retriable: false,
      details: { networkCategory: "tls", networkCode: "CERT_HAS_EXPIRED" },
    });
  });

  it.each(["mutual TLS authentication failed", "authentication handshake timed out"])(
    "classifies %s as retryable transport failure", (message) => {
      expect(classifyAgentError(new Error(message))).toMatchObject({
        code: "NETWORK_ERROR", retriable: true, details: { networkCategory: "tls" },
      });
    },
  );

  it.each(["Invalid API key", "unauthorized", "permission denied", "invalid authentication credentials", "authentication failed"])(
    "preserves terminal credential rejection: %s", (message) => {
      expect(classifyAgentError(new Error(message))).toMatchObject({
        code: "PROVIDER_UNAUTHORIZED", retriable: false,
      });
    },
  );

  it.each([401, 403])("preserves explicit provider status %s", (status) => {
    expect(classifyAgentError(Object.assign(new Error("unauthorized"), { status })))
      .toMatchObject({ code: "PROVIDER_UNAUTHORIZED", retriable: false });
  });
});

function restore(toolResult: Parameters<typeof toolResultFromUi>[0]["toolResult"]) {
  const timestamp = Date.parse("2026-10-26T00:00:00Z");
  return toolResultFromUi({
    id: "resource-call", role: "tool", content: "",
    createdAt: new Date(timestamp).toISOString(),
    toolCallId: "resource-call", toolName: "get_file_contents",
    toolResult, toolStatus: "success", isError: false,
  }, timestamp);
}

describe("MCP text resources survive historical tool-result restoration", () => {
  const resource = {
    type: "resource",
    resource: { uri: "repo://fixture/src/index.ts", mimeType: "text/plain", text: "export const answer = 42;\n" },
  };

  it("restores a resource-only result instead of a missing-result placeholder", () => {
    expect(restore({ content: [resource] }).content).toEqual([
      { type: "text", text: "export const answer = 42;\n" },
    ]);
  });

  it("preserves ordered status, resource text, resource link and image blocks", () => {
    const restored = restore({ content: [
      { type: "text", text: "downloaded" }, resource,
      { type: "resource_link", uri: "https://example.test/big.json", name: "big.json" },
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ] });
    expect(restored.content).toEqual([
      { type: "text", text: "downloaded" },
      { type: "text", text: "export const answer = 42;\n" },
      { type: "text", text: "[resource link] big.json: https://example.test/big.json" },
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ]);
    expect(restored.isError).toBe(false);
  });

  it("does not turn binary resource bytes into model-visible text", () => {
    const restored = restore({ content: [{ type: "resource", resource: {
      uri: "file:///fixture.bin", mimeType: "application/octet-stream", blob: "QkxPQi1CWVRFUw==",
    } }] });
    expect(restored.content).toEqual([{ type: "text", text: "[no tool result recorded]" }]);
    expect(JSON.stringify(restored.content)).not.toContain("QkxPQi1CWVRFUw==");
  });
});
