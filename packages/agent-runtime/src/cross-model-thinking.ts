/**
 * Keep another model's reasoning out of the next provider request.
 *
 * A model switch keeps the transcript, so the first request of the new binding
 * carries turns the previous model produced — thinking blocks included. pi-ai's
 * `transformMessages` does not drop them: it converts every cross-model thinking
 * block into a plain `text` block, so the new model reads the old model's
 * reasoning as if it were its own answer, and the request pays for every token
 * of it on a cache that is cold anyway. The reasoning of a turn that is already
 * finished adds nothing the transcript does not already state (the answer, the
 * tool calls, and their results), so the request projection removes it.
 *
 * Projection only: the persisted transcript, the transcript UI, and the
 * checkpoint keep every thinking block they recorded. The budget estimate reads
 * the same projection, so the switch-compaction floor is not computed on
 * reasoning the request no longer carries.
 *
 * Deliberately dependency-light — the only import is the identity comparison
 * `modelSwitchCompactionDue` already uses, so the switch decision and this
 * projection can never disagree about what "another model" means, and this
 * module can never form a cycle with `runtime.ts`.
 */

import { sameModelIdentity, type ModelBinding } from "./model-switch-compaction.js";

/** The part of a message this projection reads; both runtime and provider rows fit. */
type CrossModelMessage = {
  role: string;
  content?: unknown;
};

function isThinkingBlock(block: unknown): boolean {
  return (
    typeof block === "object" && block !== null && Reflect.get(block, "type") === "thinking"
  );
}

/**
 * The model a row recorded as its producer: the assistant `provider`/`model`
 * pi-ai stamped, which may name either the account row or the vendor key
 * (handled by {@link sameModelIdentity}). Unnamed rows return `undefined` — the
 * transcript recorded no producer, and pi-ai treats them as foreign too.
 */
function producerOf(message: CrossModelMessage): ModelBinding | undefined {
  const provider = Reflect.get(message, "provider");
  const model = Reflect.get(message, "model");
  if (typeof provider !== "string" || typeof model !== "string") return undefined;
  const providerId = provider.trim();
  const modelId = model.trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/**
 * `messages` with cross-model thinking removed from completed turns.
 *
 * A completed turn is every message before the latest user message: the turn
 * the next request continues is still being written by the model that is
 * running it, and its reasoning stays exactly as that model produced it. The
 * caller must apply `alignRetainedReasoningIdentity` first — a replayed
 * retained-reasoning assistant only carries the live identity afterwards, and
 * dropping its thinking would discard reasoning the strict Completions relays
 * require.
 *
 * An assistant whose only content was reasoning is removed rather than emptied:
 * providers reject an assistant with no blocks, pi-ai's Completions adapter
 * drops it anyway, and the transcript builder already discards rows that end up
 * with no content and no tool call — no call/result pair can be stranded,
 * because such a row has no call.
 */
export function projectCrossModelThinking<T extends CrossModelMessage>(
  messages: readonly T[],
  current: ModelBinding,
): T[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  // With no user message nothing is in flight, so every turn is completed.
  const completedBefore = lastUserIndex < 0 ? messages.length : lastUserIndex;
  const projected: T[] = [];
  for (const [index, message] of messages.entries()) {
    if (
      index >= completedBefore ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      projected.push(message);
      continue;
    }
    const producer = producerOf(message);
    if (producer && sameModelIdentity(producer, current)) {
      projected.push(message);
      continue;
    }
    const content = message.content as unknown[];
    const kept = content.filter((block) => !isThinkingBlock(block));
    if (kept.length === content.length) {
      projected.push(message);
      continue;
    }
    if (kept.length === 0) continue;
    projected.push({ ...message, content: kept } as T);
  }
  return projected;
}