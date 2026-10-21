/**
 * The direct-chat data plane (ADR mobile-direct-gateway-chat §2, §3).
 *
 * One request per reply, streamed from the model gateway's `/v1` with the
 * WebView's own `fetch`, a `ReadableStream` reader, and an `AbortController`.
 * The two supported protocols answer with different envelopes — Chat Completions
 * and Responses — and this module is where that difference stops: both are
 * decoded into the same small set of events, so a screen never has to know which
 * protocol a model speaks.
 *
 * Rules the ADR fixes and this file keeps:
 *
 * - Context is the completed user/assistant exchanges plus the new user message.
 *   Partial, failed and stopped replies are not context, and no provider-side
 *   conversation id or `previous_response_id` is used: the phone owns the
 *   transcript.
 * - The protocol is the one the caller resolved from the catalog. There is no
 *   retry on another protocol, because a silent second attempt would bill a model
 *   the user did not choose.
 * - Abort is a first-class outcome: the reader stops, the request is cancelled,
 *   and what already arrived stays with the caller.
 */
import type { MinihRouterModel } from "@minih-agent/shared";

import type { DirectProtocol } from "./catalog.js";
import { SseDecoder } from "./sse.js";

/** One finished exchange, as the request context carries it. */
export type DirectTurn = { role: "user" | "assistant"; text: string };

export type DirectRequestInput = {
  model: MinihRouterModel;
  protocol: DirectProtocol;
  /** Completed exchanges, oldest first. */
  history: readonly DirectTurn[];
  /** The message the user just sent. */
  message: string;
};

/**
 * The data-plane input, with the key kept apart from the conversation so it
 * cannot be logged, cached or rendered along with it.
 */
export type AuthorizedDirectRequest = DirectRequestInput & { authKey: string };

/** What a reply stream reports, in the order it reports it. */
export type DirectStreamEvent =
  /** A piece of the reply's text. */
  | { type: "text"; text: string }
  /** The reply finished; nothing more arrives. */
  | { type: "done"; reason: "complete" | "length" | "content-filter" }
  /** Token accounting, when the gateway reported it. */
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null }
  /** The stream failed after it started. */
  | { type: "error"; message: string };

export type DirectStreamResult =
  | { ok: true; text: string; usage: { inputTokens: number | null; outputTokens: number | null } | null; stopped: boolean }
  | { ok: false; failure: { kind: "unauthorized" | "quota" | "network-range" | "transport" | "gateway"; message: string; status?: number } };

export type DirectStreamOptions = {
  /** The model gateway origin; `null` means this build has none. */
  origin: string | null;
  /** Injected for tests; defaults to the WebView's `fetch`. */
  fetchImpl?: typeof fetch;
  /** Called for each event as it is decoded, so a screen can paint mid-stream. */
  onEvent?: (event: DirectStreamEvent) => void;
};

const STREAM_TIMEOUT_MS = 120_000;

/** The path each protocol streams from. */
export function streamPath(protocol: DirectProtocol): string {
  return protocol === "openai-responses" ? "/v1/responses" : "/v1/chat/completions";
}

/** The request body each protocol expects for the same conversation. */
export function streamBody(input: DirectRequestInput): Record<string, unknown> {
  if (input.protocol === "openai-responses") {
    // The Responses envelope takes the whole conversation as `input` items and
    // never a `previous_response_id`: history is ours to assemble.
    return {
      model: input.model.id,
      stream: true,
      input: [
        ...input.history.map((turn) => ({
          role: turn.role,
          content: [{ type: turn.role === "assistant" ? "output_text" : "input_text", text: turn.text }],
        })),
        { role: "user", content: [{ type: "input_text", text: input.message }] },
      ],
    };
  }
  return {
    model: input.model.id,
    stream: true,
    messages: [
      ...input.history.map((turn) => ({ role: turn.role, content: turn.text })),
      { role: "user", content: input.message },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One decoded SSE payload, as unified events.
 *
 * `terminal` says whether the reply is finished, which is not the same as "a
 * `done` event was produced": Chat Completions reports `finish_reason` first and
 * its usage after, so cancelling on `finish_reason` would lose the accounting.
 * Only the sentinel (`[DONE]`) or a terminal Responses event ends the stream.
 */
export type DecodedStreamEvent = { events: DirectStreamEvent[]; terminal: boolean };

/** One decoded SSE payload, as the unified events. */
export function decodeStreamEvent(
  protocol: DirectProtocol,
  event: { event: string; data: string },
): DecodedStreamEvent {
  const raw = event.data.trim();
  if (!raw) return { events: [], terminal: false };
  // Chat Completions ends with a sentinel instead of a terminal event.
  if (raw === "[DONE]") return { events: [{ type: "done", reason: "complete" }], terminal: true };

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return { events: [{ type: "error", message: "the model gateway sent an unreadable stream event" }], terminal: true };
  }
  if (!isRecord(payload)) return { events: [], terminal: false };

  // Both protocols report a failure as an `error` object on the stream.
  const error = isRecord(payload.error) ? payload.error : null;
  if (error) {
    return {
      events: [{ type: "error", message: text(error.message).trim() || "the model gateway reported an error" }],
      terminal: true,
    };
  }
  if (event.event === "error") {
    return {
      events: [{ type: "error", message: text(payload.message).trim() || "the model gateway reported an error" }],
      terminal: true,
    };
  }

  if (protocol === "openai-responses") {
    const type = text(payload.type) || event.event;
    return {
      events: responsesEvent(payload, event.event),
      terminal: type === "response.completed" || type === "response.incomplete" || type === "response.failed",
    };
  }
  return { events: completionsEvent(payload), terminal: false };
}

function completionsEvent(payload: Record<string, unknown>): DirectStreamEvent[] {
  const events: DirectStreamEvent[] = [];
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    const piece = text(delta.content);
    if (piece) events.push({ type: "text", text: piece });
    const finish = text(choice.finish_reason);
    if (finish) events.push({ type: "done", reason: finishReason(finish) });
  }
  const usage = isRecord(payload.usage) ? payload.usage : null;
  if (usage) {
    events.push({
      type: "usage",
      inputTokens: integer(usage.prompt_tokens),
      outputTokens: integer(usage.completion_tokens),
    });
  }
  return events;
}

function responsesEvent(payload: Record<string, unknown>, eventName: string): DirectStreamEvent[] {
  const events: DirectStreamEvent[] = [];
  const type = text(payload.type) || eventName;
  switch (type) {
    case "response.output_text.delta": {
      const piece = text(payload.delta);
      if (piece) events.push({ type: "text", text: piece });
      break;
    }
    case "response.completed":
    case "response.incomplete": {
      const response = isRecord(payload.response) ? payload.response : payload;
      const usage = isRecord(response.usage) ? response.usage : null;
      if (usage) {
        events.push({
          type: "usage",
          inputTokens: integer(usage.input_tokens),
          outputTokens: integer(usage.output_tokens),
        });
      }
      events.push({
        type: "done",
        reason: type === "response.incomplete" ? incompleteReason(response) : "complete",
      });
      break;
    }
    case "response.failed": {
      const response = isRecord(payload.response) ? payload.response : {};
      const error = isRecord(response.error) ? response.error : {};
      events.push({
        type: "error",
        message: text(error.message).trim() || "the model gateway reported a failed response",
      });
      break;
    }
    default:
      // Other lifecycle events carry no text and no decision this client needs.
      break;
  }
  return events;
}

function finishReason(raw: string): "complete" | "length" | "content-filter" {
  if (raw === "length" || raw === "max_tokens") return "length";
  if (raw === "content_filter") return "content-filter";
  return "complete";
}

function incompleteReason(response: Record<string, unknown>): "length" | "content-filter" {
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
  return text(details.reason) === "content_filter" ? "content-filter" : "length";
}

/** The failure kinds the data plane distinguishes, from an HTTP status. */
function streamFailure(status: number, message: string) {
  const detail = message.trim();
  const suffix = detail ? `: ${detail.slice(0, 300)}` : "";
  if (status === 429 || status === 402) {
    return { kind: "quota" as const, message: `the model gateway refused this request (${status})${suffix}`, status };
  }
  if (status === 401 || status === 403) {
    const range = /allowed_peer_cidrs|peer_cidr|source ip|client ip|\bcidr\b|network range/i.test(detail);
    return {
      kind: range ? ("network-range" as const) : ("unauthorized" as const),
      message: `the model gateway rejected this request (${status})${suffix}`,
      status,
    };
  }
  return { kind: "gateway" as const, message: `the model gateway failed (${status})${suffix}`, status };
}

/**
 * Run one streamed reply.
 *
 * The returned text is what arrived, whatever the outcome: a caller that sees
 * `stopped` or a failure keeps the partial reply visible and labelled rather
 * than losing it.
 */
export async function streamDirectReply(
  input: AuthorizedDirectRequest,
  options: DirectStreamOptions,
  signal?: AbortSignal,
): Promise<DirectStreamResult> {
  const origin = options.origin;
  if (!origin) {
    return { ok: false, failure: { kind: "gateway", message: "this build has no model gateway configured" } };
  }
  const url = `${origin}${streamPath(input.protocol)}`;
  try {
    if (new URL(url).origin !== origin) {
      return { ok: false, failure: { kind: "gateway", message: "a data-plane request left the configured origin" } };
    }
  } catch {
    return { ok: false, failure: { kind: "gateway", message: "the model gateway origin is unusable" } };
  }

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  // The key is read by the caller and passed in the header only; it never enters
  // a URL, an event, or an error message.
  const key = input.authKey.trim();
  if (!key) return { ok: false, failure: { kind: "unauthorized", message: "no AccessKey is configured" } };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let accumulated = "";
  let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
  const emit = (event: DirectStreamEvent) => {
    if (event.type === "text") accumulated += event.text;
    if (event.type === "usage") usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    options.onEvent?.(event);
  };

  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(streamBody(input)),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      // A refusal is JSON, not a stream: read the reason without echoing the key.
      const raw = await response.text().catch(() => "");
      let message = "";
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (isRecord(parsed)) {
          const error = isRecord(parsed.error) ? parsed.error : parsed;
          message = text(error.message);
        }
      } catch {
        message = raw.slice(0, 300);
      }
      return { ok: false, failure: streamFailure(response.status, message.replaceAll(key, "[redacted]")) };
    }

    const reader = response.body.getReader();
    const decoder = new SseDecoder();
    let failed: string | null = null;
    let finished = false;

    /**
     * Turn one decoded event into output. Returning the failure instead of
     * assigning it from inside the loop keeps the reader loop's own state in one
     * place: a closure that mutates it is invisible to the type narrowing.
     */
    const applyEvent = (event: { event: string; data: string }): { error: string | null; done: boolean } => {
      const decoded = decodeStreamEvent(input.protocol, event);
      for (const piece of decoded.events) {
        if (piece.type === "error") return { error: piece.message, done: false };
        emit(piece);
      }
      return { error: null, done: decoded.terminal };
    };

    for (;;) {
      const chunk = await reader.read();
      const events = chunk.done ? decoder.end() : decoder.push(chunk.value);
      for (const event of events) {
        const outcome = applyEvent(event);
        if (outcome.error) {
          failed = outcome.error;
          break;
        }
        if (outcome.done) finished = true;
      }
      if (chunk.done) break;
      if (failed || finished) {
        // Nothing more is wanted: release the connection instead of reading a
        // stream whose answer can no longer change anything.
        await reader.cancel().catch(() => {});
        break;
      }
    }

    if (failed) {
      return {
        ok: false,
        failure: { kind: "gateway", message: failed.replaceAll(key, "[redacted]") },
      };
    }
    return { ok: true, text: accumulated, usage, stopped: controller.signal.aborted && !finished };
  } catch (cause) {
    if (controller.signal.aborted) {
      // A stop, or the stream timeout: what arrived is still the reply so far.
      return { ok: true, text: accumulated, usage, stopped: true };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      failure: { kind: "transport", message: `the model gateway could not be reached: ${message.replaceAll(key, "[redacted]").slice(0, 300)}` },
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
