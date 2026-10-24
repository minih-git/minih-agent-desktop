/**
 * What a failed turn says on the phone (`turn.failed`, RACP §10).
 *
 * The Host forwards the provider's own error text, which is usually a status
 * code in front of a JSON body:
 *
 * `401: {"message":"Authentication Fails, ...","type":"authentication_error",
 * "request_id":"595f21d0-..."}`
 *
 * Printing that into the timeline buries the one sentence a person can act on
 * under protocol noise and a request id. This keeps the status code and the
 * provider's sentence, and drops the envelope. The sentence itself is data, not
 * UI copy, so it is passed through unchanged rather than rewritten.
 */

export interface TurnFailureDisplay {
  /** The upstream status, when the provider reported one. */
  status?: number;
  /** The sentence to show; the raw text when nothing could be unwrapped. */
  reason: string;
}

/** `401: {...}` — the shape a provider's HTTP error takes once the Host lifts it. */
const STATUS_PREFIX = /^\s*(\d{3})\s*[:：]\s*([\s\S]*)$/;

/** A bracketed or bare `request_id: …`, which identifies the call, not the problem. */
const REQUEST_ID = /\s*[（(]\s*request[_-]?id[^)）]*[)）]|\s*request[_-]?id\s*[:=]\s*[\w.-]+/gi;

function providerMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>).message
      : undefined;
  for (const candidate of [record.message, nested, record.detail]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function tidy(text: string): string {
  return text.replace(REQUEST_ID, "").replace(/\s{2,}/g, " ").trim();
}

export function describeTurnFailure(message: string): TurnFailureDisplay {
  const raw = message.trim();
  if (!raw) return { reason: "" };
  const match = STATUS_PREFIX.exec(raw);
  const body = match ? match[2] : raw;
  const reason = tidy(providerMessage(body) ?? body) || raw;
  return match ? { status: Number(match[1]), reason } : { reason };
}