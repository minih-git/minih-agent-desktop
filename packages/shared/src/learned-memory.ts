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

/**
 * Where a learned entry lives: one project (or project group), the user, or one
 * employee — its lessons from tasks it already finished (0.5 slice 5).
 */
export type LearnedMemoryScopeKind = "project" | "user" | "bot";

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
  /**
   * Ids of every entry the snapshot carries, `entries` then `lessons`. The
   * runtime keeps them so a per-turn recall never repeats a note the system
   * prompt already holds (ADR learned-memory-recall §2).
   */
  ids: string[];
  /**
   * The employee's lessons from its earlier tasks, when this session is one of
   * that employee's tasks (0.5 slice 5). They spend their own budget and are
   * rendered as their own section: they are what the employee learned, not what
   * the person said, and the section says so before listing one.
   */
  lessons?: LearnedMemoryIndexEntry[];
  /** Lessons the host's smaller lesson budget left out. */
  omittedLessons?: number;
};

/**
 * One entry of a per-turn recall, as `memory.recall` returns it (ADR
 * learned-memory-recall §2). It is a read-only view: the block it renders into
 * is attached to the wire copy of the newest user message and never stored.
 */
export type LearnedMemoryRecallEntry = {
  id: string;
  kind: LearnedMemoryKind;
  scopeKind: LearnedMemoryScopeKind;
  content: string;
  rationale?: string;
  /** Epoch milliseconds, formatted for the block by the runtime. */
  createdAt: number;
  updatedAt: number;
  /** The query words this entry matched; the host ranks by their count. */
  matchedTerms: string[];
};

/** What one `memory.recall` call returns. */
export type LearnedMemoryRecallResult = {
  query: string;
  entries: LearnedMemoryRecallEntry[];
};

/** Where an entry sits in its lifecycle: proposed, active, or archived. */
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

/**
 * One employee lesson, as the host's `task.experience.list` RPC returns it
 * (employee mode 0.5 slice 5). The renderer channel of that name is gone (ADR
 * 0341) but the RPC and this shape are the plugin-facing contract. The entry is
 * an ordinary learned-memory row in the employee's `bot` scope; the extra fields
 * name the task it was learned from, so a lesson can be opened in its context
 * and deleted with the knowledge of where it came from.
 */
export type EmployeeLesson = LearnedMemoryEntry & {
  sourceTaskId?: string;
  sourceTaskShortId?: string;
  sourceTaskTitle?: string;
  /** When that task was archived, if it has been. */
  sourceTaskArchivedAt?: string;
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

/**
 * Device-local counters the memory manager shows (plan §1).
 *
 * They describe this machine's own usage — the index the last launch captured,
 * the suggestions reviewed here, the writes a delete blocked, and today's
 * extraction spend. None of it travels with configuration sync, so two devices
 * that only read their notes never diverge over a number.
 */
export type LearnedMemoryLocalStats = {
  index: {
    /** Active entries the last session start captured. */
    entries: number;
    /** Bytes those entries spent of the index budget. */
    bytes: number;
    /** Active entries the budget left out. */
    omitted: number;
    /** When that capture happened, or null before the first session start. */
    capturedAt: number | null;
  };
  suggestions: {
    accepted: number;
    rejected: number;
  };
  tombstones: {
    /** Writes the extractor attempted that a delete blocked. */
    fromExtraction: number;
    /** Writes the user or the agent attempted that a delete blocked. */
    fromCreate: number;
  };
  /** The extraction ledger as last written, keyed by the local day. */
  extraction: LearnedMemoryExtractionStatus;
};

/**
 * Automatic curation (ADR learned-memory-consolidation).
 *
 * A pass reads one scope's notes, proposes at most a handful of cleanups, and
 * the host applies them — with a cap, a revision check, and a record. This
 * module describes the wire shapes and the labels; the rules are the host's.
 */

/** What one automatic change did to a note. */
export type LearnedMemoryCurationOp =
  | "activate"
  | "merge_new"
  | "merge_archive"
  | "replace_archive"
  | "reword";

/** The fields of a note an automatic pass can move. */
export type LearnedMemoryRevisionSnapshot = {
  content: string;
  status: LearnedMemoryStatus;
  supersededBy?: string;
  revision: number;
};

/** One row of the audit trail, as the manager's "recently curated" list shows it. */
export type LearnedMemoryRevision = {
  id: number;
  /** One pass is one batch; an undo applies to the whole batch. */
  batchId: string;
  entryId: string;
  op: LearnedMemoryCurationOp;
  actor: "auto";
  /** Absent for an activation: there was nothing before it. */
  before?: LearnedMemoryRevisionSnapshot;
  after: LearnedMemoryRevisionSnapshot;
  reason?: string;
  createdAt: number;
  undoneAt?: number;
};

/** What `memory.curation.list` returns for one scope. */
export type LearnedMemoryCurationListResult = {
  records: LearnedMemoryRevision[];
  /** Automatic changes in the window, so the summary line needs no count. */
  changes: number;
  days: number;
};

/** What one pass may read. */
export type LearnedMemoryCurationInputEntry = {
  id: string;
  kind: LearnedMemoryKind;
  origin: LearnedMemoryOrigin;
  evidence: LearnedMemoryEvidence;
  content: string;
  rationale?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  /** False for a note the user wrote or just edited: a pass may not rewrite it. */
  rewordable: boolean;
  userEdited: boolean;
};

export type LearnedMemoryCurationInput = {
  scopeKind: LearnedMemoryScopeKind;
  scopeKey?: string;
  changed: LearnedMemoryCurationInputEntry[];
  neighbours: LearnedMemoryCurationInputEntry[];
  others: LearnedMemoryCurationInputEntry[];
  bytes: number;
  /** How many items this pass may apply. */
  cap: number;
};
