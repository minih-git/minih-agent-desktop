import { describe, expect, it } from "vitest";
import {
  createProviderStreamTrace,
  formatProviderStreamTraceLine,
  PROVIDER_STREAM_TRACE_ENV,
  providerStreamTraceEnabled,
} from "./provider-stream-trace.js";

function env(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [PROVIDER_STREAM_TRACE_ENV]: value };
}

describe("providerStreamTraceEnabled", () => {
  it("stays off unless the operator asks for it", () => {
    expect(providerStreamTraceEnabled(env(undefined))).toBe(false);
    expect(providerStreamTraceEnabled(env(""))).toBe(false);
    expect(providerStreamTraceEnabled(env("0"))).toBe(false);
    expect(providerStreamTraceEnabled(env("false"))).toBe(false);
  });

  it("accepts the usual on values, case and padding included", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(providerStreamTraceEnabled(env(value))).toBe(true);
    }
  });

  it("gives the caller nothing to wire when disabled", () => {
    expect(createProviderStreamTrace(env(undefined))).toBeUndefined();
    expect(createProviderStreamTrace(env("1"))).toBeDefined();
  });
});

describe("provider stream trace counts", () => {
  it("counts a Responses stream that carries a tool call", () => {
    const trace = createProviderStreamTrace(env("1"));
    if (!trace) throw new Error("trace should be enabled");

    trace.record({ type: "response.created" });
    trace.record({ type: "response.output_item.added", item: { type: "message" } });
    trace.record({ type: "response.output_text.delta", delta: "先跑验证。" });
    trace.record({ type: "response.output_item.done", item: { type: "message" } });
    trace.record({ type: "response.output_item.added", item: { type: "function_call" } });
    trace.record({ type: "response.function_call_arguments.delta", delta: '{"command":' });
    trace.record({ type: "response.function_call_arguments.delta", delta: '"ls"}' });
    trace.record({ type: "response.output_item.done", item: { type: "function_call" } });
    trace.record({
      type: "response.completed",
      response: { status: "completed", output: [{ type: "message" }, { type: "function_call" }] },
    });

    expect(trace.summary()).toEqual({
      events: 9,
      textChars: 5,
      toolCallDeltas: 2,
      argumentChars: 16,
      functionCallItems: 1,
      functionCallDones: 1,
      terminal: "response.completed",
      terminalStatus: "completed",
      completedOutputToolCalls: 1,
      errors: 0,
      providerToolMarkers: 0,
    });
  });

  it("shows a text-only response as carrying no tool call at all", () => {
    const trace = createProviderStreamTrace(env("1"));
    if (!trace) throw new Error("trace should be enabled");

    trace.record({ type: "response.output_item.added", item: { type: "message" } });
    trace.record({ type: "response.output_text.delta", delta: "现在开始提交。" });
    trace.record({ type: "response.output_item.done", item: { type: "message" } });
    trace.record({ type: "response.completed", response: { status: "completed", output: [{ type: "message" }] } });

    const summary = trace.summary();
    expect(summary.functionCallItems).toBe(0);
    expect(summary.functionCallDones).toBe(0);
    expect(summary.completedOutputToolCalls).toBe(0);
    expect(summary.textChars).toBe(7);
    expect(summary.terminal).toBe("response.completed");
  });

  it("counts Anthropic tool blocks and Chat Completions tool deltas", () => {
    const trace = createProviderStreamTrace(env("1"));
    if (!trace) throw new Error("trace should be enabled");

    trace.record({ type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } });
    trace.record({ choices: [{ delta: { tool_calls: [{ index: 0 }, { index: 1 }] } }] });
    trace.record({ choices: [{ delta: { content: "hello" } }] });

    const summary = trace.summary();
    expect(summary.providerToolMarkers).toBe(3);
    expect(summary.textChars).toBe(5);
    expect(summary.events).toBe(3);
  });

  it("ignores shapes a provider stream never produces", () => {
    const trace = createProviderStreamTrace(env("1"));
    if (!trace) throw new Error("trace should be enabled");

    trace.record(undefined);
    trace.record("string");
    trace.record({ choices: [] });

    expect(trace.summary().events).toBe(0);
  });
});

describe("formatProviderStreamTraceLine", () => {
  it("reports the wire counts next to the assembled message shape", () => {
    const trace = createProviderStreamTrace(env("1"));
    if (!trace) throw new Error("trace should be enabled");
    trace.record({ type: "response.output_text.delta", delta: "一句话" });
    trace.record({ type: "response.completed", response: { status: "completed", output: [] } });

    const line = formatProviderStreamTraceLine({
      sessionId: "session-1",
      turnId: "turn-1",
      providerId: "provider-1",
      modelId: "deepseek-flash",
      stopReason: "stop",
      toolCalls: 0,
      textChars: 3,
      summary: trace.summary(),
    });

    expect(line.startsWith("[provider-stream] ")).toBe(true);
    for (const part of [
      "session=session-1",
      "turn=turn-1",
      "model=deepseek-flash",
      "stop=stop",
      "tool_calls=0",
      "events=2",
      "fn_items=0",
      "terminal=response.completed",
    ]) {
      expect(line).toContain(part);
    }
    // The line never carries message text: only counts and identifiers.
    expect(line).not.toContain("一句话");
  });

  it("marks a request that produced no terminal event", () => {
    const trace = createProviderStreamTrace(env("1"));
    if (!trace) throw new Error("trace should be enabled");

    const line = formatProviderStreamTraceLine({
      sessionId: "session-1",
      turnId: undefined,
      providerId: "provider-1",
      modelId: "deepseek-flash",
      stopReason: undefined,
      toolCalls: 0,
      textChars: 0,
      summary: trace.summary(),
    });

    expect(line).toContain("turn=-");
    expect(line).toContain("terminal=none");
  });
});