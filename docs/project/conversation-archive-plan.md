# Conversation archive

Status: application side implemented (P1-P3); the consuming plugin is P4-P6 in
`minih-agent-plugins`.

The archive lets a user's conversations reach their own knowledge base, and
therefore their other computers, without every byte of a transcript leaving the
device. The decision record is [ADR conversation-archive](../adr/conversation-archive.md);
this page is the plan it was implemented against.

## 1. Layers

| Layer | Where it lives | Who writes it | How it is read |
|---|---|---|---|
| L1 project card | the existing project notes | the user, or the knowledge plugin | `knowledge_context` per current repository |
| L2 summary | `03 Conversations/<project>/<YYYY-MM>/<date> <title> <id>.md` | the knowledge plugin, from `pi.conversations.summary` | searched by the plugin's own conversation tools |
| L3 transcript | `03 Conversations/_raw/<project>/<YYYY-MM>/<id>.md` | the knowledge plugin, from `pi.conversations.transcript` | only by session id chosen from an L2 hit |

The first number is the plugin's folder layout, not the application's: the
application never learns where the vault is. What the application owns is the
projection that both layers are built from.

## 2. Where each responsibility sits

```text
session JSONL + SQLite ──(host-core: project, redact, store summary)──► plugin API conversation.read
            ▲                                                                   │
Electron main: summary generator (triggers, budget, model)                        ▼
                                                    plugin: pull → redact again → write vault → index
```

- `crates/host-core/src/conversation_archive/` — `projection` (transcript to
  turns), `project_identity` (git remote to `host/owner/repo`), `repo` (lease,
  cursor, backfill queue, tombstone), `feed` (the plugin's three reads), `rpc`.
- `crates/host-core/src/db/conversation_archive_migration.rs` — schema v27, two
  new tables, shared with the fresh-schema DDL.
- `apps/desktop/electron/main/memory/conversation-summary-service.ts` — the
  generator; `conversation-summary-prompt.ts` — its prompt and answer parsing.
- `apps/desktop/electron/main/plugin-conversation-read.ts` — input bounds and
  the archive switch; `plugin-runtime.ts` gains three cases and one method.
- `packages/plugin-sdk` — the `conversation.read` permission and the
  `pi.conversations.*` types.

## 3. What leaves the device, and what never does

Leaves: user text, agent text, one line per tool call (tool name plus its key
argument, truncated to 160 characters, `✗` when it failed), and compaction
markers. Every line passes the fragment credential redactor.

Never leaves: thinking blocks, attachment content, tool `result` payloads,
hosted-search payloads, and system messages. The projection drops them by block
kind, so no later consumer can reintroduce them.

Two disclosure points are deliberate and documented where the user meets them:
the summary request sends the agent's replies and tool lines to the chosen
model (the switch's description, both `guide/memory.md` files, the ADR and the
changelog say so), and a plugin holding `conversation.read` can read every
archived conversation while the switch is on.

## 4. State and bounds

- One summary per session, one run at a time: lease, cursor, revision, and
  attempt counter in `conversation_summaries`.
- Summary input is at most 24 KiB of new text after the cursor; the answer is at
  most 1200 tokens and is projected onto a fixed six-field shape.
- The generator shares automatic learning's daily token budget and its triggers
  (idle ten minutes after a settled turn, or a compaction), and never runs during
  a turn.
- Excluded sessions, imported sessions, and automation run sessions are skipped,
  and their files are reported as removed if they were archived before.
- Backfill runs newest first, one session per step, paced by the same budget.

## 5. Testing

| Level | Covers |
|---|---|
| host-core | projection of every tool family; thinking, attachments, tool results, and system messages never present; credential fragments replaced rather than dropped; compaction markers; remote URL normalization including credentials; worktree `.git` resolution; v26 to v27 migration on an existing database; lease, cursor, revision, attempts; excluded and trashed sessions; forward paging with removals; a removal repeated until the cursor moves past it and cleared only then; a session with no summary listed with a null revision; the cursor predicate pushed into SQL; summary input reads past a compaction; invalid bounds |
| Electron main | input bounds for all three methods; the switch read as off when absent or when the host fails; audit counts |
| Renderer | the archive row appears beside the learning rows, needs a model, and states what is sent |
| Plugin side (P4-P6) | path mapping, single writer, ignore filters, delete, size split |

## 6. Deliberate non-goals

- No conversation content in configuration sync. The Host stores a summary, not
  a replica, and the plugin's vault files are the user's own.
- No vector index over L3, and no search across L3 by the Host.
- No plugin write path: the archive is read-only from every plugin's point of
  view.
- No "summarize before compaction" step: compaction keeps the messages, so the
  cursor already covers the pre-compaction text.
