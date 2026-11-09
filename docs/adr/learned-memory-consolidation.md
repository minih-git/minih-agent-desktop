# ADR learned-memory-consolidation: Automatic curation of learned memory

- Status: Accepted for implementation (D688, 2026-11-09)
- Date: 2026-11-09
- Amends: ADR agent-long-term-memory (D668) §4 (extraction output) and §8
  (what stayed out of scope in v1)
- Related: ADR 0323 (background model work stays off the critical path)
- Implementation plan:
  [learned-memory-auto-curation-plan](../project/learned-memory-consolidation-plan.md)

## Context

Learned memory v1 (D668) stores typed notes with provenance, compare-and-set
revisions, and tombstones. A frozen session-start index (40 lines / 6 KiB)
carries them into a session, and optional extraction only *proposes* notes: a
candidate waits in the Suggestions inbox until the user keeps it. Once a note is
active, nothing looks at it again. That is how memory goes stale, and it is what
the first version of this ADR proposed to fix with a review queue of proposals:

- **A changed mind keeps both notes.** "Deliver after a full download check" and,
  later, "deliver after a metadata check only" are two active notes with different
  fingerprints. Both enter the index.
- **Near-duplicates crowd the index.** The same preference worded three times
  passes the exact-fingerprint deduplication and takes three of the 40 lines.
- **`superseded_by` is a column nobody writes.** No code path sets it, and it does
  not travel through configuration sync.

The original design made every cleanup a proposal the user confirms, plus a
per-note review queue (30 / 90 days, "Still true"). On 2026-11-09 the user
decided that is the wrong trade: the point of learning memory is that the user
does not have to tend it.

**Three decisions bound this design** (user, 2026-11-09):

1. An automatic removal is always an archive (`archived` + `superseded_by`) and is
   recoverable. The automatic path never writes a tombstone and never clears one;
   forgetting stays the user's own action.
2. A note the user authored by hand (`origin = explicit` / `user_ui`) is never
   rewritten by a pass. It may still be the *subject* of a merge or a replace,
   which archives it and can be undone.
3. Session archiving (`feat/conversation-archive`) is a separate feature with its
   own model calls. The two do not share a pass, a lease, or a budget line beyond
   the daily token ledger they both spend from.

The per-note review queue is **not** part of this decision. It is dropped from
this ADR and may return as its own feature once curation is running.

## Decision

### 1. One switch, off by default

`learnedMemory.curate` is device-local and off by default. It needs
`learnedMemory.model` first, because a pass spends real quota, and it shares the
existing daily token ledger with extraction.

With the switch off the application behaves **exactly as it did before**:
extraction writes `suggested` notes, the inbox lists them, and no automatic
change happens. Nothing in the schema, the sync format, or the read path depends
on the switch being on.

The setting's help text states what turning it on means — that notes will be
changed and archived automatically and can be undone from "recently curated" —
and recommends turning it on for one device only. Two devices that both curate
the same user-scope notes each produce their own merged note; the next pass sees
two near-duplicates and merges them, so they converge without a conflict.

### 2. Applying goes through the host, with guardrails it enforces

Every automatic change is a host operation on one scope. The service proposes;
the host decides. No rule lives only in the prompt, because a prompt is advice:

| Operation | Precondition | Effect |
|---|---|---|
| activate | `origin = extracted`, `status = suggested`, in this scope | `suggested → active`; `origin` stays `extracted` |
| merge | 2–5 `active` notes, same scope and kind | one new `active` note; targets `archived` with `superseded_by` pointing at it |
| replace | 1–3 `active` notes, same scope; the newest is the successor | the others `archived` with `superseded_by` pointing at the successor |
| reword | exactly one `origin = extracted` note | content replaced in place; `revision + 1` |
| hint | — | changes nothing; a volatility hint for a later review feature |

There is deliberately **no "archive a stale note" operation**: without a newer
note to point at, "this looks out of date" is a guess, not a cleanup.

Guardrails, all applied inside the host's transaction:

- **Cap.** One pass applies at most `min(8, max(1, 20% of the scope's active
  notes))` items. The ceiling comes from the host, not the caller; items past it
  are refused with `capped` and the scope's state records `CURATION_CAPPED`.
- **The user's fresh edit is left alone.** A note the user wrote or edited inside
  30 days is not archived by a replace and not reworded. The rule protects the
  *content* the user just chose; a merge only reads its targets and writes a new
  note beside them, so it is gated by origin instead.
- **A note the user wrote is never reworded.** `explicit` and `user_ui` are
  refused with `explicit-reword`, always.
- **A merge result passes the same write rules**: 1 KiB, the credential
  detector, and the tombstones — a merged note whose fingerprint is tombstoned is
  refused with `MEMORY_TOMBSTONED`. Source messages are unioned (≤ 16), a `fact`
  or `reference` takes the weakest evidence, and the origin is the strongest of
  the targets, so merging never demotes what the user wrote and never promotes
  what they did not.
- **Revision check.** Every item names each target's `revision` as the service
  saw it. One mismatch refuses the whole item (`stale`) and changes nothing.
- **A refused set is not retried.** Undoing a merge or a replace records the set's
  identity, and a later pass that proposes the same set is refused with
  `already-undone`.
- **No injection surface.** The input is the scope's own notes: no transcript, no
  tool output, no workspace. The prompt states that note content is data
  (`docs/spec/03-runtime/02-agent-runtime.md` §7.4 carries the same contract for
  the read path), and the answer is a fixed JSON shape the host validates item by
  item. A merge whose content the credential detector refuses is dropped, and the
  refused text never reaches a log.

### 3. Every change is recorded, and can be undone

Automatic changes write `memory_revisions` in the same transaction as the change
itself: one row per note touched, holding the operation, the batch, what was
there before, what is there now, and a one-line reason. The rows are device-local
(they never travel through configuration sync) and are kept for 90 days.

The manager shows them as **recently curated**, collapsed by default, with the
count for the last seven days. Undo works on one batch:

| Undo | Effect |
|---|---|
| activation | same meaning as the inbox's **Discard**: the note is erased and its evidence recorded as rejected, so the same conversation cannot propose it again. The user pressed it, so this is the one undo allowed to write a tombstone |
| merge | the new note is archived; the targets are restored to `active` with `superseded_by` cleared; the set is recorded as rejected |
| replace | the archived notes are restored; the successor is untouched; the set is recorded as rejected |
| reword | the previous content is written back and its fingerprint recomputed |

Every undo first compares the note against the `after` snapshot it recorded. A
note that changed since — the user's edit, a configuration-sync apply — makes the
whole batch a `MEMORY_UNDO_CONFLICT` with nothing written, and the manager says
the note was changed after the automatic pass. An undo whose note was deleted in
the meantime is also a conflict: a delete is the user's decision and it wins.

An undone batch is marked, so it cannot be undone twice (`MEMORY_UNDO_ALREADY_DONE`)
and no longer appears in the list.

### 4. When a pass runs

- **Idle only.** Ten minutes after the app went idle, with no turn running in any
  session. A turn starting cancels the pending pass; quitting cancels it too.
- **One scope at a time.** A scope becomes dirty when one of its notes is created,
  edited, archived, restored, or deleted, when an extraction candidate is
  activated, or when a sync apply writes to it. Each pass claims one dirty scope
  with a host lease, oldest first.
- **Once per local day.** A scope's claim stamps the local calendar day, so a
  scope gets at most one pass a day whether it succeeds, finds nothing, or fails.
  A failed pass releases its lease and records the error code; the dirty flag
  stays, so the next day picks it up.
- **Input**: the notes changed since the last pass, up to five same-kind
  full-text neighbours of each, and the rest of the scope's active notes newest
  first, inside 24 KiB. Each note carries its id, kind, origin, dates, content,
  rationale, its `revision`, and whether a pass may reword it.
- **Output**: at most 8 items of `{op, targetIds, targetRevisions, content?,
  reason?}`. The host validates and caps them; nothing outside the shape is
  accepted.
- **Logs carry result codes and counts**, never note content.

### 5. Read path

- The learned-memory section of the system prompt gains one rule: **when two notes
  conflict, the newer one wins** (ADR agent-long-term-memory §5). It takes effect
  at the next session start and does not depend on this switch, so it covers the
  window between two notes beginning to conflict and the next pass archiving one.
- Archived notes stay out of the index and out of `MemorySearch`, as before.
- A note that was superseded shows "Replaced by …" in the manager on the device
  that curated it.

### 6. Sync

The sync format does not change. An automatic change produces only status changes
and notes the existing `learnedMemory` domain already carries, so a device running
an older build applies them as it does today. Revision records, rejections, the
per-scope pass state, and `superseded_by` stay on the device that wrote them: on
another device a replaced note simply shows as archived.

## Consequences

- With the switch on, memory keeps itself tidy: duplicates disappear, a changed
  mind leaves one note, and the index stops spending its 40 lines on the same
  preference worded three ways.
- Every change is reversible and every change says why it happened. A user who
  never opens the manager accepts automatically, which is the trade the user
  chose over a review queue.
- A wrong merge costs one undo. The cost of never looking is a note archived that
  the user did not expect — recoverable, recorded, and bounded by the cap.
- Extraction's output changes meaning with the switch: candidates become notes
  instead of proposals. The inbox stops showing them, so a user who prefers to
  review turns the switch off rather than living with both flows.
- Host schema v41 (the v40 -> v41 step) adds `memory_revisions`,
  `memory_curation_state`, and `memory_curation_rejections`. As with every migration, an older app cannot open
  the migrated database.
- Cost stays bounded: off by default, one pass per scope per day, 24 KiB in and 8
  items out, and the same daily token ledger extraction already spends.
- Residual risks: a pass that merges incorrectly, a device that keeps running for
  weeks so nothing ever looks idle, and two devices curating at once (which
  converges, but can briefly show two notes).

## Alternatives

- **Proposals confirmed by the user, plus a review queue.** This was the first
  version of this ADR. Rejected by the user on 2026-11-09: the friction is the
  problem, and the same protection is available through undo.
- **A per-note review interval and "Still true".** Deferred: it asks the user to
  keep checking, which is what this ADR removes. A volatility hint is recorded so
  a later feature can use it without another pass.
- **Archive a note the model thinks is stale.** Rejected: with no successor to
  point at, the decision rests on nothing but a guess, and the user would have to
  audit every one.
- **Delete instead of archive.** Rejected by the user: automatic removal must be
  recoverable, and forgetting is the user's own action (ADR agent-long-term-memory
  §6).
- **Let the model rewrite notes the user wrote.** Rejected by the user: it is
  their sentence. A merge or a replace may archive it with a link and a record,
  which is visible and reversible; rewording is not.
- **Check for a superseded note synchronously when writing.** Rejected:
  `MemoryRemember` would wait on a model call, and no user flow may wait on a model
  (ADR 0323).
- **Share the pass with session archiving.** Rejected by the user: the two features
  are being built at the same time, and a shared pass would couple their failures,
  their budgets, and their debugging.
- **Run every dirty scope on a fixed schedule.** Rejected: a schedule spends tokens
  whether or not anything changed, and the daily budget is the user's.
