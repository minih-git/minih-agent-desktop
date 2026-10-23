/**
 * Opt-in diagnostics for "the model announced the next step and the turn
 * ended".
 *
 * The agent loop finishes a turn when the assistant message carries no tool
 * call. On the OpenAI Responses client protocol the assistant message is
 * assembled only from streamed item events, so a tool call that never arrived
 * as `response.output_item.added` / `response.function_call_arguments.done`
 * looks exactly like a model that deliberately answered with one sentence. A
 * gateway that converts a Chat Completions upstream into Responses events can
 * lose that call while still reporting success, which makes the two causes
 * indistinguishable from the transcript alone.
 *
 * This module counts what the provider stream actually carried, so one line in
 * the sidecar log separates the model from the transport. It records event
 * names, item types, and character counts — never message text, tool arguments,
 * or provider payloads — and it only runs when
 * `MINIH_AGENT_TRACE_PROVIDER_STREAM` is set, so the default request path pays
 * nothing for it.
 */

export const PROVIDER_STREAM_TRACE_ENV = "MINIH_AGENT_TRACE_PROVIDER_STREAM";

/** What the raw provider stream carried for one model request. */
export type ProviderStreamTraceSummary = {
  events: number;
  textChars: number;
  toolCallDeltas: number;
  argumentChars: number;
  /** `response.output_item.added` items of type `function_call`. */
  functionCallItems: number;
  /** `response.output_item.done` items of type `function_call`. */
  functionCallDones: number;
  terminal: string | undefined;
  terminalStatus: string | undefined;
  /** Tool calls the terminal event listed in `response.output`. */
  completedOutputToolCalls: number;
  errors: number;
  /**
   * Tool markers from non-Responses protocols (Anthropic `tool_use` blocks,
   * Chat Completions `tool_calls` deltas), so a trace of another wire style is
   * still interpretable.
   */
  providerToolMarkers: number;
};

export type ProviderStreamTrace = {
  record(event: unknown): void;
  summary(): ProviderStreamTraceSummary;
};

/** Everything one line of the trace reports, provider counts plus the result. */
export type ProviderStreamTraceLine = {
  sessionId: string;
  turnId: string | undefined;
  providerId: string;
  modelId: string;
  /** `stopReason` pi stamped on the assembled assistant message. */
  stopReason: string | undefined;
  /** Tool calls the assembled assistant message ended up with. */
  toolCalls: number;
  /** Visible characters the assembled assistant message ended up with. */
  textChars: number;
  summary: ProviderStreamTraceSummary;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

/** Length of a string delta; every other shape counts as nothing. */
function deltaLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function emptySummary(): ProviderStreamTraceSummary {
  return {
    events: 0,
    textChars: 0,
    toolCallDeltas: 0,
    argumentChars: 0,
    functionCallItems: 0,
    functionCallDones: 0,
    terminal: undefined,
    terminalStatus: undefined,
    completedOutputToolCalls: 0,
    errors: 0,
    providerToolMarkers: 0,
  };
}

/** `response.output` of a terminal event, counted by item type. */
function countOutputToolCalls(response: unknown): number {
  if (!isRecord(response)) return 0;
  const output = response.output;
  if (!Array.isArray(output)) return 0;
  return output.filter(item => stringField(item, "type") === "function_call").length;
}

/** A Chat Completions chunk that streams tool calls, counted per call. */
function chatDeltaToolCalls(event: Record<string, unknown>): number {
  const choices = event.choices;
  if (!Array.isArray(choices)) return 0;
  let calls = 0;
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    const toolCalls = choice.delta.tool_calls;
    if (Array.isArray(toolCalls)) calls += toolCalls.length;
  }
  return calls;
}

/** A Chat Completions chunk that streams visible text. */
function chatDeltaText(event: Record<string, unknown>): number {
  const choices = event.choices;
  if (!Array.isArray(choices)) return 0;
  let chars = 0;
  for (const choice of choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    chars += deltaLength(choice.delta.content);
  }
  return chars;
}

export function providerStreamTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PROVIDER_STREAM_TRACE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Undefined unless tracing is enabled, so callers can skip wiring entirely. */
export function createProviderStreamTrace(
  env: NodeJS.ProcessEnv = process.env,
): ProviderStreamTrace | undefined {
  if (!providerStreamTraceEnabled(env)) return undefined;
  const counts = emptySummary();
  return {
    record(event: unknown): void {
      if (!isRecord(event)) return;
      const type = stringField(event, "type");
      if (!type) {
        // Chat Completions chunks carry no `type`: count them by shape so a
        // trace of that wire style still says whether tools were streamed.
        const calls = chatDeltaToolCalls(event);
        const chars = chatDeltaText(event);
        if (calls === 0 && chars === 0) return;
        counts.events += 1;
        counts.providerToolMarkers += calls;
        counts.textChars += chars;
        return;
      }
      counts.events += 1;
      switch (type) {
        case "response.output_item.added":
          if (stringField(event.item, "type") === "function_call") counts.functionCallItems += 1;
          return;
        case "response.output_item.done":
          if (stringField(event.item, "type") === "function_call") counts.functionCallDones += 1;
          return;
        case "response.function_call_arguments.delta":
          counts.toolCallDeltas += 1;
          counts.argumentChars += deltaLength(event.delta);
          return;
        case "response.output_text.delta":
          counts.textChars += deltaLength(event.delta);
          return;
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
          counts.terminal = type;
          counts.terminalStatus = stringField(event.response, "status");
          counts.completedOutputToolCalls += countOutputToolCalls(event.response);
          if (type === "response.failed") counts.errors += 1;
          return;
        case "error":
          counts.errors += 1;
          return;
        case "content_block_start":
          if (stringField(event.content_block, "type") === "tool_use") counts.providerToolMarkers += 1;
          return;
        default:
          // Another wire style's event shape: the count of events is the signal.
          return;
      }
    },
    summary(): ProviderStreamTraceSummary {
      return { ...counts };
    },
  };
}

/**
 * One log line per model request. Everything on it is a count, an event name, or
 * an identifier the message row already has, so the line is safe to keep in a
 * support log.
 */
export function formatProviderStreamTraceLine(line: ProviderStreamTraceLine): string {
  const { summary } = line;
  return [
    "[provider-stream]",
    `session=${line.sessionId}`,
    `turn=${line.turnId ?? "-"}`,
    `provider=${line.providerId}`,
    `model=${line.modelId}`,
    `stop=${line.stopReason ?? "-"}`,
    `tool_calls=${line.toolCalls}`,
    `text_chars=${line.textChars}`,
    "|",
    `events=${summary.events}`,
    `stream_text_chars=${summary.textChars}`,
    `fn_items=${summary.functionCallItems}`,
    `fn_dones=${summary.functionCallDones}`,
    `fn_arg_deltas=${summary.toolCallDeltas}`,
    `fn_arg_chars=${summary.argumentChars}`,
    `terminal=${summary.terminal ?? "none"}`,
    `terminal_status=${summary.terminalStatus ?? "-"}`,
    `terminal_tool_calls=${summary.completedOutputToolCalls}`,
    `provider_tool_markers=${summary.providerToolMarkers}`,
    `errors=${summary.errors}`,
  ].join(" ");
}