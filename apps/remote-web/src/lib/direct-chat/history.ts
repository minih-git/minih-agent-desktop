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
  type DirectChatMedia,
  type DirectChatOperation,
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
  isImage?: boolean;
};

export type DirectChatHistoryStore = DirectChatStore;

export type BeginTurnInput = {
  /** The conversation to send in, or null for "this is a new conversation". */
  conversationId: string | null;
  scope: DirectChatScope;
  text: string;
  /**
   * The saved media this message carries, in the order it was attached. They are
   * recorded with the message and the attempt so a restart, a retry and the next
   * turn's context all send the image that was actually shown in history.
   */
  mediaIds?: string[];
  /**
   * The message is a prompt for an image rather than a chat turn (ADR D7). The
   * attempt records the operation it will run, so the runner can pick the
   * image data plane and the transcript can render its result honestly.
   */
  operation?: DirectChatOperation;
  /** Whether the gateway declared this model for the protocol on the attempt. */
  imageModel?: boolean;

  modelId: string;
  modelLabel: string;
  protocol: string;
  /** A fresh local id from the caller, so a test can name it. */
  now: string;
  newConversationId: string;
  newMessageId: string;
  newAttemptId: string;
};

/** A regenerate: a new attempt answers an already-completed reply's message. */
export type RegenerateInput = {
  /** The successful attempt being asked again; its message is reused. */
  attempt: DirectChatAttempt;
  /** The account this device is connected as; another account is refused. */
  scope: DirectChatScope;
  modelId: string;
  modelLabel: string;
  /** The protocol the new attempt runs: a model change is the caller's decision. */
  protocol: string;
  now: string;
  newAttemptId: string;
};

/**
 * Edit a sent message and send it again.
 *
 * The ids are the caller's, as in `beginTurn`, so a screen can name the
 * conversation it is about to switch to. `newMediaIds` are the media the edited
 * message carries; when it is omitted the message keeps the edited one's own
 * images, which are copied with it.
 */
export type EditAndResendInput = {
  sourceConversationId: string;
  /**
   * The position of the edited message in the transcript's message order. Every
   * message before it that belongs to a completed exchange is copied.
   */
  messageIndex: number;
  newText: string;
  /** The media ids the new message carries, replacing the edited one's own. */
  newMediaIds?: string[];
  newConversationId: string;
  newMessageId: string;
  newAttemptId: string;
  now: string;
  modelId: string;
  modelLabel: string;
  protocol: string;
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
  /**
   * Regenerate a completed reply: a new attempt for the same user message.
   *
   * The previous answer is kept and stays readable; exactly one attempt answers
   * the message in later context (see `buildDirectContext`). Nothing is written
   * when the conversation is not this device's account.
   */
  regenerate(input: RegenerateInput): Promise<{ ok: true; attempt: DirectChatAttempt } | { ok: false; reason: string }>;
  /**
   * Edit a sent message and send it again (ADR D9).
   *
   * This is never an in-place rewrite: a new conversation is created from the
   * completed prefix before the edited message, the edited message and a new
   * pending attempt. The original conversation keeps every later turn, and the
   * media of the copied turns is copied with the new owner so deleting either
   * conversation cannot take the other's images away.
   */
  editAndResend(input: EditAndResendInput): Promise<BeginTurnResult>;

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

  accountDraft(scope: DirectChatScope): Promise<string>;
  setAccountDraft(scope: DirectChatScope, draft: string, now?: string): Promise<void>;
  setDraft(conversationId: string, draft: string): Promise<void>;
  rename(conversationId: string, title: string, now?: string): Promise<void>;
  setPinned(conversationId: string, pinned: boolean, now?: string): Promise<void>;
  /**
   * Archive or restore. A live reply refuses the archive and says why, instead
   * of returning nothing: the sheet and the list both act on this (bug B6).
   */
  setArchived(conversationId: string, archived: boolean, now?: string): Promise<ConversationEditResult>;
  /** The model the next send uses; only allowed while the conversation is idle. */
  setNextModel(conversationId: string, modelId: string, protocol: string, now: string): Promise<void>;
  /** Conversation, messages and attempts together; a live attempt blocks it. */
  remove(conversationId: string): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Delete one generation from a conversation, not the conversation itself.
   *
   * An image conversation can hold several generations (that is how Studio
   * draws them), so "delete this image" must remove exactly that attempt, the
   * prompt and reply it owns, and its media — and then remove the conversation
   * only when nothing else is left in it.
   */
  removeImage(conversationId: string, attemptId: string): Promise<ImageRemovalResult>;

  /**
   * Delete every conversation of one account, or none of them.
   *
   * A half-cleared history is worse than an untouched one - the user is told the
   * account's conversations are gone and some are not - so a live reply in any
   * of them refuses the whole action.
   */
  clearScope(scope: DirectChatScope): Promise<{ ok: true } | { ok: false; reason: "busy" | "storage" }>;
};

/**
 * The outcome of an edit that has a precondition, so a caller can tell "done"
 * from "refused" and name the reason.
 */
export type ConversationEditResult =
  | { ok: true }
  /** A reply is still arriving; the user stops it first. */
  | { ok: false; reason: "busy" }
  /** The record is gone, so there is nothing to edit. */
  | { ok: false; reason: "missing" };

/** What "delete this image" did, so the gallery can say so. */
export type ImageRemovalResult =
  /** Removed the generation; `conversationRemoved` when nothing else was left. */
  | { ok: true; conversationRemoved: boolean }
  /** A reply is still arriving; the user stops it first. */
  | { ok: false; reason: "busy" }
  /** The conversation or the generation is already gone. */
  | { ok: false; reason: "missing" };

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

/**
 * Whether this turn is an image request rather than a chat one (ADR D7).
 *
 * The operation recorded on the attempt is the evidence; the image protocol is
 * the fallback for a record written before the field existed. Never the model's
 * name: Router derives its category partly from names, so a name proves nothing.
 */
export function isImageAttempt(attempt: DirectChatAttempt | null | undefined): boolean {
  if (!attempt) return false;
  return attempt.operation === "image-generation" || attempt.protocol === "openai-images";
}

/**
 * Whether a conversation is an image conversation: one of its attempts is.
 *
 * This is what the Images filter projects (D7), so it lives with the records
 * rather than in a screen: the list and the detail must agree on which
 * conversations are image work.
 */
export function isImageConversation(
  conversation: DirectChatConversation,
  attempts: readonly DirectChatAttempt[],
): boolean {
  return attempts.some(
    (attempt) => attempt.conversationId === conversation.id && isImageAttempt(attempt),
  );
}

/**
 * The attempt last made for one user message, for context and for Regenerate.
 *
 * Later attempts come after earlier ones in the store's own order, so the newest
 * answer is the one a reader sees last and the only one later context carries.
 */
export function latestAttemptFor(
  attempts: readonly DirectChatAttempt[],
  userMessageId: string,
): DirectChatAttempt | null {
  let found: DirectChatAttempt | null = null;
  for (const attempt of attempts) {
    if (attempt.userMessageId === userMessageId) found = attempt;
  }
  return found;
}

/** Every media id a set of messages names, once each, in reading order. */
function mediaIdsOf(messages: readonly DirectChatMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const id of message.mediaIds ?? []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
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
          isImage: isImageConversation(conversation, attempts),
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
      const messages = await store.messages(conversationId);
      const attempts = await attemptsOf(conversationId);
      // The media rows travel with the transcript so a restart shows the picture
      // that was saved with its message, not only its id.
      const media = await store.mediaForConversation(conversationId);
      return { conversation, messages, attempts, ...(media.length > 0 ? { media } : {}) };
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
      const mediaIds =
        input.mediaIds && input.mediaIds.length > 0 ? [...input.mediaIds] : undefined;
      const userMessage: DirectChatMessage = {
        id: input.newMessageId,
        conversationId: conversation.id,
        order: nextMessageOrder(messages),
        role: "user",
        text,
        createdAt: input.now,
        ...(mediaIds ? { mediaIds } : {}),
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
        ...(mediaIds ? { mediaIds } : {}),
        ...(input.operation ? { operation: input.operation } : {}),
        // An image prompt is stored with the attempt: the image has no text of
        // its own, so a regenerate or a copy of this turn must be able to say
        // what was asked.
        ...(input.operation === "image-generation" ? { imagePrompt: text } : {}),
      };

      try {
        await store.transact(async (tx) => {
          await tx.putConversation(conversation);
          await tx.putMessage(userMessage);
          await tx.putAttempt(attempt);
          if (!input.conversationId) {
            await tx.clearDraft(input.scope);
          }
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
      if (!conversation) {
        // The conversation was deleted during streaming; drop write to prevent resurrection.
        return attempt;
      }
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
        await tx.putConversation({ ...conversation, updatedAt: now });
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
      if (!conversation) {
        // The conversation was deleted; drop finish write to prevent resurrecting an orphaned attempt.
        return finished;
      }
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
        await tx.putConversation({ ...conversation, updatedAt: end.now });
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
        // A retry answers the same message again, with the images it carried and
        // the same kind of request: an image attempt is never retried as chat.
        ...(input.attempt.mediaIds ? { mediaIds: [...input.attempt.mediaIds] } : {}),
        ...(input.attempt.operation ? { operation: input.attempt.operation } : {}),
        ...(input.attempt.imagePrompt !== undefined ? { imagePrompt: input.attempt.imagePrompt } : {}),
      };
      await store.transact(async (tx) => {
        await tx.putAttempt(attempt);
        await tx.putConversation({ ...conversation, updatedAt: input.now });
      });
      return { ok: true, attempt };
    },

    async regenerate(input) {
      const conversation = await store.conversation(input.attempt.conversationId);
      if (!conversation) return { ok: false, reason: "conversation-missing" };
      if (scopeKey(conversation.scope) !== scopeKey(input.scope)) {
        return { ok: false, reason: "foreign-scope" };
      }
      const messages = await store.messages(conversation.id);
      // Only a question that was answered can be asked again: regenerating the
      // newest message is what the screen offers, and a message that is missing
      // means the record and the view disagree.
      if (!messages.some((message) => message.id === input.attempt.userMessageId)) {
        return { ok: false, reason: "message-missing" };
      }
      if (!isIdle(await store.attempts(conversation.id))) return { ok: false, reason: "busy" };
      const attempt: DirectChatAttempt = {
        id: input.newAttemptId,
        conversationId: conversation.id,
        // The same user message: one question, a second answer, both kept.
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
        // No mediaIds: the old attempt's list is its *output*. A new attempt
        // starts with no picture of its own, so a regeneration that fails shows
        // nothing rather than the previous answer's image. The user's input
        // attachments are on the message, not on an attempt.
        ...(input.attempt.operation ? { operation: input.attempt.operation } : {}),
        ...(input.attempt.imagePrompt !== undefined ? { imagePrompt: input.attempt.imagePrompt } : {}),
      };
      await store.transact(async (tx) => {
        await tx.putAttempt(attempt);
        await tx.putConversation({ ...conversation, updatedAt: input.now });
      });
      return { ok: true, attempt };
    },

    async editAndResend(input) {
      const text = input.newText.trim();
      if (!text) return { ok: false, reason: "empty-message" };
      const source = await store.conversation(input.sourceConversationId);
      if (!source) return { ok: false, reason: "conversation-missing" };
      if (input.messageIndex < 0) return { ok: false, reason: "message-missing" };
      // Only a completed prefix is content: an unfinished reply stays with the
      // original conversation instead of being copied as if it had finished.
      if (!isIdle(await store.attempts(source.id))) return { ok: false, reason: "busy" };
      const sourceMessages = await store.messages(source.id);
      const sourceAttempts = await store.attempts(source.id);
      const edited = sourceMessages[input.messageIndex];
      if (!edited || edited.role !== "user") return { ok: false, reason: "message-missing" };
      const completed = new Map(
        sourceAttempts.filter((attempt) => attempt.state === "complete").map((attempt) => [attempt.id, attempt]),
      );
      const prefix = sourceMessages.slice(0, input.messageIndex).filter((message) => {
        if (message.role === "user") {
          return sourceAttempts.some(
            (attempt) => attempt.userMessageId === message.id && completed.has(attempt.id),
          );
        }
        return message.attemptId !== undefined && completed.has(message.attemptId);
      });

      const conversation: DirectChatConversation = {
        id: input.newConversationId,
        scope: source.scope,
        // The title comes from the edited text, which is this conversation's
        // first user message: a copy must not read as the original.
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
        order: 1,
        role: "user",
        text,
        createdAt: input.now,
        // The edited message's own images stay with it unless the caller says
        // otherwise; they are copied below like every other copied image.
        ...(input.newMediaIds && input.newMediaIds.length > 0
          ? { mediaIds: [...input.newMediaIds] }
          : edited.mediaIds && edited.mediaIds.length > 0
            ? { mediaIds: [...edited.mediaIds] }
            : {}),
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
        ...(userMessage.mediaIds ? { mediaIds: [...userMessage.mediaIds] } : {}),
      };

      // Every image the copied turns show has to exist under the new owner: a
      // shared id would make deleting either conversation take the other's
      // picture away (D9).
      const known = new Map<string, DirectChatMedia>();
      for (const id of mediaIdsOf([...prefix, userMessage])) {
        const record = await store.media(id);
        if (record) known.set(id, record);
      }
      const mediaPlan = copyMediaPlan(known, [...prefix, userMessage], conversation.id);
      const remap = mediaPlan.remap;

      /** The new id of a copied message or attempt. */
      const copyId = (id: string): string => `${id}-copy-${input.newConversationId}`;
      const copied: DirectChatMessage[] = [];
      const copiedAttempts: DirectChatAttempt[] = [];
      // The prefix keeps the attempt that answered it, under the copy's own id,
      // so a copied reply still carries the model that produced it instead of
      // pointing at a row that lives in the original conversation.
      let order = 0;
      for (const message of prefix) {
        order += 1;
        const sourceAttempt = message.attemptId ? completed.get(message.attemptId) : undefined;
        const mediaIds = remap(message.mediaIds);
        copied.push({
          ...message,
          id: copyId(message.id),
          conversationId: conversation.id,
          order,
          ...(sourceAttempt ? { attemptId: copyId(sourceAttempt.id) } : {}),
          ...(mediaIds ? { mediaIds } : {}),
        });
        if (!sourceAttempt) continue;
        const attemptMediaIds = remap(sourceAttempt.mediaIds);
        copiedAttempts.push({
          ...sourceAttempt,
          id: copyId(sourceAttempt.id),
          conversationId: conversation.id,
          userMessageId: copyId(sourceAttempt.userMessageId),
          assistantMessageId: sourceAttempt.assistantMessageId
            ? copyId(sourceAttempt.assistantMessageId)
            : null,
          ...(attemptMediaIds ? { mediaIds: attemptMediaIds } : {}),
        });
      }
      userMessage.order = order + 1;

      try {
        await store.transact(async (tx) => {
          await tx.putConversation(conversation);
          for (const record of mediaPlan.records) await tx.putMedia(record);
          for (const record of copiedAttempts) await tx.putAttempt(record);
          for (const record of copied) await tx.putMessage(record);
          await tx.putMessage(userMessage);
          await tx.putAttempt(attempt);
        });
      } catch (cause) {
        return {
          ok: false,
          reason: cause instanceof Error ? cause.message : "the conversation could not be saved",
        };
      }
      return { ok: true, conversation, userMessage, attempt };
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

    async accountDraft(scope) {
      return await store.draft(scope);
    },

    async setAccountDraft(scope, draft, now) {
      await store.transact(async (tx) => {
        const trimmed = draft.trim();
        if (trimmed) {
          await tx.putDraft(scope, draft, now ?? new Date().toISOString());
        } else {
          await tx.clearDraft(scope);
        }
      });
    },

    async rename(conversationId, title, now) {
      const conversation = await store.conversation(conversationId);
      const trimmed = title.trim();
      if (!conversation || !trimmed) return;
      await store.transact(async (tx) => {
        await tx.putConversation({ ...conversation, title: trimmed.slice(0, 200), updatedAt: now ?? new Date().toISOString() });
      });
    },

    async setPinned(conversationId, pinned, now) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return;
      await store.transact(async (tx) => {
        await tx.putConversation({ ...conversation, pinned, updatedAt: now ?? new Date().toISOString() });
      });
    },

    async setArchived(conversationId, archived, now) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return { ok: false, reason: "missing" };
      // Archiving a conversation with a live reply would leave a reply growing
      // where the user cannot see it. The refusal is returned rather than
      // dropped, because both callers (the sheet and the list) offer "stop and
      // archive" instead of a button that does nothing (bug B6).
      if (archived && !isIdle(await store.attempts(conversationId))) {
        return { ok: false, reason: "busy" };
      }
      await store.transact(async (tx) => {
        await tx.putConversation({ ...conversation, archived, updatedAt: now ?? new Date().toISOString() });
      });
      return { ok: true };
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

    async removeImage(conversationId, attemptId) {
      const conversation = await store.conversation(conversationId);
      if (!conversation) return { ok: false, reason: "missing" };
      const attempts = await store.attempts(conversationId);
      const target = attempts.find((attempt) => attempt.id === attemptId);
      if (!target) return { ok: false, reason: "missing" };
      // Deleting a generation that is still arriving would report success while
      // the request keeps running and bills the user; stop it first.
      if (target.state === "pending" || target.state === "streaming") {
        return { ok: false, reason: "busy" };
      }

      const remaining = attempts.filter((attempt) => attempt.id !== attemptId);
      if (remaining.length === 0) {
        // Nothing else lives in this conversation, so the record itself goes —
        // which also takes its messages and media with it.
        await store.transact(async (tx) => {
          await tx.deleteConversation(conversationId);
        });
        return { ok: true, conversationRemoved: true };
      }

      // A prompt or reply still referenced by another attempt (a retry shares
      // the prompt) stays; only this generation's own rows are removed.
      const stillReferenced = new Set<string>();
      for (const attempt of remaining) {
        stillReferenced.add(attempt.userMessageId);
        if (attempt.assistantMessageId) stillReferenced.add(attempt.assistantMessageId);
      }
      const orphanIds = new Set(
        [target.userMessageId, target.assistantMessageId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      );
      for (const id of stillReferenced) orphanIds.delete(id);
      for (const attempt of attempts) {
        if (attempt.id === attemptId) continue;
        for (const mediaId of attempt.mediaIds ?? []) orphanIds.delete(mediaId);
      }

      const mediaOfOthers = new Set(
        remaining.flatMap((attempt) => attempt.mediaIds ?? []),
      );
      const mediaToDelete = (target.mediaIds ?? []).filter((id) => !mediaOfOthers.has(id));

      await store.transact(async (tx) => {
        await tx.deleteAttempt(attemptId);
        for (const id of orphanIds) await tx.deleteMessage(id);
        for (const id of mediaToDelete) await tx.deleteMedia(id);
        await tx.putConversation({ ...conversation, updatedAt: new Date().toISOString() });
      });
      return { ok: true, conversationRemoved: false };
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

/**
 * The media records to write for a copy of these messages, and how their ids
 * translate.
 *
 * Edit-and-resend copies a prefix of turns; without copied media the new
 * conversation would point at the original's rows, and deleting either
 * conversation would take the other's pictures with it (ADR D9). A record the
 * store no longer has is skipped rather than invented: an id that could not be
 * loaded is one the reader already cannot see.
 */
function copyMediaPlan(
  known: ReadonlyMap<string, DirectChatMedia>,
  messages: readonly DirectChatMessage[],
  conversationId: string,
): { records: DirectChatMedia[]; remap: (ids: readonly string[] | undefined) => string[] | undefined } {
  const taken = new Map<string, string>();
  const records: DirectChatMedia[] = [];
  for (const id of mediaIdsOf(messages)) {
    const record = known.get(id);
    if (!record) continue;
    const copyId = `${record.id}-copy-${conversationId}`;
    taken.set(id, copyId);
    records.push({
      ...record,
      id: copyId,
      conversationId,
      // The copied row points at the new conversation's own message and
      // attempt, which are named by the caller after this plan is made.
      messageId: record.messageId ? `${record.messageId}-copy-${conversationId}` : record.messageId,
      attemptId: record.attemptId ? `${record.attemptId}-copy-${conversationId}` : record.attemptId,
    });
  }
  return {
    records,
    remap: (ids) => {
      if (!ids || ids.length === 0) return undefined;
      return ids.map((id) => taken.get(id) ?? id);
    },
  };
}

/**
 * Copy one conversation's media into another, for an edit-and-resend.
 *
 * This is the ownership half of D9 on its own: after it, each conversation owns
 * its own rows, so deleting either one leaves the other's pictures intact.
 */
export async function copyDirectMedia(
  store: DirectChatStore,
  from: string,
  to: string,
  now: string,
): Promise<number> {
  const source = await store.conversation(from);
  if (!source) return 0;
  const records = await store.mediaForConversation(from);
  if (records.length === 0) return 0;
  const copies = records.map((record) => ({
    ...record,
    id: `${record.id}-copy-${to}`,
    conversationId: to,
    createdAt: now,
    messageId: record.messageId ? `${record.messageId}-copy-${to}` : record.messageId,
    attemptId: record.attemptId ? `${record.attemptId}-copy-${to}` : record.attemptId,
  }));
  await store.transact(async (tx) => {
    for (const record of copies) await tx.putMedia(record);
  });
  return copies.length;
}
