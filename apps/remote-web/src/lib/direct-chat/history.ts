/**
 * The direct-chat history rules (ADR mobile-direct-gateway-chat §4, §6).
 *
 * One module over the storage seam, so every rule that can lose a user's words is
 * a plain function with a test: what enters history, when a save is atomic, how a
 * stream becomes checkpoints, what a restart does to a live attempt, and what a
 * delete is allowed to touch.
 *
 * The saved-first rule is the reason `beginTurn` exists as one transaction. A
 * conversation enters history with its first user message, and that message and
 * its pending attempt commit together: if the save fails, the caller keeps the
 * draft and sends nothing, because a reply that was never requested is worse than
 * an unsent one.
 */
import {
  nextMessageOrder,
  scopeKey,
  titleFromMessage,
  type DirectChatAttempt,
  type DirectChatStore,
  type DirectChatConversation,
  type DirectChatMessage,
  type DirectChatScope,
  type DirectChatTranscript,
} from "./history-store.js";

/** A conversation as D1 lists it: the row plus what it needs to say about itself. */
export type DirectChatSummary = {
  conversation: DirectChatConversation;
  /** The newest message in it, for the row's preview. */
  preview: string;
  messageCount: number;
  /** The live attempt, when a reply is still being received. */
  liveAttempt: DirectChatAttempt | null;
  /** The last attempt that ended in a way the row must mention. */
  lastFailure: DirectChatAttempt | null;
};

export type DirectChatHistoryStore = DirectChatStore;

export type BeginTurnInput = {
  /** The conversation to send in, or null for "this is a new conversation". */
  conversationId: string | null;
  scope: DirectChatScope;
  text: string;
  modelId: string;
  modelLabel: string;
  protocol: string;
  /** A fresh local id from the caller, so a test can name it. */
  now: string;
  newConversationId: string;
  newMessageId: string;
  newAttemptId: string;
};

export type BeginTurnResult =
  | { ok: true; conversation: DirectChatConversation; userMessage: DirectChatMessage; attempt: DirectChatAttempt }
  | { ok: false; reason: string };

export type DirectChatHistory = {
  /** D1: the current account's conversations, pinned first then by activity. */
  list(scope: DirectChatScope, options?: { archived?: boolean; query?: string }): Promise<DirectChatSummary[]>;
  /** Every scope that has history, so Settings can offer the older ones. */
  scopes(): Promise<DirectChatScope[]>;
  /**
   * The account whose conversation moved last, key or no key: D1 keeps reading
   * an account's history after it is unlinked, so the answer cannot come from
   * the connection.
   */
  lastScope(): Promise<DirectChatScope | null>;
  /** One conversation with its messages and attempts, or null. */
  transcript(conversationId: string): Promise<DirectChatTranscript | null>;

  /**
   * Save the user message and its pending attempt, atomically, before any
   * request is made. A new conversation enters history only here.
   */
  beginTurn(input: BeginTurnInput): Promise<BeginTurnResult>;
  /** Coalesce streamed text into the attempt's assistant message. */
  checkpoint(attempt: DirectChatAttempt, text: string, now: string): Promise<DirectChatAttempt>;
  /** Write the attempt's terminal state, with the text it ended with. */
  finish(
    attempt: DirectChatAttempt,
    end: {
      state: DirectChatAttempt["state"];
      text: string;
      error?: string | null;
      errorKind?: string | null;
      usage?: DirectChatAttempt["usage"];
      now: string;
    },
  ): Promise<DirectChatAttempt>;
  /**
   * A retry is a new attempt for the same user message; nothing is duplicated.
   *
   * It refuses when the conversation belongs to another account: a retry sends
   * a request, and the request carries the connected key, so retrying across
   * accounts would send one account's conversation under another's key.
   */
  retry(
    input: Omit<BeginTurnInput, "text" | "conversationId"> & { attempt: DirectChatAttempt; now: string },
  ): Promise<{ ok: true; attempt: DirectChatAttempt } | { ok: false; reason: string }>;
  /** Startup: any attempt left live belongs to a process that is gone. */
  interruptLive(now: string): Promise<number>;

  setDraft(conversationId: string, draft: string): Promise<void>;
  rename(conversationId: string, title: string, now: string): Promise<void>;
  setPinned(conversationId: string, pinned: boolean, now: string): Promise<void>;
  setArchived(conversationId: string, archived: boolean, now: string): Promise<void>;
  /** The model the next send uses; only allowed while the conversation is idle. */
  setNextModel(conversationId: string, modelId: string, protocol: string, now: string): Promise<void>;
  /** Conversation, messages and attempts together; a live attempt blocks it. */
  remove(conversationId: string): Promise<{ ok: boolean; reason?: string }>;

  /**
   * Delete every conversation of one account, or none of them.
   *
   * A half-cleared history is worse than an untouched one - the user is told the
   * account's conversations are gone and some are not - so a live reply in any
   * of them refuses the whole action.
   */
  clearScope(scope: DirectChatScope): Promise<{ ok: true } | { ok: false; reason: "busy" | "storage" }>;
};

/** A conversation is idle when no attempt is pending or streaming. */
export function isIdle(attempts: readonly DirectChatAttempt[]): boolean {
  return !attempts.some((attempt) => attempt.state === "pending" || attempt.state === "streaming");
}

/** The attempt whose reply is still arriving, if any. */
export function liveAttemptOf(attempts: readonly DirectChatAttempt[]): DirectChatAttempt | null {
  return (
    attempts.find((attempt) => attempt.state === "streaming") ??
    attempts.find((attempt) => attempt.state === "pending") ??
    null
  );
}

export function createDirectChatHistory(store: DirectChatStore): DirectChatHistory {
  /** Group a conversation's attempts, fetched once for a list. */
  async function attemptsOf(conversationId: string): Promise<DirectChatAttempt[]> {
    return store.attempts(conversationId);
  }

  return {
    async list(scope, options = {}) {
      const wanted = scopeKey(scope);
      const archived = options.archived === true;
      const conversations = (await store.conversations()).filter(
        (conversation) =>
          scopeKey(conversation.scope) === wanted && conversation.archived === archived,
      );
      const summaries: Array<DirectChatSummary & { searchable: string }> = [];
      for (const conversation of conversations) {
        const messages = await store.messages(conversation.id);
        const attempts = await attemptsOf(conversation.id);
        summaries.push({
          conversation,
          preview: messages.length > 0 ? messages[messages.length - 1]!.text : "",
          messageCount: messages.length,
          liveAttempt: liveAttemptOf(attempts),
          lastFailure: lastAttemptFailure(attempts),
          // The search reads every saved message, not only the newest: a user
          // remembers something said earlier far more often than the last line.
          searchable: messages.map((message) => message.text).join("\n").toLowerCase(),
        });
      }
      const needle = options.query?.trim().toLowerCase() ?? "";
      const filtered = needle
        ? summaries.filter(
            (summary) =>
              summary.conversation.title.toLowerCase().includes(needle) ||
              summary.searchable.includes(needle),
          )
        : summaries;
      // Pinned first, then most recently active: the ADR's one ordering.
      return filtered
        .map(({ searchable: _searchable, ...summary }) => summary)
        .sort((a, b) => {
          if (a.conversation.pinned !== b.conversation.pinned) return a.conversation.pinned ? -1 : 1;
          return b.conversation.updatedAt.localeCompare(a.conversation.updatedAt);
        });
    },

    async scopes() {
      const seen = new Map<string, DirectChatScope>();
      for (const conversation of await store.conversations()) {
        seen.set(scopeKey(conversation.scope), conversation.scope);
      }
      return [...seen.values()];
    },

    async lastScope() {
      const conversations = await store.conversations();
      const newest = conversations
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      return newest?.scope ?? null;
    },

    async transcript(conversationId) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return null;
      return {
        conversation,
        messages: await store.messages(conversationId),
        attempts: await attemptsOf(conversationId),
      };
    },

    async beginTurn(input) {
      const text = input.text.trim();
      if (!text) return { ok: false, reason: "empty-message" };

      const existing = input.conversationId ? await store.conversation(input.conversationId) : null;
      if (input.conversationId && !existing) return { ok: false, reason: "conversation-missing" };
      if (existing && scopeKey(existing.scope) !== scopeKey(input.scope)) {
        // Another account's conversation is read-only: it must never be sent
        // under the current key (§4).
        return { ok: false, reason: "foreign-scope" };
      }
      if (existing && existing.archived) return { ok: false, reason: "archived" };
      if (existing && !isIdle(await attemptsOf(existing.id))) {
        return { ok: false, reason: "busy" };
      }

      const messages = existing ? await store.messages(existing.id) : [];
      const conversation: DirectChatConversation = existing
        ? { ...existing, updatedAt: input.now, draft: "" }
        : {
            id: input.newConversationId,
            scope: input.scope,
            // The title comes from the first user message, never from a model.
            title: titleFromMessage(text),
            createdAt: input.now,
            updatedAt: input.now,
            pinned: false,
            archived: false,
            nextModelId: input.modelId,
            nextProtocol: input.protocol,
            draft: "",
          };
      const userMessage: DirectChatMessage = {
        id: input.newMessageId,
        conversationId: conversation.id,
        order: nextMessageOrder(messages),
        role: "user",
        text,
        createdAt: input.now,
      };
      const attempt: DirectChatAttempt = {
        id: input.newAttemptId,
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: null,
        state: "pending",
        modelId: input.modelId,
        modelLabel: input.modelLabel,
        protocol: input.protocol,
        startedAt: input.now,
        updatedAt: input.now,
        error: null,
        errorKind: null,
        usage: null,
      };

      try {
        await store.transact(async (tx) => {
          await tx.putConversation(conversation);
          await tx.putMessage(userMessage);
          await tx.putAttempt(attempt);
        });
      } catch (cause) {
        // The caller keeps the draft and sends nothing: nothing was written.
        return {
          ok: false,
          reason: cause instanceof Error ? cause.message : "the conversation could not be saved",
        };
      }
      return { ok: true, conversation, userMessage, attempt };
    },

    async checkpoint(attempt, text, now) {
      // The first text creates the assistant message; later checkpoints replace
      // its text, so a stream of deltas becomes one row rather than hundreds.
      const messageId = attempt.assistantMessageId ?? `${attempt.id}-assistant`;
      const messages = await store.messages(attempt.conversationId);
      const order =
        messages.find((message) => message.id === messageId)?.order ??
        nextMessageOrder(messages);
      const updated: DirectChatAttempt = {
        ...attempt,
        assistantMessageId: messageId,
        state: "streaming",
        updatedAt: now,
      };
      const conversation = await store.conversation(attempt.conversationId);
      await store.transact(async (tx) => {
        await tx.putAttempt(updated);
        await tx.putMessage({
          id: messageId,
          conversationId: attempt.conversationId,
          order,
          role: "assistant",
          text,
          createdAt: now,
          attemptId: attempt.id,
        });
        if (conversation) await tx.putConversation({ ...conversation, updatedAt: now });
      });
      return updated;
    },

    async finish(attempt, end) {
      const finished: DirectChatAttempt = {
        ...attempt,
        state: end.state,
        updatedAt: end.now,
        error: end.error ?? null,
        errorKind: end.errorKind ?? null,
        usage: end.usage ?? attempt.usage,
        assistantMessageId: attempt.assistantMessageId ?? (end.text ? `${attempt.id}-assistant` : null),
      };
      const conversation = await store.conversation(attempt.conversationId);
      const messages = await store.messages(attempt.conversationId);
      await store.transact(async (tx) => {
        await tx.putAttempt(finished);
        if (finished.assistantMessageId && end.text) {
          const order =
            messages.find((message) => message.id === finished.assistantMessageId)?.order ??
            nextMessageOrder(messages);
          await tx.putMessage({
            id: finished.assistantMessageId,
            conversationId: attempt.conversationId,
            order,
            role: "assistant",
            text: end.text,
            createdAt: end.now,
            attemptId: attempt.id,
          });
        }
        if (conversation) await tx.putConversation({ ...conversation, updatedAt: end.now });
      });
      return finished;
    },

    async retry(input) {
      const conversation = await store.conversation(input.attempt.conversationId);
      if (!conversation) return { ok: false, reason: "conversation-missing" };
      if (scopeKey(conversation.scope) !== scopeKey(input.scope)) {
        return { ok: false, reason: "foreign-scope" };
      }
      const attempt: DirectChatAttempt = {
        id: input.newAttemptId,
        conversationId: input.attempt.conversationId,
        // The same user message: a retry answers it again, it does not repeat it.
        userMessageId: input.attempt.userMessageId,
        assistantMessageId: null,
        state: "pending",
        modelId: input.modelId,
        modelLabel: input.modelLabel,
        protocol: input.protocol,
        startedAt: input.now,
        updatedAt: input.now,
        error: null,
        errorKind: null,
        usage: null,
      };
      await store.transact(async (tx) => {
        await tx.putAttempt(attempt);
        await tx.putConversation({ ...conversation, updatedAt: input.now });
      });
      return { ok: true, attempt };
    },

    async interruptLive(now) {
      const conversations = await store.conversations();
      let count = 0;
      for (const conversation of conversations) {
        for (const attempt of await store.attempts(conversation.id)) {
          if (attempt.state !== "pending" && attempt.state !== "streaming") continue;
          // A reply whose process died is interrupted, never completed: the
          // alternative is showing a finished answer that never finished.
          await store.transact(async (tx) => {
            await tx.putAttempt({
              ...attempt,
              state: "interrupted",
              updatedAt: now,
              errorKind: "interrupted",
            });
          });
          count += 1;
        }
      }
      return count;
    },

    async setDraft(conversationId, draft) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return;
      await store.transact(async (tx) => {
        await tx.putConversation({ ...conversation, draft });
      });
    },

    async rename(conversationId, title, now) {
      const conversation = await store.conversation(conversationId);
      const trimmed = title.trim();
      if (!conversation || !trimmed) return;
      await store.transact(async (tx) => {
        await tx.putConversation({ ...conversation, title: trimmed.slice(0, 200), updatedAt: now });
      });
    },

    async setPinned(conversationId, pinned, now) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return;
      await store.transact(async (tx) => {
        await tx.putConversation({ ...conversation, pinned, updatedAt: now });
      });
    },

    async setArchived(conversationId, archived, now) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return;
      // Archiving a conversation with a live reply would leave a reply growing
      // where the user cannot see it; the caller stops first.
      if (archived && !isIdle(await store.attempts(conversationId))) return;
      await store.transact(async (tx) => {
        await tx.putConversation({ ...conversation, archived, updatedAt: now });
      });
    },

    async setNextModel(conversationId, modelId, protocol, now) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return;
      // Changing the model mid-reply would make the label a lie; it applies to
      // the next send and only while idle.
      if (!isIdle(await store.attempts(conversationId))) return;
      await store.transact(async (tx) => {
        await tx.putConversation({
          ...conversation,
          nextModelId: modelId,
          nextProtocol: protocol,
          updatedAt: now,
        });
      });
    },

    async clearScope(scope) {
      const wanted = scopeKey(scope);
      const conversations = (await store.conversations()).filter(
        (conversation) => scopeKey(conversation.scope) === wanted,
      );
      for (const conversation of conversations) {
        if (!isIdle(await store.attempts(conversation.id))) return { ok: false, reason: "busy" };
      }
      try {
        await store.transact(async (tx) => {
          for (const conversation of conversations) await tx.deleteConversation(conversation.id);
        });
      } catch {
        // The store rolled the transaction back; saying "storage" is honest.
        return { ok: false, reason: "storage" };
      }
      return { ok: true };
    },

    async remove(conversationId) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return { ok: false, reason: "conversation-missing" };
      if (!isIdle(await store.attempts(conversationId))) {
        // Deleting under a live stream would report success while text is still
        // arriving; the user stops the reply first.
        return { ok: false, reason: "busy" };
      }
      await store.transact(async (tx) => {
        await tx.deleteConversation(conversationId);
      });
      return { ok: true };
    },
  };
}

/** The most recent attempt that ended in a state the list must mention. */
function lastAttemptFailure(attempts: readonly DirectChatAttempt[]): DirectChatAttempt | null {
  const failing = attempts
    .filter((attempt) => attempt.state === "failed" || attempt.state === "interrupted" || attempt.state === "stopped")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return failing[0] ?? null;
}
