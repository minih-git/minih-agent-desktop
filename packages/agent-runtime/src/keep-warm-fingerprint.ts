/**
 * The digest a keep-warm request is allowed to reuse a prompt cache under.
 *
 * The provider's prompt cache is keyed by the bytes of the request prefix:
 * everything the adapter sends before the tokens it is asked to generate —
 * the wire API and endpoint, the model, the system prompt, the tool blocks and
 * the message history. If any of them changed since the real request, the
 * "same" conversation is a different cache entry, and a keep-warm request would
 * pay a full cache write to create it. That is the one outcome this feature
 * must never produce, so both the real request and the warm request compute
 * this digest and the warm request refuses when they differ.
 *
 * The digest covers what the adapter sends, not the objects this runtime keeps:
 * each message is projected to its wire fields, and everything else — usage,
 * api/provider/model tags, timestamps, ids, stop reasons, error text — is
 * dropped because no adapter writes it. That projection is what makes the guard
 * usable: a runtime rebuilt from history fills zeros into a reply's usage and
 * re-tags it, and a digest that noticed would refuse a request that is
 * byte-identical to the one it was supposed to refresh.
 *
 * The system prompt and the tool blocks are messages in this runtime's
 * transcript, so the digest reads them from there like every adapter does.
 *
 */

import { createHash } from "node:crypto";

/** The request fields the provider's cache is keyed by. */
export type KeepWarmPrefixInput = {
  api: string;
  baseUrl?: string;
  providerId?: string;
  modelId?: string;
  messages: readonly unknown[];
};

/** Stable JSON: object keys sorted, so a rebuilt object digests the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/**
 * The message fields the adapters actually write, checked against pi-ai 1.1.0:
 *
 * - `role` — decides which provider role and which block set a message becomes.
 * - `content` — the text/thinking/tool-call/image blocks themselves, signatures
 *   and cache markers included.
 * - `sections` — the system prompt in this runtime: a transcript system message
 *   carries an empty `content` and its prompt in named sections, which
 *   `renderSystemMessageText` (`pi-ai/utils/text`) folds into the prompt string.
 *   Dropping it would leave the digest blind to every prompt change: today's
 *   date in the learned-memory section, a new memory note, a mode switch.
 * - `toolsAdded` / `toolsRemoved` — the tool declarations, applied as transcript
 *   deltas by `utils/transcript` and read by both the Anthropic and the
 *   completions adapters. A dropped MCP server or a disabled plugin changes the
 *   request without changing any message text.
 * - `toolCallId`, `toolName`, `name`, `isError` — how a tool result is matched
 *   to its call and flagged.
 *
 * Everything else is this runtime's bookkeeping: usage counters, api/provider/
 * model tags, ids, timestamps, stop reasons, error text. `responseId` on an
 * assistant message is written by the adapters and read by nobody on replay
 * (the Responses adapter sends no `previous_response_id`), so it stays out; if a
 * future adapter replays by it, it has to be added here.
 */
const WIRE_MESSAGE_FIELDS = [
  "role",
  "content",
  "sections",
  "toolsAdded",
  "toolsRemoved",
  "toolCallId",
  "toolName",
  "name",
  "isError",
] as const;

/** The wire projection of one message, exported so a caller can compare. */
export function keepWarmWireMessage(message: unknown): unknown {
  if (message === null || typeof message !== "object") return message;
  const record = message as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of WIRE_MESSAGE_FIELDS) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

/** The digest of one request prefix, as a lowercase hex SHA-256. */
export function keepWarmPrefixFingerprint(input: KeepWarmPrefixInput): string {
  const digest = createHash("sha256");
  digest.update(
    canonical({
      api: input.api,
      baseUrl: input.baseUrl ?? "",
      providerId: input.providerId ?? "",
      modelId: input.modelId ?? "",
      messages: input.messages.map(keepWarmWireMessage),
    }),
  );
  return digest.digest("hex");
}