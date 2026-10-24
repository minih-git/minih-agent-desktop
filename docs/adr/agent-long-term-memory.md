# ADR agent-long-term-memory: Layered, provenance-tracked long-term memory

- Status: Accepted for implementation (D668)
- Date: 2026-10-18
- Amends: ADR 0234 (project memory stays the pinned layer)
- Related: ADR 0249, ADR 0323, ADR 0329, ADR session-content-search,
  ADR builtin-session-messaging
- Implementation plan:
  [long-term-memory-implementation-plan](../project/long-term-memory-implementation-plan.md)

## Context

### Current behavior

The Agent has exactly one durable cross-session memory path: user-authored
project memory (ADR 0234). It is stored in host `kv` (`projectMemory` keyed by
canonical project path, `projectGroupMemory` keyed by group id), capped at
32 KiB, loaded by Electron main at session launch, and rendered in full into
the system prompt after project instructions with an explicit
"user-provided context, not instructions" label
(`packages/agent-runtime/src/project-memory-prompt.ts`). Any change retires the
next reusable runtime (`packages/agent-runtime/src/runtime.ts`, reuse check).

Everything else is session-local. Transcripts are persisted losslessly and
compaction keeps a long session going, but a new session inherits nothing the
user did not type into the memory editor. No tool can write memory, nothing is
learned from corrections, and the only way to retrieve an earlier conversation
is the user-facing global search (ADR session-content-search).

Observed costs: users repeat the same corrections and preferences across
sessions; durable context grows only when the user curates it by hand; and the
32 KiB full-text injection cannot grow without paying for it on every request.

### Reference systems

Two reference implementations were reviewed from source. Both are evidence of
mechanisms, not proof of their default behavior in shipped products.

- **Codex** (`openai/codex`, commit `3b8f43a06b`, 2026-10-17). A host-owned
  SQLite job table drives a two-phase background pipeline: per-thread
  extraction with leases, watermarks, and retry budgets, then a single-flight
  consolidation that is skipped when its inputs are unchanged. Extraction
  input separates human input, other agents, tool output, and injected
  instructions (`codex-rs/memories/write/src/rollout_input.rs`). A short
  summary (token-capped) is injected; details are read on demand. The feature
  is off by default (`codex-rs/features/src/lib.rs`). Its reset clears
  derived data but keeps source threads eligible, so a reset is not a durable
  "forget" (`codex-rs/app-server/tests/suite/v2/memory_reset.rs`).
- **Claude Code** (community source-map reconstruction of 2.1.88, mirror
  commit `e54c5af`). Typed memories (`user`, `feedback`, `project`,
  `reference`) live as topic files behind a short `MEMORY.md` index that is
  loaded at session start with line and byte caps
  (`src/memdir/memdir.ts`). The memory directory is keyed by the canonical git
  root so worktrees share it (`src/memdir/paths.ts`). A turn-end background
  extraction and a gated consolidation pass exist behind feature flags
  (`src/services/extractMemories/`, `src/services/autoDream/`). The prompt
  carries an explicit "what not to save" list and a staleness caveat
  (`src/memdir/memoryTypes.ts`).

### Constraints

- Rust host-core exclusively owns SQLite; the renderer never reads it;
  Electron main stays a thin orchestrator (AGENTS.md §4).
- ADR 0323 removed model calls from core user flows: no core flow may wait on
  a model, and optional model-cost features need explicit opt-in.
- The runtime reuse check and provider prompt caching both depend on a stable
  system prompt. Memory that changes mid-session must not retire runtimes or
  invalidate caches.
- Repository text, web pages, tool results, MCP responses, and subagent output
  are untrusted data (AGENTS.md §11). A memory written from them would turn a
  one-time injection into a persistent one.
- Existing project memory data, its editor, its config-sync domain, and its
  ADR 0234 semantics must keep working unchanged.

## Decision

### 1. Three layers with distinct owners

| Layer | Content | Writer | Read path |
|---|---|---|---|
| Pinned memory | Existing project / group memory (ADR 0234) | User only | Full text at session start (unchanged) |
| Learned memory | Typed entries: preferences, feedback, facts, references | Explicit tool, user UI, optional extraction | Short index at session start + on-demand search |
| Evidence | Transcripts and their search index | Existing persistence | On-demand history search |

`AGENTS.md` and other instruction files remain instructions, and compaction
remains in-session context management; neither becomes part of the memory
subsystem. Pinned memory keeps its storage, editor, 32 KiB cap, sync domain,
and runtime-retirement behavior.

### 2. Learned memory is a host-core domain

A new host-core module owns learned memory in SQLite (schema v26 at the time
of writing; the number follows whatever is current on `main` when the
migration lands):

- `memory_entries`: `id`, `scope_kind` (`project` | `user`), `scope_key`
  (the project-group id or canonical project path used by ADR 0249 lookups;
  null for user scope), `kind` (`preference` | `feedback` | `fact` |
  `reference`), `content` (≤ 1 KiB), optional `rationale`, `status`
  (`suggested` | `active` | `archived`), `origin` (`explicit` | `user_ui` |
  `extracted`), `evidence` (`user_stated` | `verified` | `inferred`),
  `source_session_id`, `source_message_ids`, `fingerprint`, `revision`,
  `superseded_by`, `created_at`, `updated_at`, `last_used_at`, `use_count`.
- `memory_tombstones`: `scope_kind`, `scope_key`, `fingerprint`,
  `source_session_id`, `source_message_ids`, `created_at`. No content.
- `memory_session_state`: per-session extraction cursor, lease, attempt
  count, last error, and a user `excluded` flag.
- An FTS index over `content` and `rationale`, built the same way as the
  message index used by ADR session-content-search.

Scope identity reuses existing project identity: isolated worktree sessions
keep the main project's identity (ADR 0329), so all worktrees of a project
share learned memory, and remote workspace sessions use the same identity as
pinned memory. Only `project` and `user` scopes exist.

Learned memory follows the pinned-memory lifecycle of ADR 0249 groups. A
folder that becomes a root of a group — whether the group is created around
projects that were already saved, or a stored group gains a root — hands its
path-scoped entries, tombstones, and session state to the group in the same
transaction, deduplicating by fingerprint and merging the source messages of
tombstones that share one. Removing a root leaves the group's memory with the
group. Deleting a group record deletes its group-scoped learned memory.

All mutations go through host RPCs and one shared set of host rules, so a
caller cannot store an extracted entry as active, invent a suggestion, or
record a preference from content the user did not write. Updates are
compare-and-set on `revision`, so a background writer can never overwrite a
user edit.

### 3. Write paths

1. **Explicit remember.** A built-in `MemoryRemember` tool creates an
   `active` entry with `origin = explicit`. The runtime attaches the source
   session and the latest user message ids; the host validates them. The tool
   takes a `basis` of `user_stated` (default) or `verified`; `verified` is
   accepted only for `fact` and `reference` and records something the agent
   observed in this session. The renderer shows a receipt with Edit and Undo
   in the transcript. The tool is `medium` risk and follows the normal
   permission mode in every mode.
2. **User UI.** A memory manager (per project and for the user scope) lists,
   edits, archives, restores, and deletes entries, and reviews suggestions.
3. **Optional extraction (off by default).** See §4. It only ever creates
   `suggested` entries. A suggestion becomes `active` only through user
   confirmation in v1. The host enforces the pairing: `origin = extracted` and
   `status = suggested` are required together, so no writer can store an
   extracted entry as active or invent a suggestion.

Every writer enforces the same rules:

- `preference` and `feedback` entries require `evidence = user_stated` and
  must cite **only** messages the user wrote: every cited message must belong to
  a real turn of the source session, exist there with role `user`, and not be a
  message another agent or plugin delivered into that session — a delivered
  message is stored with role `user` too, and only the delivery ledger
  distinguishes it. A copy that lost its turn reference (the prefix a fork
  copies, an imported session) therefore cannot stand in for user input either,
  which is what keeps a forked delivery from becoming a preference. Tool results,
  file or web content, MCP responses, subagent output, injected instructions,
  and skill documents are never valid evidence for these kinds.
- Content is rejected when it matches a new host-side credential detector
  (common API key and token formats, private key blocks, passwords embedded in
  URLs). No such detector exists today; it is part of this change. Rejected
  content is not logged.
- The prompt-level exclusion list applies: no code structure, git history,
  content derivable from the workspace, instruction-file content, or
  transient task state. Single-task requests ("skip E2E this time") stay in
  their task and never become preferences.

### 4. Extraction runs off the critical path

When enabled, an Electron main memory service (a new module, not added to
`electron/main/index.ts`) schedules extraction:

- **Triggers:** a `compaction_end` event (the compaction summary's
  `Constraints & Preferences` and `Key Decisions` sections are the primary
  input), or a session that has been idle after `agent_end` for a debounce
  interval. Nothing runs during a turn or at shutdown.
- **Input:** user-authored messages after the session cursor plus the
  latest compaction summary, bounded by a byte budget. Tool output is not
  sent, and a message another agent or plugin delivered into the session is
  not user-authored input either.
- **Model:** a user-selected model via the existing one-shot completion path
  (`completeOneShot`), with per-run and daily budgets shown in Settings.
- **Durability:** the host-owned cursor and lease make runs idempotent across
  restarts, duplicates, and reloads. A failed run keeps the cursor and is
  retried with backoff; excluded sessions are skipped.
- **Output:** at most a small number of typed candidates with cited message
  ids, validated by the host (§3 rules, tombstones, deduplication by
  fingerprint) before they are stored as `suggested`. The host rejects any
  write that pairs extraction with another status, so this path cannot store
  an active entry even if the service asks for one.

This keeps ADR 0323 intact: no user flow waits on the model, and model cost is
opt-in.

### 5. Read path

- **Session-start snapshot.** Launch loads pinned memory (unchanged) and a
  learned-memory index: `active` entries for the session's project scope and
  the user scope, explicit entries first, then by recency of use, one line
  each, within a fixed budget (initially 40 lines / 6 KiB). Overflow is
  summarized as a count with a pointer to `MemorySearch`.
- **Frozen for the runtime's lifetime.** Learned-memory changes do not
  participate in the runtime reuse check and do not change the system prompt
  of a running session. A write made during a session is acknowledged in the
  tool result. The next session sees the new index.
- **On-demand tools.** `MemorySearch` (learned memory, scope-filtered) and
  `SessionHistorySearch` (wraps `search.sessions` / `search.context`, scoped
  to the current project by default) are low-risk, read-only, on-demand
  built-in tools, like the session messaging tools. They keep the fixed tool
  declarations stable.
- **Prompt contract.** The learned-memory section states that entries are
  dated, user-provided context, may be stale, must be verified against the
  current workspace before being relied on, and lose to the current request.
  If the user asks to ignore memory, the agent proceeds as if it were empty.
- **Subagents** receive no learned memory by default, matching the current
  behavior: `composeSubagentSystemPrompt` composes only the framing, the
  definition prompt, and guidance, never project memory.
- Search hits update `last_used_at` and `use_count`; index injection alone
  does not.

### 6. Forgetting is a host guarantee

- **Delete** erases the entry — the row and its full-text index entries are
  removed, so the text cannot be read back or restored — and writes a tombstone
  with its fingerprint and source message ids. Extraction and every create path
  drop candidates whose fingerprint or cited source messages match a tombstone,
  so the same evidence can never resurrect a deleted memory. Clearing a
  tombstone is the **user's** own action and only theirs: the transcript receipt
  offers "remember again" after a delete, and that button reaches a dedicated
  host method that no model-callable path can invoke. A model calling the
  remember tool for deleted content is refused with `MEMORY_TOMBSTONED` in every
  permission mode, so a prompt injection in workspace content can never undo a
  delete. Archive and restore stay a reversible hide and never write a
  tombstone.
- **Rejecting a suggestion** erases the suggestion and writes the same
  tombstone, so it is not proposed again from the same evidence.
- **Separate switches:** "use learned memory" (read, default on), "learn
  automatically" (extraction, default off), and a per-session "don't learn
  from this conversation". Turning reading off hides the index and the memory
  tools without deleting data.
- **Project deletion** removes the project's learned entries, tombstones, and
  session state together with the existing project memory cleanup.

### 7. Sync

Learned memory gets its own config-sync domain, `learnedMemory`, gated by the
existing opt-in memory category: one entity per project identity carries that
scope's `active` and `archived` entries plus its tombstones, using the same
project mapping as pinned memory, and the user scope is one entity that needs no
mapping. Identity inside a scope is the entry fingerprint, and that is also the
merge unit: a scope's payload is unioned by fingerprint, so two devices that
wrote the same note merge into one and two devices that each wrote their own note
keep both, instead of a whole scope becoming a conflict the user must resolve.
The same fingerprint is taken from the newer `updated_at`, and a delete
propagates as a tombstone that also blocks the evidence behind it. A delete wins
over an edit of the same note, because an edit moves `updated_at` only, unless
the note was created after the delete — which is what "remember again" produces.
Suggestions, cursors, session state, the budget ledger, and the device-local
counters stay where they were made.

Two limits are accepted with it: a delete and a re-creation are ordered by the
timestamps the two devices wrote, so a large clock difference between them can
order a delete and an edit the wrong way; and one scope contributes at most 500
notes to a revision, so a larger scope syncs its newest 500.

It is a separate domain rather than an extension of the pinned `memory` domain
because a released build treats every entity of that domain as pinned project
memory: it would erase pinned notes on a deletion, create groups, and refuse a
user-scope entity with `CONFIG_SYNC_MAPPING_REQUIRED`.

A build that does not know a domain cannot read a revision that carries it —
the manifest decode refuses an unknown domain (`CONFIG_SYNC_UNSUPPORTED`) rather
than skipping it — so shipping this domain requires every device of a vault to
run a build that knows it. This is the accepted cost of the first new portable
domain, not an oversight; a device on an older build stops syncing (and
restoring) until it is updated.

### 8. Explicitly out of scope for v1

Embeddings or vector search; a per-turn model call to select memories;
periodic consolidation passes; automatic promotion of suggestions; memory in
subagents; writing memory into `AGENTS.md` or any workspace file; dedicated
remote-web or mobile memory UI (those clients show the tools as generic tool
rows).

Amendment (D682; [plugin learned-memory read ADR](plugin-learned-memory-read.md): a
read-only listing of active notes is allowed through `memory.read`. Plugin
writes, suggestion APIs, and detailed provenance remain out of scope.

## Consequences

- Repeated corrections and preferences can persist without hand-curating a
  document, and earlier conversations become retrievable by the agent.
- The pinned layer, its data, and its behavior are unchanged; no user data is
  migrated.
- New public surfaces: host RPCs, IPC channels, shared types, two read-only
  tools and one write tool, a schema migration, a config-sync payload
  extension, Settings and Project archive UI. Each needs the usual contract
  tests, i18n, spec updates, and E2E scenarios.
- Learned memory adds up to ~6 KiB to each new session's prompt when used;
  history and memory search add latency only when called. CJK history queries
  fall back to the literal scan of ADR session-content-search and need a
  measured performance budget.
- Residual risk: a prompt injection could make the model call
  `MemoryRemember`. It is bounded by the permission mode, the visible receipt
  with Undo, scope limits, the credential detector, and the "context, not
  instructions" contract, but not eliminated.
- Tombstones block resurrection from the same evidence, not a near-duplicate
  restated in a new conversation; the per-session and global switches cover
  that case.
- An older app version cannot open a database migrated to the new schema; the
  existing schema-version policy applies.
- Configuration sync of learned memory requires every device of a vault to run a
  build that knows the `learnedMemory` domain, because an older build refuses a
  revision that carries an unknown domain instead of skipping it.

## Alternatives

- **Extend the `projectMemory` kv record with more fields.** Rejected: no
  index or FTS, a single 32 KiB blob per scope, and mixing user-curated and
  machine-written content would make the ADR 0234 editor ambiguous.
- **Claude-style Markdown memory directory written with Write/Edit.**
  Rejected: puts host state in the filesystem behind file-path permission
  carve-outs, bypasses host-owned validation and tombstones, and conflicts
  with SQLite ownership.
- **Codex-style full pipeline in v1** (global consolidation, workspace diff,
  versioned artifacts). Deferred: high cost and complexity before there is
  usage evidence; the cursor and lease design keeps the door open.
- **Plugin-owned extraction** (as titles in ADR 0323). Rejected for v1:
  provenance checks need host access to message roles, and tombstones must be
  enforced by the owner of the data. Extraction stays opt-in in core instead.
- **Automatic activation of extracted memories.** Rejected for v1: the
  suggestion inbox trades some friction for protection against poisoning and
  over-generalization. Corroboration-based promotion may be reconsidered with
  measured suggestion quality.
- **Embeddings.** Deferred until literal and FTS recall measurably fails.

## Resolved decisions (D668)

- **Learn automatically is off by default.** Extraction needs a model the
  user chooses and spends the user's quota, so it cannot be on before that
  choice. Settings offers it once a model is selected.
- **Sync follows the existing opt-in memory category.** When the user enables
  memory in configuration sync, active and archived learned entries of both
  scopes and their tombstones sync through a dedicated `learnedMemory` domain;
  there is no separate default and no separate category. All devices of the
  vault must run a build that knows the domain (see §7).
- **`MemoryRemember` uses the normal permission path in every mode.** Detecting
  "the user asked to remember" from message text is language-dependent and
  easy to spoof; the receipt with Undo keeps explicit saves low-friction.
