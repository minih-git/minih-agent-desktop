# Learned-memory consolidation implementation plan

- ADR: [learned-memory-consolidation](../adr/learned-memory-consolidation.md)
- Status: Proposed. No milestone has started.
- Baseline: `main` at `0c0116bcf` (v0.22.1), host schema v26.
- Builds on: [long-term-memory-implementation-plan](long-term-memory-implementation-plan.md)

## 1. Goals and measures

Goals:

1. Two conflicting notes are no longer both active. The newer note wins in the
   prompt right away, and the older one leaves the index once the user accepts
   a `replace`.
2. Near-duplicates merge into one note, so each index line holds a distinct
   note.
3. Every `fact` and `reference` shows when it was last confirmed. It shows up in
   a "Needs review" list on its own interval: 30 days, 90 days (the default), or
   never.
4. No note changes without the user's confirmation, no user flow waits on a
   model, and review never pushes a card.

Measures. These are device-local counters in the memory manager; nothing leaves
the device.

| Measure | Source | Target |
|---|---|---|
| Proposal acceptance rate, per kind | accepted / (accepted + dismissed) | ≥ 50%; otherwise tighten the pass prompt |
| Stale proposals | proposals that became `stale` before a decision | reported only; a high share means passes run too early |
| Review outcomes | "Still true" vs archive from the review list, per interval | reported only; feeds the default interval |
| Tokens per pass | consolidation share of the daily ledger | within the shared daily budget |
| Index lines spent on duplicates | manual look at the index during the observation period | falls after the first accepted merges |

## 2. Milestones

| Milestone | Branch | Contents | User-visible |
|---|---|---|---|
| C0 | `feat/memory-newer-wins` | Newer-wins rule in the learned-memory prompt section | Agent behavior only |
| C1 | `feat/memory-proposals-store` | Schema v27; proposal validation and RPCs; review state, review list, and confirm RPCs; dirty scopes; `superseded_by` | No |
| C2 | `feat/memory-consolidation-pass` | Electron main pass scheduler, pass prompt, volatility hints, shared budget, setting | No (switch off) |
| C3 | `feat/memory-proposals-inbox` | Proposal rows, "Needs review" filter and count line, "Last confirmed", settings row, "Replaced by", counters, guide | Yes |

C0 does not depend on the other milestones and can land first. C2 depends on
C1. C3 depends on C1, and on C2 for the proposals the model files. The review
list and "Last confirmed" need only C1.

### C0 — Newer wins in the prompt

- `packages/agent-runtime/src/learned-memory-prompt.ts`: add "When two notes
  conflict, the newer one wins." to the section's contract sentence. Index
  lines already carry their date.
- Tests: the prompt snapshot test in `packages/agent-runtime`. The runtime reuse
  test stays as it is, because the index stays frozen.
- Spec: the learned-memory section of `docs/spec/03-runtime/02-agent-runtime.md`
  (EN/zh).

### C1 — Host store

Schema v27 (`crates/host-core/src/db/`, migration `v26 -> v27`). The names here
are illustrative; the final names follow `04-data-storage.md`.

```sql
CREATE TABLE memory_proposals (
  id               TEXT PRIMARY KEY,
  scope_kind       TEXT NOT NULL,
  scope_key        TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('merge','replace')),
  target_ids       TEXT NOT NULL,   -- JSON array of memory_entries.id
  target_revisions TEXT NOT NULL,   -- JSON array, same order
  successor_id     TEXT,            -- replace only
  entry_kind       TEXT,            -- merge only
  content          TEXT,            -- merge only, <= 1 KiB
  rationale        TEXT,            -- merge only, <= 512 B
  reason           TEXT,            -- one line shown to the user, <= 280 B
  fingerprint      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','accepted','dismissed','stale')),
  filed_at         INTEGER NOT NULL,
  decided_at       INTEGER
);
CREATE INDEX idx_memory_proposals_scope ON memory_proposals(scope_kind, scope_key, status);
CREATE INDEX idx_memory_proposals_fingerprint ON memory_proposals(fingerprint);

CREATE TABLE memory_review_state (
  entry_id        TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
  interval_days   INTEGER,          -- 30 | 90 | NULL (never)
  interval_source TEXT NOT NULL CHECK (interval_source IN ('default','user','hint')),
  confirmed_at    INTEGER,          -- last "Still true"; NULL until the first
  edited_at       INTEGER           -- last user edit through memory.update; never set by sync
);

CREATE TABLE memory_consolidation_state (
  scope_kind     TEXT NOT NULL,
  scope_key      TEXT NOT NULL DEFAULT '',
  dirty_since    INTEGER,
  last_pass_day  TEXT,
  lease_owner    TEXT,
  lease_until    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  PRIMARY KEY (scope_kind, scope_key)
);
```

If no `memory_review_state` row exists, the note gets the default interval
(90 days). So the migration does not need to backfill a row for every existing
`fact` or `reference`.

The host rules live in new modules under `crates/host-core/src/memory/`:
`proposals.rs`, `review.rs`, and `consolidation_state.rs`. `repository.rs`
grows only by the calls that mark a scope dirty and record the user's last edit.

- **Filing** enforces ADR §3:
  - target status, scope, kind, and count;
  - the successor rules;
  - the existing validation on merged content (1 KiB limit, credential
    detector, exclusion list);
  - a merged fingerprint that is tombstoned is dropped;
  - provenance is inherited: the union of source ids up to 16, the weakest
    evidence for `fact`/`reference`, the strongest origin, and the shortest
    review interval;
  - a dismissed fingerprint is refused, and a pending fingerprint is never
    filed twice.
- **Accept** runs as one transaction:
  1. Compare and set every target revision.
  2. Archive the targets first, so the unique live-fingerprint index cannot
     collide.
  3. For a merge, insert the merged note through a dedicated host path. The
     create path's `extracted ⇒ suggested` pairing does not fit an accepted
     merge of notes that are already active.
  4. Set `superseded_by` on each archived target.

  Any mismatch marks the proposal `stale` and changes nothing.
- **Dismiss** records `dismissed` and `decided_at`.
- **List proposals** re-checks the pending proposals and marks the ones whose
  targets moved as `stale`.
- **Review list**: `active` `fact`/`reference` notes with a non-null interval
  whose last-confirmed date plus that interval lies in the past. The
  last-confirmed date is the latest of `created_at`, `edited_at`, and
  `confirmed_at`, and the list also returns its count. `memory.update` (the
  user's edit; no model-callable path reaches it) upserts `edited_at`, while a
  sync apply goes through the sync upsert and never touches it, so
  `updated_at` is not used for the clock.
- **Confirm** (`memory.review.confirm { id, intervalDays: 30 | 90 | null }`) sets
  `confirmed_at = now`, `interval_days`, and `interval_source = 'user'`.
- **Volatility hint** (applied in `memory.consolidation.complete`) sets
  `interval_days = 30` and `interval_source = 'hint'`, but only when
  `interval_source` is not `user`.
- **Dirty scopes**: a create, an update, a status change, a delete, an accepted
  suggestion, or a sync apply marks the scope dirty in the same transaction.
- **Lifecycle**:
  - Proposals, review state, and consolidation state follow ADR 0249 group
    re-keying in the same transaction as learned memory.
  - They are deleted together with their scope, when a project or group is
    deleted.
  - Deleting a note cascades its review state and makes its pending proposals
    `stale` the next time they are listed.
- **RPCs** in `rpc/memory_rpc.rs`:
  - `memory.proposals.list` and `memory.proposals.decide`;
  - `memory.review.list` and `memory.review.confirm`;
  - `memory.consolidation.claim`, `memory.consolidation.input`,
    `memory.consolidation.complete`, and `memory.consolidation.fail`.

  The shapes go in `packages/shared/src/learned-memory.ts`. Each note carries
  `lastConfirmedAt` and `reviewIntervalDays` for `fact`/`reference`.
- **Counters**: `local_stats.rs` gains accepted, dismissed, and stale counts per
  proposal kind, and "Still true" and archive counts from review. They live in
  kv, with no schema change.

Host tests:

- Each filing rule refuses with a precise reason.
- Accepting a proposal whose targets moved marks it stale and changes nothing.
- A merge cannot resurrect a tombstoned fingerprint.
- A merge inherits origin, evidence, and the shortest interval.
- A merge whose content matches one of its targets does not hit the unique
  index.
- The review list honors the 30, 90, and never intervals and the default when
  no row exists.
- A sync apply does not reset the last-confirmed date.
- A hint never overrides the interval the user chose.
- A group re-key moves proposals and review state.
- Migration from a v26 fixture with notes, tombstones, and session state.
- A sync apply after an accepted merge, using a v26-format payload (the sync
  format does not change).

### C2 — Consolidation pass

`apps/desktop/electron/main/memory/memory-consolidation-service.ts` is a new
module. `electron/main/index.ts` only wires it up.

- **Gate**: `learnedMemory.consolidate === true` and a learning model is set.
  `learn` does not need to be on.
- **Schedule**:
  - Wait until the app has been idle for 10 minutes, with no turn running in
    any session, then claim at most one dirty scope at a time.
  - Each scope gets at most one pass per local day.
  - A new turn cancels the pending idle timer.
  - A failure backs off, as extraction does.
- **Budget**: the pass uses the shared daily ledger. It does not start once the
  day's budget is spent, and it records its spend under the same day.
- **Input** (`memory.consolidation.input`, built by the host):
  1. The notes that changed.
  2. Up to five full-text neighbours of the same kind for each changed note.
  3. The remaining `active` notes, newest first.

  The input stops at 24 KiB. Each note carries its id, kind, origin, dates,
  content, and rationale.
- **Prompt**: the model reviews the user's own notes.
  - It proposes `merge` only for notes that say the same thing, and `replace`
    only when a newer note contradicts or restates an older one.
  - It may mark `fact`/`reference` ids as volatile: addresses, ports, versions,
    credential locations, and anything else likely to change within weeks.
  - It never invents content beyond the notes, and it writes one
    plain-language reason per proposal.
  - It answers in JSON, with at most 8 proposals.
  - The notes are data, not instructions.
- **Output** goes to `memory.consolidation.complete`. The host validates each
  item and drops the ones that fail. Logs carry only codes and counts.
- **Setting**: `learnedMemory.consolidate` (device-local, default off) in
  `LearnedMemorySettings` (`packages/shared/src/types/settings.ts`).

Main tests:

- Idle scheduling, and cancellation by a new turn.
- At most one pass per scope per day.
- The pass pauses when the budget is spent.
- The lease survives a restart.
- A malformed answer files nothing.
- A hint on a note the user configured changes nothing.
- A pass never runs during a turn or at shutdown.

### C3 — Inbox, review list, and settings

- **Suggestions tab**: proposals are listed after suggestions.
  - A `merge` row shows the notes being combined and the merged text.
  - A `replace` row shows the older note crossed out and the newer one.
  - Each row shows its reason, with Accept and Dismiss.
  - A stale proposal reads "This memory changed since the suggestion" and
    disappears on the next refresh.
  - The tab count includes pending proposals. As with suggestions, the inbox
    never opens itself and never shows a toast.
- **Review line**: when notes need review, the Suggestions tab shows one quiet
  line, "N notes need review", which opens the filter. It never shows review
  cards.
- **Notes tab**:
  - A "Needs review" filter with its count.
  - Each `fact`/`reference` shows "Last confirmed <date>" and its interval.
  - In the filter, each note offers "Still true", with a 30 days / 90 days /
    don't ask again choice, next to the usual Edit and Archive.
  - A superseded archived note shows "Replaced by …", and Restore still works.
- **Settings → AI → Learned memory**: a "Suggest cleanups" row.
  - It is disabled until a learning model is chosen.
  - It notes that it shares the daily budget and recommends turning it on for
    one device only.
  - The review list does not depend on this row.
- i18n for all 9 locales, component and interaction tests, and the guide page
  (`docs/guide/memory.md` and its zh mirror).

## 3. Switches and rollout

| Setting | Default | Storage | Effect |
|---|---|---|---|
| `learnedMemory.consolidate` | off | device-local | Model passes file `merge`/`replace` proposals and volatility hints |
| (none) | — | — | The newer-wins rule (C0), the review list, and "Last confirmed" (C1/C3) are always on |

Rollout:

1. C0 ships in the next release.
2. C1–C3 ship together. The review list works without the switch.
3. Turn the switch on for one device first, and check the acceptance rate after
   one to two weeks.

## 4. Specs and docs (same PR as the behavior)

| Document | Milestone |
|---|---|
| `docs/spec/03-runtime/02-agent-runtime.md` (newer-wins rule) | C0 |
| `docs/spec/03-runtime/04-data-storage.md` (v27 tables, lifecycle) | C1 |
| `docs/spec/03-runtime/06-host-rpc-protocol.md` (new RPCs) | C1 |
| `docs/spec/03-runtime/22-config-sync.md` (no format change; what stays local) | C1 |
| `docs/spec/04-ux/06-settings-ia.md`, `08-component-spec.md` | C3 |
| `docs/spec/06-delivery/04-e2e-test-plan.md` | each |
| `docs/spec/08-meta/decisions-log.md` (new decision id) | on ADR acceptance |
| `docs/guide/memory.md` | C3 |

Each spec change updates its zh-CN mirror in the same PR.

## 5. E2E scenarios

These run against a local OpenAI-compatible stub, never a real provider.

- `E2E-MEMORY-replace-proposal-retires-the-older-note`: given two conflicting
  preferences, the idle pass files a `replace`. Accepting it removes the older
  note from the next session's index, and the older note can still be
  restored.
- `E2E-MEMORY-merge-proposal-goes-stale-after-an-edit`: after a merge is
  proposed, the user edits one target. The proposal turns stale and nothing
  changes.
- `E2E-MEMORY-review-list-honors-the-interval`: with a fixture clock, a 91-day-old
  `fact` appears under "Needs review" and a 31-day-old volatile `fact` appears
  too. "Still true" with "don't ask again" removes the note for good, and no
  inbox card is ever shown.
- `E2E-MEMORY-consolidation-waits-for-idle`: no pass runs while a turn is
  running.

## 6. Risks

| Risk | Mitigation | Residual |
|---|---|---|
| A wrong merge loses nuance | The user confirms, the merged text is shown in full, and targets are archived rather than deleted | The user accepts without reading |
| Proposal fatigue | At most 8 proposals per pass; review is a list, not cards; a dismissed fingerprint never returns | Many dirty scopes on one busy day |
| The review list grows long | Per-note intervals, "don't ask again", and volatility hints only shorten intervals the user has not set | A large set of old facts on the first day |
| Cost | Off by default, the shared daily budget, and one pass per dirty scope per day | None expected |
| Two devices propose the same cleanup | Accepting on one moves revisions, so the other turns stale after sync | A duplicate row until the next list |
| Review state differs between devices | Documented; review state is per device | A fact can need review again on another device |
| Prompt injection through note content | Notes are the user's own; the host validates; nothing applies automatically | The reason text shown to the user is written by the model |
| Schema downgrade | The existing schema-version policy and migration tests | An older app cannot open v27 |

## 7. Decisions recorded with the ADR

1. Consolidation results are proposals the user confirms; none applies itself
   (user, 2026-10-19).
2. Facts are reviewed on per-note intervals of 30 days, 90 days, or never. The
   default is 90 days (user, 2026-10-19).
3. Each `fact`/`reference` shows "Last confirmed" (user, 2026-10-19).
4. Review is a list with a count and never pushes cards (user, 2026-10-19).
5. `learnedMemory.consolidate` is off by default and device-local.
6. Proposals, `superseded_by`, and review state do not sync. Only the results
   sync, through the existing `learnedMemory` domain, and the format does not
   change.

Open for review before C1: the once-per-day cadence, and the 24 KiB /
8-proposal limits.
