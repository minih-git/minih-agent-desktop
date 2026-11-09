# Learned-memory automatic-curation implementation plan

- ADR: [learned-memory-consolidation](../adr/learned-memory-consolidation.md)
  (D688, 2026-11-09)
- Status: Implemented in `feat/memory-auto-curation`. Host schema v41 (v40 -> v41).
- Baseline: `origin/main` at `c7dcc8f7`, host schema 26.
- Builds on: [long-term-memory-implementation-plan](long-term-memory-implementation-plan.md)
- Replaces: the 2026-10-19 proposal-and-review design this file used to describe.
  That design never started, and its per-note review queue is not part of this
  one.

## 1. Goals and non-goals

Goals. With **Settings → Global AI → Curate learned memory** on, the user does
not tend memory at all:

1. An extraction candidate takes effect instead of waiting in the inbox.
2. A background pass merges near-duplicates, replaces notes a newer one
   contradicts, and rewrites the wording of extracted notes.
3. Every automatic change is recorded, visible in "recently curated", and undone
   with one click. Not looking is accepting.

Non-goals:

- The automatic path never deletes and never writes or clears a tombstone. A
  delete stays the user's own action (ADR agent-long-term-memory §6).
- A note the user authored by hand is never reworded. It may be archived by a
  merge or a replace, which is recorded and reversible.
- No review queue, no per-note review interval, no "Still true". A volatility
  hint is recorded for a later feature, but nothing reads it yet.
- No comparison against the workspace or the code, no embeddings, no per-turn
  memory selection.
- The session-start index stays frozen for a runtime's lifetime: an automatic
  change is visible from the next session.
- Not shared with session archiving (`feat/conversation-archive`): separate
  pass, separate lease, separate code. Both spend the same daily token ledger.

## 2. Measures

Device-local counters, read from the manager; nothing leaves the device.

| Measure | Source | Target |
|---|---|---|
| Automatic changes per week | `memory_revisions` rows created | reported only |
| Undo rate | undone batches / batches | reported only; a high share means the pass is guessing |
| Capped passes | `last_error = 'CURATION_CAPPED'` | reported only; a persistent value means the cap is too tight or the pass too eager |
| Conflicts on undo | `MEMORY_UNDO_CONFLICT` returns | should stay near zero; a rise means passes touch notes the user is editing |

## 3. Phases

| Phase | Content |
|---|---|
| A0 | The "newer note wins" prompt rule and its spec text. Independent of the switch, effective at the next session start. |
| A1 | Host: schema v41 (v40 -> v41), `memory_revisions` / `memory_curation_state` / `memory_curation_rejections`, the `memory.curation.*` RPCs, every guardrail, undo, and the dirty marking on every write path. Shared types and the `curate` setting field. ADR rewrite, long-term-memory ADR §4/§8 amendment, decisions log. |
| A2 | Electron main: the curation service (idle trigger, one scope at a time, daily limit, lease, backoff, prompt, malformed-answer handling), the post-extraction activation wiring, and the switch gate in the extractor. |
| A3 | Renderer: the Settings row, "recently curated" with undo, the inbox gating when the switch is on, i18n in every locale, the guide, the changelog, and the E2E scenario. |

## 4. Host surface (A1)

### 4.1 Schema

Schema v41 (v40 -> v41), purely additive; `memory_entries` is unchanged.

```sql
CREATE TABLE memory_revisions (
  id          INTEGER PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('activate','merge_new','merge_archive','replace_archive','reword')),
  actor       TEXT NOT NULL CHECK (actor = 'auto'),
  before_json TEXT,
  after_json  TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  undone_at   INTEGER
);
CREATE TABLE memory_curation_state (
  scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '',
  dirty_since INTEGER, last_pass_day TEXT,
  lease_owner TEXT, lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (scope_kind, scope_key)
);
CREATE TABLE memory_curation_rejections (
  scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '',
  target_fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_key, target_fingerprint)
);
```

A migrated v40 file gains the three tables empty, keeps every note, every
tombstone, and every session-state row, and reports version 41. Nothing here
rebuilds a table, so a long-lived file's historical dangling references cannot
stop the step the way the v38 -> v39 rebuild had to allow for.

### 4.2 RPCs

| Method | Parameters | Answer |
|---|---|---|
| `memory.curation.activate` | scope, `ids` | `report { activated, skipped, cap, capped }` |
| `memory.curation.claim` | scope, `owner`, `day`, `leaseMs?` | `{ claimed, reason? }` where reason is `already-ran-today` or `busy` |
| `memory.curation.input` | scope | `{ input }` or `{ input: null, skipped }` |
| `memory.curation.complete` | scope, `owner`, `day` | `{ completed }` |
| `memory.curation.fail` | scope, `owner`, `error` | `{ failed, attempts }` |
| `memory.curation.list` | scope, `sinceDays?` | `{ records, changes, days }` |
| `memory.curation.undo` | `batchId` | `{ undone }`, or `MEMORY_UNDO_CONFLICT` / `MEMORY_UNDO_ALREADY_DONE` / `NOT_FOUND` |

### 4.3 Rules the host enforces

- **Cap**: `min(8, max(1, 20 % of the scope's active notes))` items per pass.
  Items past it are `capped` and the scope's state records `CURATION_CAPPED`.
- **Quiet window**: a note the user wrote or edited inside 30 days is not
  reworded and is not the archived side of a replace. A **merge** is gated on
  origin instead: it only reads its targets, so a note the user wrote long ago
  may be merged, and its origin wins the merge.
- **Never reword what the user wrote**: `explicit` / `user_ui` → `explicit-reword`.
- **Merge result passes the write rules**: 1 KiB, the credential detector, the
  tombstones, and the live-fingerprint uniqueness. Origin is the strongest of the
  targets, evidence the weakest for a `fact` / `reference`, source messages the
  union (≤ 16).
- **Revision check**: one moved target voids the whole item (`stale`).
- **Rejected sets**: undoing a merge or a replace records the set's fingerprint;
  the same set is refused with `already-undone` afterwards.
- **Dirty marking**: create, update, status change, delete, accepting a
  suggestion, an activation, and a sync apply all mark the scope dirty in the
  same transaction as the change.
- **Deleting a project** drops its curation state and rejections with the rest of
  its learned memory.

### 4.4 Undo

Every row is re-checked against its `after` snapshot before anything is written;
one mismatch is `MEMORY_UNDO_CONFLICT` with nothing written. Then, per row:
activation → erase the note and write its tombstone (the inbox's Discard
semantics, the one automatic-adjacent path allowed to forget); `merge_new` →
archive the merged note; `merge_archive` / `replace_archive` → restore the target
and clear `superseded_by`; `reword` → write the previous content back and
recompute its fingerprint. The batch is stamped `undone_at`, merge and replace
sets are recorded as rejected, and the scope is marked dirty.

## 5. Electron main (A2)

- `apps/desktop/electron/main/memory/memory-curation-service.ts` owns the pass and
  nothing else; `index.ts` only wires it.
- **Triggers**: app idle (10 minutes) with no turn running in any session. A turn
  starting cancels the pending timer; quitting disposes the service.
- **One scope at a time**, oldest dirty scope first, claimed with a host lease.
- **One pass per scope per local day**, stamped at claim time, so a failing scope
  cannot spend the budget retrying all day.
- **Budget**: the pass consults the same daily token ledger as extraction before
  it claims, and records its usage afterwards.
- **Post-extraction activation**: when `curate` is on, the extractor hands the
  candidates it just stored to `memory.curation.activate` in the same run, and a
  backlog left from before the switch was turned on is drained in later runs.
- **Malformed answers change nothing**: the parser accepts only the fixed shape,
  and the host validates and caps it anyway.
- **Logger**: result codes and counts only.

## 6. Renderer (A3)

- **Settings → Global AI → Learned memory**: one row, "Curate learned memory",
  with a description that says notes will be changed and archived automatically
  and can be undone from "recently curated", and that turning it on for one
  device is recommended. Disabled until a learning model is chosen.
- **Memory manager**: a "Recently curated" block, collapsed by default, whose
  title line reads "N automatic changes in the last 7 days". Expanded, it lists
  each batch: the operation, the note before and after, the reason, and an
  **Undo** button. A conflict shows "this memory changed after the automatic
  pass" and reloads.
- **Suggestions tab**: hidden while `curate` is on, because there is nothing
  waiting for a decision.
- All strings go through i18n in every locale.

## 7. Verification

Development-level (what this branch ran):

| Area | Check |
|---|---|
| Prompt rule | `packages/agent-runtime` tests, `learned-memory.test.ts` |
| Host | `cargo test -p host-core`, every `memory::curation_tests` case plus the existing memory, config-sync, and migration suites |
| Electron main | the extraction and curation service unit tests, with `completeOneShot` injected; no real provider |
| Renderer | component interaction tests for the settings row, the list, undo, and the conflict message; eslint on the changed files |
| Docs | link and command check, `git diff --check` |

Before pushing: `pnpm build:js`, `pnpm typecheck`, `pnpm lint`, `pnpm -r
--if-present test`, `cargo fmt --check`, `cargo clippy -p host-core
--all-targets`, and the task-candidate E2E
`E2E-MEMORY-auto-curation-applies-and-undoes`.

## 8. Risks

| Risk | Mitigation | Residual |
|---|---|---|
| A wrong merge loses detail | archive is recoverable, the revision record keeps the wording, the cap bounds one pass | the user never opens "recently curated" |
| Injected content becomes durable | only the user's own messages are read; credential detector, tombstones, and exclusion list still apply; the record shows provenance | one human review step fewer |
| Undo, then the same cleanup returns | rejection table keyed by the target set | a different set can still produce a similar merge |
| Two devices curate at once | the help text recommends one device; near-duplicates converge on the next pass | two notes can briefly coexist |
| Cost | off by default, one pass per scope per day, 24 KiB in and 8 items out, the shared daily ledger | none beyond the ledger |
| An older app cannot open the new schema | the existing schema-version policy and the migration test | downgrade is unavailable |

## 9. Relationship to the archive and employee layers that landed first

This plan was written against a v26 base. Three steps landed on `main` while it
waited, and the rebase resolved each rather than replaying the old plan:

- **schema version**: this branch now takes the next free version after main's
  v40 and adds `memory_curation_migration.rs` as the v40 -> v41 step. The
  conversation archive landed earlier as v29 and keeps its own version.
- **`LearnedMemorySettings`**: the archive layer's `archive` and this layer's
  `curate` are both device-local fields of the same object, so the merge is
  additive and neither rewrites the type.
- **`memory/secrets.rs`**: untouched here; the archive layer owns it.
- **daily budget**: both spend `memory.extraction.budget`; each records what it
  actually used, so the ceiling is shared without either counting the other's
  runs.
- **the `bot` scope (v39)**: employee lessons are learned memory in a scope this
  pass does not own. The host refuses that scope at every entry point, and the
  dirty marker skips it, so the employee layer keeps writing while this feature
  never queues or changes a lesson.
