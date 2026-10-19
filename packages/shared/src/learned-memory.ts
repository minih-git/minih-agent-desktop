/**
 * Learned-memory contracts shared by Electron main and the agent runtime
 * (ADR agent-long-term-memory).
 *
 * The host owns the entries; this module describes only what crosses the
 * launch boundary: the bounded session-start index. Entries are dated notes the
 * user (or an explicit save) produced in an earlier session, so both the prompt
 * section and the recall tools present them as historical context rather than
 * instructions.
 */

/** The four kinds a learned entry may have. */
export const LEARNED_MEMORY_KINDS = [
  "preference",
  "feedback",
  "fact",
  "reference",
] as const;

export type LearnedMemoryKind = (typeof LEARNED_MEMORY_KINDS)[number];

/** A learned entry belongs to one project (or group), or to the user. */
export type LearnedMemoryScopeKind = "project" | "user";

/** One entry of the session-start index, as `memory.index` returns it. */
export type LearnedMemoryIndexEntry = {
  id: string;
  kind: LearnedMemoryKind;
  scopeKind: LearnedMemoryScopeKind;
  content: string;
  rationale?: string;
  /** Epoch milliseconds, formatted for the prompt by the runtime. */
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
};

/**
 * The session-start snapshot: at most 40 entries and 6 KiB, explicit entries
 * first, then by recency of use. The host applies that budget, so the runtime
 * renders what it receives and states how many entries were left out.
 */
export type LearnedMemoryIndex = {
  entries: LearnedMemoryIndexEntry[];
  /** Active entries the host's budget left out; the section states the count. */
  omittedCount: number;
  /** Bytes the returned entries spend in the host's budget. */
  bytes: number;
};

/** Where an entry lives: one project (or project group), or the user. */
export type LearnedMemoryStatus = "suggested" | "active" | "archived";
export type LearnedMemoryOrigin = "explicit" | "user_ui" | "extracted";
export type LearnedMemoryEvidence = "user_stated" | "verified" | "inferred";

/**
 * One stored entry as `memory.list` and `memory.update` return it. `revision`
 * is the compare-and-set token: an edit carries the revision it read, so a
 * background writer can never overwrite a user's edit.
 */
export type LearnedMemoryEntry = {
  id: string;
  scopeKind: LearnedMemoryScopeKind;
  scopeKey?: string;
  kind: LearnedMemoryKind;
  content: string;
  rationale?: string;
  status: LearnedMemoryStatus;
  origin: LearnedMemoryOrigin;
  evidence: LearnedMemoryEvidence;
  sourceSessionId?: string;
  sourceMessageIds: string[];
  fingerprint: string;
  revision: number;
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
};

/** What one manager read asks for: one scope, optionally filtered. */
export type LearnedMemoryListRequest = {
  scope: LearnedMemoryScopeKind;
  /** A project path, or a session whose project identity is used. */
  path?: string;
  sessionId?: string;
  status?: LearnedMemoryStatus;
  kind?: LearnedMemoryKind;
  limit?: number;
  offset?: number;
};

export type LearnedMemoryListResult = {
  entries: LearnedMemoryEntry[];
  scope: { kind: LearnedMemoryScopeKind; key?: string };
};

/** An edit. `content`, `kind`, and `rationale` are the fields it may change. */
export type LearnedMemoryUpdateRequest = {
  id: string;
  revision: number;
  content?: string;
  kind?: LearnedMemoryKind;
  rationale?: string;
};

export type LearnedMemoryUpdateResult = {
  entry: LearnedMemoryEntry;
};

/**
 * Per-session extraction state. `excluded` is the session menu's "don't learn
 * from this conversation"; the cursor and lease fields belong to the optional
 * extractor.
 */
export type LearnedMemorySessionState = {
  sessionId: string;
  scopeKind: LearnedMemoryScopeKind;
  scopeKey?: string;
  cursorSeq: number;
  leaseOwner?: string;
  leaseUntil?: number;
  attempts: number;
  lastError?: string;
  excluded: boolean;
};

/**
 * The transcript receipt's "remember again" request. The renderer names the turn
 * the receipt belongs to and never a message id: the host resolves the cited
 * evidence from that turn's own user messages. This is the only path that clears
 * a delete, and only the user can take it.
 */
export type LearnedMemoryRememberAgainRequest = {
  sessionId: string;
  turnId: string;
  kind: LearnedMemoryKind;
  content: string;
  scope?: LearnedMemoryScopeKind;
  basis?: "user_stated" | "verified";
  rationale?: string;
};

/**
 * A cited user message as the inbox shows it. The host bounds the quote for
 * display; the message itself is untouched.
 */
export type LearnedMemorySuggestionQuote = {
  id: string;
  seq: number;
  createdAt: number;
  text: string;
};

/** One pending suggestion, as the inbox lists it: an entry plus its citations. */
export type LearnedMemorySuggestion = LearnedMemoryEntry & {
  /** The user's own words behind the suggestion, oldest first. */
  quotes: LearnedMemorySuggestionQuote[];
};

/** What one inbox read asks for: one scope, optionally bounded. */
export type LearnedMemorySuggestionListRequest = {
  scope: LearnedMemoryScopeKind;
  path?: string;
  sessionId?: string;
  limit?: number;
};

/**
 * The inbox plus the count the badge shows. `count` is the scope's total, not
 * the page's length, so a bounded read still reports the real backlog.
 */
export type LearnedMemorySuggestionListResult = {
  entries: LearnedMemorySuggestion[];
  count: number;
};

/**
 * Device-local extraction usage for one local day. Settings renders it as
 * "today: used / budget" and pauses the switch when the budget is spent.
 */
export type LearnedMemoryExtractionStatus = {
  day: string;
  tokens: number;
  runs: number;
};
