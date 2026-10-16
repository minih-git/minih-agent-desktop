import type { AgentMessage } from "@earendil-works/pi-agent-core";

type RecordLike = Record<string, unknown>;

const MAX_LOGGED_DUPLICATE_TOOL_CALLS = 8;
const MAX_WIRE_TOOL_CALL_ID_CHARS = 64;

const COMPOSITE_TOOL_CALL_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

export type DuplicateToolCallDrop = {
  messages: AgentMessage[];
  droppedCount: number;
  /** Messages removed whole because every tool call in them was a replay. */
  droppedMessages: number;
  droppedIds: string[];
};

export type DedupeToolCallOptions = {
  /**
   * When set, strips the `|<item_id>` suffix when `targetApi` does not use
   * OpenAI Responses composite item ids (e.g. `openai-completions`), and clamps
   * wire `call_id`s to 64 characters.
   */
  targetApi?: string;
};

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

export function supportsCompositeToolCallIds(api: string | undefined): boolean {
  return typeof api === "string" && COMPOSITE_TOOL_CALL_APIS.has(api);
}

/**
 * The id a provider validates, which is not always the id we store.
 *
 * Minih-Agent-Desktop keeps pi-ai's composite Responses call id (`<call_id>|<item_id>`)
 * so a replay can address the server-side item, and the adapter sends only the
 * part before the separator as `call_id`. Two entries whose composite ids
 * differ in the item half therefore still collide on the wire, so every
 * comparison below uses this wire-visible id (D620).
 */
function wireCallId(id: string): string {
  const separator = id.indexOf("|");
  return separator < 0 ? id : id.slice(0, separator);
}

/**
 * Normalize a persisted or cross-API tool-call id to the wire `call_id` part
 * (`<= 64` chars). Reconstructed `UiMessage` rows never carry OpenAI `rs_*`
 * reasoning items, and non-Responses adapters (`openai-completions`) send
 * `toolCall.id` verbatim when `isSameModel` is true, so keeping the `|fc_*`
 * suffix on restored or non-Responses messages produces 72-character `call_id`s
 * that upstream `/v1/responses` gateways reject with HTTP 400 (max 64).
 */
export function normalizeReplayToolCallId(id: string): string {
  const wire = wireCallId(id);
  return wire.length > MAX_WIRE_TOOL_CALL_ID_CHARS
    ? wire.slice(0, MAX_WIRE_TOOL_CALL_ID_CHARS)
    : wire;
}

/**
 * Keep the first call and result for every tool-call id in a provider request.
 *
 * The transcript can contain repeated snapshots of one call. Returning the
 * original array when nothing changes preserves the common path's identity and
 * avoids copying messages that are already valid.
 *
 * A request that separates a call from its result is not merely untidy: pi-ai
 * closes a call whose result does not follow it with a synthesized
 * "No result provided" output *and* sends the real result, so one call id
 * carries two outputs and the endpoint rejects the whole turn (D608, D620).
 * Dropping a replayed assistant message whole — rather than keeping the text it
 * is left with — is what keeps that separation out of the request, and the
 * duplication the runtime itself produces repeats a message whole, so that is
 * the shape the drop covers. A message that replays one call while carrying a
 * new one keeps its new call where it is, which leaves the replayed call's own
 * result one message later; no writer reaches that partial replay, and the
 * guard leaves it alone rather than reordering what the model sees.
 *
 * Ids are compared by the part the provider validates, so two entries whose
 * item half differs count as one call. That shared id is the only id sharing
 * this guard accepts: a provider that reused one `call_id` for two distinct
 * calls would lose the second call and its result, reported under that id.
 */
export function dedupeToolCallMessages(
  messages: AgentMessage[],
  options?: DedupeToolCallOptions,
): DuplicateToolCallDrop {
  const stripComposite =
    options?.targetApi !== undefined &&
    !supportsCompositeToolCallIds(options.targetApi);
  const keptCalls = new Map<string, string>();
  const keptResults = new Set<string>();
  /** Wire ids whose call is still waiting for a result in this request. */
  const openCalls = new Map<string, number>();
  const droppedIds = new Set<string>();
  let droppedCount = 0;
  let droppedMessages = 0;
  let rewritten = false;
  const note = (id: string) => {
    droppedCount += 1;
    if (droppedIds.size < MAX_LOGGED_DUPLICATE_TOOL_CALLS) {
      droppedIds.add(id);
    }
  };
  const next: AgentMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        next.push(message);
        continue;
      }
      let calls = 0;
      let blockRewritten = false;
      const kept: unknown[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") {
          kept.push(block);
          continue;
        }
        const id = typeof block.id === "string" ? block.id : undefined;
        if (id === undefined) {
          kept.push(block);
          continue;
        }
        calls += 1;
        const wire = normalizeReplayToolCallId(id);
        if (keptCalls.has(wire)) {
          note(wire);
          continue;
        }
        const canonicalId =
          stripComposite || wire !== wireCallId(id) ? wire : id;
        keptCalls.set(wire, canonicalId);
        openCalls.set(wire, (openCalls.get(wire) ?? 0) + 1);
        if (canonicalId !== id) {
          blockRewritten = true;
          rewritten = true;
          kept.push({ ...block, id: canonicalId });
        } else {
          kept.push(block);
        }
      }
      // Every call this message carried was already claimed by an earlier one,
      // so the message is that earlier message's snapshot rather than new
      // context. Its text is a copy too, and keeping the copy would place a
      // message between a call and the result answering it.
      if (
        calls > 0 &&
        kept.every((block) => !isRecord(block) || block.type !== "toolCall")
      ) {
        droppedMessages += 1;
        continue;
      }
      next.push(
        kept.length === content.length && !blockRewritten
          ? message
          : ({ ...message, content: kept } as AgentMessage),
      );
      continue;
    }

    if (message.role === "toolResult") {
      const id = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof id === "string") {
        const wire = normalizeReplayToolCallId(id);
        if (keptResults.has(wire)) {
          note(wire);
          continue;
        }
        keptResults.add(wire);
        const waiting = openCalls.get(wire) ?? 0;
        let targetId =
          stripComposite || wire !== wireCallId(id) ? wire : id;
        if (waiting > 0) {
          openCalls.set(wire, waiting - 1);
          const owner = keptCalls.get(wire);
          // One call id, one result: pi-ai pairs a result to its call by the
          // composite id, so a result whose item half disagrees would leave the
          // call pending and earn a second, synthesized output for this id.
          if (owner !== undefined) {
            targetId = owner;
          }
        }
        if (targetId !== id) {
          rewritten = true;
          next.push({ ...message, toolCallId: targetId } as AgentMessage);
          continue;
        }
      }
    }
    next.push(message);
  }

  return {
    messages: droppedCount === 0 && !rewritten ? messages : next,
    droppedCount,
    droppedMessages,
    droppedIds: [...droppedIds],
  };
}

export function reportDuplicateToolCallDrop(
  sessionId: string,
  drop: DuplicateToolCallDrop,
): void {
  if (drop.droppedCount === 0) return;
  const replayed =
    drop.droppedMessages > 0
      ? ` (${drop.droppedMessages} replayed message${
          drop.droppedMessages === 1 ? "" : "s"
        })`
      : "";
  process.stderr.write(
    `[agent-runtime] dropped ${drop.droppedCount} duplicate tool call ${
      drop.droppedCount === 1 ? "entry" : "entries"
    }${replayed} before the request (session=${sessionId} ids=${drop.droppedIds.join(",")})\n`,
  );
}
