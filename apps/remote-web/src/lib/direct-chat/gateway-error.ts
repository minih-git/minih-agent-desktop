/**
 * The gateway's own refusal, read out of a refusal body.
 *
 * Minih Router answers a refusal with `{"code": "...", "message": "..."}` at the
 * top level (`internal/gateway/reason.go`, `writeReason`); a few control-plane
 * paths answer with the OpenAI shape `{"error": {"code", "message"}}` instead, so
 * both are read here. The status alone cannot tell "this model has no route right
 * now" (503 `no_available_candidate`) from "your key is spent" — and telling the
 * user the wrong one sends them to fix the wrong thing.
 *
 * Pure: a body and an optional secret in, no DOM and no fetch.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function codeOf(value: unknown): string | null {
  const code = text(value).trim();
  return code ? code : null;
}

export type GatewayRefusal = {
  /** The gateway's machine-readable code, when it sent one. */
  code: string | null;
  /** Its message, with the caller's secret removed. Never the key. */
  message: string;
};

/**
 * Read a refusal body.
 *
 * A body that is not JSON is kept as its first 300 characters, which is what the
 * screens have always shown: an unparseable refusal is still the gateway talking.
 * `secret` is the AccessKey, redacted so a gateway that echoes it back cannot leak
 * it into a stored failure or a log line.
 */
export function parseGatewayRefusal(raw: string, secret?: string): GatewayRefusal {
  const redact = (value: string) => (secret ? value.replaceAll(secret, "[redacted]") : value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: null, message: redact(raw.slice(0, 300)) };
  }
  if (!isRecord(parsed)) return { code: null, message: "" };
  const error = isRecord(parsed.error) ? parsed.error : parsed;
  return {
    code: codeOf(error.code) ?? codeOf(parsed.code),
    message: redact(text(error.message)),
  };
}

/** A refusal this client can name, rather than only "the gateway failed". */
export type GatewayRefusalKind = "no-route" | "upstream-busy";

/**
 * The two codes worth their own words.
 *
 * `no_available_candidate` means nothing in the routing table can serve this
 * model right now — another model is the remedy. `upstream_cooldown` means the
 * gateway is deliberately holding requests for it; waiting is. Everything else,
 * including the real quota codes (`access_key_rate_limited`,
 * `access_key_cost_limit_exceeded`), keeps the quota wording it already had.
 */
export function classifyGatewayRefusal(code: string | null): GatewayRefusalKind | null {
  if (code === "no_available_candidate") return "no-route";
  if (code === "upstream_cooldown") return "upstream-busy";
  return null;
}