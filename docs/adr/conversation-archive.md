# ADR conversation-archive: Layered conversation archive for plugins

- Status: Accepted for implementation (2026-11-09, decision D685)
- Date: 2026-11-09
- Amends: [ADR plugin-learned-memory-read](plugin-learned-memory-read.md) (§3
  wiring pattern only; that permission is unchanged)
- Related: ADR agent-long-term-memory (D668), ADR 0234, spec
  `03-runtime/04-data-storage.md`, spec `03-runtime/06-host-rpc-protocol.md`,
  spec `03-runtime/22-config-sync.md`, spec `07-plugins/03-plugin-api.md`, spec
  `07-plugins/13-plugin-permissions-matrix.md`, plugin ADR
  `minih.personal-knowledge` (`minih-agent-plugins`)

## Context

Conversations are the largest body of knowledge the user produces, and today
they never leave the machine that made them. Sessions live in
`~/.minih-agent-desktop/sessions/*.jsonl` and in the `messages` index of
`pi.sqlite`; `SessionHistorySearch` reads them, and `docs/spec/03-runtime/22-config-sync.md`
states that configuration sync does not carry conversation history. A user
with several computers therefore cannot ask "what did I do in this project last
week" from the machine that did not do it.

The first-party plugin `minih.personal-knowledge` maintains the user's Obsidian
vault as agent context. The vault already syncs through a file provider, and
the plugin already writes project notes the user curates. The natural next step
is to let the vault also hold what the conversations decided — but a plugin
must not read `pi.sqlite` (AGENTS.md §4: SQLite is owned by host-core), and
copying whole transcripts into a synced folder would take thinking traces, tool
output, attachments, and credentials off the device.

On 2026-11-09 the user's device held 238 sessions (30 with no project),
2.7 MB of user text, 10.4 MB of assistant text, and 186 000 tool calls whose
arguments occupy 119 MB. The transcript files total 2.9 GB, almost all of it
tool output. That measurement sets both the shape of what may leave the
machine and the need for a summary layer ahead of the raw layer.

## Decision

### 1. Three layers, one owner each

| Layer | Content | Written by | Read by |
|---|---|---|---|
| L1 project card | existing project notes | user / knowledge plugin | `knowledge_context` |
| L2 summary | fixed-field summary of one session | knowledge plugin, from `pi.conversations.*` | search tools of the knowledge plugin |
| L3 transcript | user text, assistant text, one line per tool call, compaction markers | knowledge plugin, from `pi.conversations.transcript` | only by session id chosen from an L2 hit |

The host owns the conversation data and the L2 summary rows. The plugin owns
the vault files. Electron main owns the schedule, the model call, and the
switch. No layer of the archive is written by the renderer, and none of it
travels through application configuration sync.

### 2. Host projection is the only exit

A new host-core module `crates/host-core/src/conversation_archive/` reads the
live transcript through `transcripts::read_transcript_with_compactions` — the
version in force, never a discarded regenerate branch — and projects it into
turns:

- user text and assistant text, from `text` blocks only;
- one line per tool call, from `tool_call` blocks: `Bash` takes `command`,
  `Read`/`Edit`/`Write` take `path`, `Grep`/`Glob` take `pattern` and `path`,
  `Skill` takes `id`, every other tool takes the first 160 characters of its
  argument JSON; a failed call gets `✗`;
- one marker line per compaction checkpoint.

Thinking blocks, attachments, `result` payloads, hosted-search payloads, and
system messages never enter the projection. Redaction runs on every projected
line, not on the message as a whole: `memory::secrets` gains a fragment
replacer that turns a credential shape into `[REDACTED:<kind>]` and keeps the
rest of the line, because a tool argument is exactly where a token appears
next to ordinary text.

### 3. Schema v29 is additive

`conversation_summaries` stores one row per session (`session_id` primary key,
`covered_seq`, `revision`, `summary_json`, `model_key`, `lease_owner`,
`lease_until`, `attempts`, `last_error`, `updated_at`) and holds the same
lease, cursor, and retry state the extraction table holds, so a restart, a
duplicate trigger, or a renderer reload cannot repeat or skip a range.
`conversation_archive_tombstones` records a permanent deletion
(`session_id`, `deleted_at`) so a plugin can delete the file whose session no
longer exists to be named.

Both tables are new; no existing row is rewritten. A build that opens a v28
database (the released 1.3.x schema) adds them and starts with every session
**summarized zero times**, which is exactly the backfill queue. A v29 database
opened by an older build fails closed on the version check that already exists.

### 4. Change feed

`plugin.conversations.changes` pages sessions by the composite cursor
`(max(sessions.updated_at, summary.updated_at), session_id)`. Soft-deleted
sessions, excluded sessions, and permanently deleted sessions (from the tombstone
table) appear in the feed as `removed: true` items so the plugin can delete the
files it wrote. The cursor is opaque to the plugin and stable across restarts
because it is derived from stored timestamps, not from a process counter.

### 5. Project identity

Each feed item carries `project: { name, path, gitRemote? }`. `gitRemote` is
resolved from `<path>/.git/config` (following `gitdir` for a worktree), and the
`origin` URL is normalized to `host/owner/repo`: credentials in the URL are
removed, the scheme is dropped, the host is lowercased, a trailing `.git` is
trimmed. A plugin therefore maps the same repository to the same vault folder
on every computer, whatever the local path is.

### 6. Summary generation stays off the critical path

`apps/desktop/electron/main/memory/conversation-summary-service.ts` mirrors the
extractor: idle ten minutes after a settled turn, or immediately after a
compaction; never during a running turn; the same lease, cursor, retry (three
attempts, thirty-minute backoff), and the **same daily token budget** as
automatic learning. Input is the previous summary plus the new L3 text after
`covered_seq`, capped at 24 KiB with a truncation marker. Output is a fixed-field
JSON (goal, decisions, outcomes, files, open items, tags) capped at 1200 tokens.
Excluded sessions, automation run sessions, and imported sessions are skipped
for the same reasons extraction skips them.

The compaction note is deliberate: this application's compaction appends a
checkpoint and keeps the messages, so summary input is read from the original
messages after the cursor and a compaction never hides text. No "write before
compaction" path exists or is needed.

### 7. Disclosure: the summary call sends more than learning does

Automatic learning sends only what the user wrote. A conversation summary must
also send the agent's replies and one line per tool call, because that is what
a summary of the work is a summary of. The switch is therefore off by default,
cannot be turned on without a learning model, and its settings description, the
user guide in both locales, this record, and the changelog say so in plain
words. Tool *results*, thinking, and attachments are still never sent.

### 8. Permission `conversation.read`

| Permission | Risk | API | Grant | Boundary |
|---|---|---|---|---|
| `conversation.read` | high | `pi.conversations.changes` / `summary` / `transcript` | Confirm at install | The archive switch must be on; redacted projection only; no thinking, tool results, attachments, or system messages; no write path |

Risk is high for the same reason `memory.read` is: the response carries what the
user and the agent said. The permission is a contract and a disclosure, not
containment — a plugin `main.js` with raw Node could still open the database
file (spec `05-security/01-security.md` §6).

The API surface is:

```ts
pi.conversations.changes(input: { cursor?: string; limit?: number }): Promise<{
  enabled: boolean
  items: Array<{
    sessionId: string
    title: string
    createdAt: number
    updatedAt: number
    project: { name: string; path: string; gitRemote?: string } | null
    lastSeq: number
    summaryRevision: number | null
    removed: boolean
  }>
  nextCursor: string | null
}>

pi.conversations.summary(input: { sessionId: string }): Promise<{
  revision: number
  coveredSeq: number
  summary: ConversationSummary
} | null>

pi.conversations.transcript(input: {
  sessionId: string
  fromTurn?: number
  limit?: number
}): Promise<{
  turns: ConversationTurn[]
  nextTurn: number | null
  lastSeq: number
}>
```

When the switch is off, Electron main answers `changes` with
`{ enabled: false, items: [], nextCursor: null }` and never calls the host;
`summary` and `transcript` refuse with `PERMISSION_DENIED`, because a plugin
asking for one specific session must learn that the archive is off rather than
see an empty answer indistinguishable from "this session has no summary".

### 9. Wiring follows `memory.read`

1. `packages/plugin-sdk`: the permission, the `conversations` member of the host
   API type, the exported input/result types.
2. Electron main: `electron/main/plugin-conversation-read.ts` normalizes input
   and owns the switch; `plugin-runtime.ts` gains one `case` per method that
   checks the permission and delegates; `services/plugin-services.ts` adds the
   three methods that call the host RPC with `pluginId`.
3. Host core: `plugin.conversations.*` are thin arms in `rpc/mod.rs` that
   delegate to `rpc/conversation_rpc.rs`.

## Consequences

- A user's conversations can reach a synced folder, and therefore other
  computers, but only as redacted text they can inspect line by line, and only
  while a switch they turned on stays on.
- The plugin can present "what did I do" without a search index over raw
  transcripts: L2 is searchable, L3 is read by id.
- Backfilling 238 sessions costs roughly 2.1 M tokens at the measured volumes,
  bounded by the daily budget; the feature pauses rather than overspends.
- Two credentials-shaped gaps remain and are stated, not closed: redaction is
  shape-based and will miss an unusual secret shape, and a plugin the user
  grants `conversation.read` can read every archived session.
- No protocol version bump: every method is additive, and an older build fails
  the manifest validation of a plugin that names `conversation.read`, so
  `engines.minihAgent` must point at the first release that ships it.

## Alternatives

- **Let the plugin read `pi.sqlite` or the JSONL files.** Rejected: breaks
  SQLite ownership, ignores the switch, has no contract, and takes tool output
  and thinking off the device.
- **Send the whole transcript to the model instead of a host projection.**
  Rejected: the input cap and the disclosure both fail; the projection is the
  difference between "what happened" and "every byte the tools returned".
- **Summarize on the device without a model.** Rejected for L2: a mechanical
  digest of tool lines cannot produce "key decisions" or "open items", and the
  user's question is about meaning.
- **Store L2 in the vault from the host.** Rejected: the host does not know
  where the vault is, and a host path into the user's files would duplicate the
  plugin's ownership.
- **A separate daily budget for summaries.** Rejected for v1: one budget keeps
  the promise ("learning costs at most N tokens a day") simple and honest.
- **Let a plugin trigger a summary.** Rejected: summary runs spend the user's
  quota, so only the user's own switch and idle schedule start them.
