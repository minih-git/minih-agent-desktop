/**
 * Direct-chat records and the storage seam under them (ADR
 * mobile-direct-gateway-chat §4).
 *
 * The phone owns its conversations: a versioned database in the app's own WebView
 * store, never `localStorage`, never the computer registry, never host-core
 * SQLite. This file holds the record shapes and the small adapter a repository
 * needs, so the business rules can be tested against an in-memory implementation
 * and the IndexedDB one is the only part that needs a browser.
 *
 * Two rules shape the records themselves:
 *
 * - An AccessKey has no field here. The account is named by its gateway root plus
 *   `access_key_id`; that is what scopes history, and a conversation from another
 *   scope is read-only rather than re-sent under the current key.
 * - A reply attempt is its own record, carrying the model and protocol it ran
 *   with. A conversation can therefore be re-read after a model is gone, with
 *   every earlier reply still labelled by the model that produced it.
 */

/** Which account a record belongs to: the gateway root plus the Router key id. */
export type DirectChatScope = {
  gatewayRoot: string;
  accessKeyId: string;
};

/** The key a `DirectChatScope` is stored under. */
export function scopeKey(scope: DirectChatScope): string {
  return `${scope.gatewayRoot}|${scope.accessKeyId}`;
}

export type DirectChatConversation = {
  /** Local UUID; never a Router or RACP id. */
  id: string;
  scope: DirectChatScope;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  /** What the next send uses, decided while the conversation is idle. */
  nextModelId: string | null;
  nextProtocol: string | null;
  /** Per-conversation draft, so leaving D3 loses nothing typed. */
  draft: string;
};

export type DirectChatMessageRole = "user" | "assistant";

export type DirectChatMessage = {
  id: string;
  conversationId: string;
  /** Monotonic within a conversation, so the transcript has one order. */
  order: number;
  role: DirectChatMessageRole;
  text: string;
  createdAt: string;
  /** The attempt an assistant message belongs to; absent on user messages. */
  attemptId?: string;
  mediaIds?: string[];
};

/**
 * How a reply attempt ended.
 *
 * `pending` and `streaming` are live states; the other four are terminal. A
 * record left live at startup becomes `interrupted`, because the process that
 * owned it is gone and a false "complete" is worse than an honest interruption.
 */
export type DirectChatAttemptState =
  | "pending"
  | "streaming"
  | "complete"
  | "stopped"
  | "interrupted"
  | "failed";

/**
 * Which addendum to the text protocols an attempt is (ADR
 * mobile-experience-completeness D7).
 *
 * The additive field is how an image attempt is told apart from a chat one, so
 * the transcript, the copy, the filters and a retry never have to parse a
 * protocol string.
 */
export type DirectChatOperation = "image-generation";

export type DirectChatAttempt = {
  id: string;
  conversationId: string;
  /** The user message this reply answers; a retry reuses it. */
  userMessageId: string;
  /** The assistant message being filled in; absent until the first text arrives. */
  assistantMessageId: string | null;
  state: DirectChatAttemptState;
  /** The model this attempt ran with, kept even after the model disappears. */
  modelId: string;
  modelLabel: string;
  protocol: string;
  startedAt: string;
  updatedAt: string;
  /** A reason safe to show: never a key, never a request payload. */
  error: string | null;
  /** A failure kind the screen maps to its own next step. */
  errorKind: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  /** The saved media this attempt produced or answered with. */
  mediaIds?: string[];
  /** Absent for a chat turn; present once the attempt is an image request. */
  operation?: DirectChatOperation;
  /** The prompt that was sent, kept because an image has no text to remember. */
  imagePrompt?: string;
};

/** Credential-free, account-scoped draft before first send (ADR D1). */
export type DirectChatDraft = {
  scopeKey: string;
  text: string;
  updatedAt: string;
};

/** Durable media record stored in local storage (ADR D4). */
export type DirectChatMedia = {
  id: string;
  scope: DirectChatScope;
  conversationId: string;
  messageId?: string | null;
  attemptId?: string | null;
  mime: string;
  byteLength: number;
  width?: number | null;
  height?: number | null;
  createdAt: string;
  data: Blob | Uint8Array;
};

/** Everything the transcript of one conversation is made of. */
export type DirectChatTranscript = {
  conversation: DirectChatConversation;
  messages: DirectChatMessage[];
  attempts: DirectChatAttempt[];
  media?: DirectChatMedia[];
};

/**
 * The storage seam.
 *
 * A repository does not know whether it is on IndexedDB or in memory; it names
 * the reads and writes the rules need. `transact` exists because saving a user
 * message and its pending attempt has to be one unit: a half-saved turn would
 * either lose the user's text or invent a reply that was never requested.
 */
export type DirectChatStore = {
  /** Every conversation, in every scope: the caller filters by scope. */
  conversations(): Promise<DirectChatConversation[]>;
  conversation(id: string): Promise<DirectChatConversation | null>;
  messages(conversationId: string): Promise<DirectChatMessage[]>;
  attempts(conversationId: string): Promise<DirectChatAttempt[]>;
  draft(scope: DirectChatScope): Promise<string>;
  media(id: string): Promise<DirectChatMedia | null>;
  mediaForConversation(conversationId: string): Promise<DirectChatMedia[]>;

  /**
   * Run `work` as one unit. Everything it writes commits together or not at
   * all; a caller that gets an error must assume nothing was written.
   */
  transact<T>(work: (tx: DirectChatTransaction) => Promise<T>): Promise<T>;

  /** Which schema version the store reports, for the upgrade path. */
  version(): Promise<number>;
};

/** The writes available inside a transaction. */
export type DirectChatTransaction = {
  putConversation(record: DirectChatConversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  putMessage(record: DirectChatMessage): Promise<void>;
  /** Remove one message, for deleting a single image out of a conversation. */
  deleteMessage(id: string): Promise<void>;
  putAttempt(record: DirectChatAttempt): Promise<void>;
  /** Remove one attempt; a conversation may hold several generations. */
  deleteAttempt(id: string): Promise<void>;
  putDraft(scope: DirectChatScope, text: string, now?: string): Promise<void>;
  clearDraft(scope: DirectChatScope): Promise<void>;
  putMedia(record: DirectChatMedia): Promise<void>;
  deleteMedia(id: string): Promise<void>;
};

/** The schema version this build writes; an upgrade must keep old rows readable. */
export const DIRECT_CHAT_SCHEMA_VERSION = 2;

/** A message that sorts before every other within a conversation. */
export function nextMessageOrder(messages: readonly DirectChatMessage[]): number {
  return messages.reduce((highest, message) => Math.max(highest, message.order), 0) + 1;
}

/** A stable title from the first user message: one line, trimmed, bounded. */
export function titleFromMessage(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
