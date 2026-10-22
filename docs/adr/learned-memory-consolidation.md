# ADR learned-memory-consolidation: Consolidation proposals and review for learned memory

- Status: Proposed (decision id assigned on acceptance)
- Date: 2026-10-19
- Amends: ADR agent-long-term-memory (D668) §3 write paths, §5 read path, §8 scope
- Related: ADR 0323 (background model work stays off the critical path)
- Implementation plan:
  [learned-memory-consolidation-plan](../project/learned-memory-consolidation-plan.md)

## Context

Learned memory v1 (D668) stores typed notes with provenance, compare-and-set
revisions, and tombstones. A frozen session-start index (40 lines / 6 KiB)
carries them into a session, and optional extraction only creates suggestions
the user confirms. Once a note is active, nothing looks at it again, and that is
how memory goes stale:

- **A changed mind keeps both notes.** "Deliver after a full download check"
  and, later, "deliver after a metadata check only" are two active notes with
  different fingerprints. Both enter the index. The prompt contract says notes
  may be stale, but it does not say which of two conflicting notes wins.
- **Facts about the environment rot silently.** A host, port, path, or
  procedure recorded as a `fact` or `reference` keeps its date, but nothing ever
  asks whether it still holds. Facts also age at different speeds: an address
  or a version can change within weeks, while the purpose of a service rarely
  changes.
- **"Edited" is not "confirmed".** A note carries `created_at` and
  `updated_at`. Neither records when anyone last checked that the note is still
  true. Curated knowledge bases keep the two apart, and they set the review
  interval by how volatile a fact is: about a month for volatile facts, a
  quarter for mixed ones, and never by age for stable ones.
- **Near-duplicates crowd the index.** The same preference worded three times
  passes the exact-fingerprint deduplication and takes three of the 40 index
  lines.
- **The schema has a successor link nobody writes.** `superseded_by` exists in
  `memory_entries`, but no code path sets it. It does not travel through
  configuration sync either: entry ids are device-local, and `SyncedEntry`
  carries no id.
- **"Unused" is not a staleness signal.** Search hits update `last_used_at`;
  index injection does not (ADR agent-long-term-memory §5). A note that is
  useful because it is always in the index therefore looks unused.

Automatic activation of extracted memories was rejected for v1 to guard
against poisoning and over-generalization. The same reasoning applies to a
background pass that rewrites notes. On 2026-10-19 the user made four
decisions:

- Consolidation results are proposals the user confirms; none applies itself.
- Facts are reviewed on a per-note interval, and the default is 90 days.
- Each note shows when it was last confirmed.
- Review is a list the user opens. It never pushes cards into the inbox.

## Decision

### 1. Merge and replace are proposals, not edits

A consolidation pass never changes a note. Instead it files **proposals**,
which the Suggestions inbox lists next to extracted suggestions. Accepting a
proposal is the only way it changes memory. Dismissing one changes no note; it
only records the dismissal.

| Kind | Accepting it |
|---|---|
| `merge` | creates one new `active` note from 2–5 `active` notes of the same scope and kind, then archives those notes and sets their `superseded_by` to the new note |
| `replace` | archives 1–3 older `active` notes that a newer `active` note of the same scope and kind contradicts or restates, and sets their `superseded_by` to the newer note |

No proposal deletes anything. Deleting stays the user's own action, and it
still writes a tombstone. Every accepted proposal ends in an archive, and
"Restore" in the manager reverses an archive, so an accepted proposal can
always be undone.

### 2. Review is a list with per-note intervals

Review needs no model, files no proposal, and never adds a card to the inbox:

- **Intervals.** Every `active` `fact` and `reference` has a review interval:
  30 days, 90 days, or never. The default is 90 days. Preferences and feedback
  have no review interval. A preference stays true until the user says
  otherwise, and `replace` is how that change is handled.
- **Last confirmed.** Each `fact` and `reference` shows "Last confirmed" in the
  manager. The date is the latest of three events on this device: the note's
  creation, the user's last edit of it, and the user's last "Still true". A
  sync apply and a background pass never move it.
- **Needs review.** A note needs review when its last-confirmed date plus its
  interval lies in the past. The manager's Notes tab offers a "Needs review"
  filter with a count. The Suggestions tab shows one quiet line, "N notes need
  review", that opens that filter. Nothing else announces it.
- **Actions.** A note in that list offers "Still true", which records the
  confirmation now and lets the user choose the next interval (30 days,
  90 days, or never). It also offers Edit and Archive, as everywhere in the
  manager.
- **Volatility hints.** When the consolidation switch is on (§4), a pass may
  mark a `fact` or `reference` as volatile, for example an address, port,
  version, or credential location. The host then sets that note's interval to
  30 days. It does this only if the user has not chosen an interval for that
  note. A hint changes no content and never shortens an interval the user set.

Review state lives only on the device, in a new table keyed by entry id. It is
available without the consolidation switch, because it is only a view and costs
nothing.

### 3. The host validates and applies proposals

Proposals live in a new device-local table, `memory_proposals` (host schema
v27). Each row holds:

- the scope, the proposal kind, the target notes, and each target's `revision`
  at filing time;
- for a `merge`, the proposed content, kind, and rationale; for a `replace`,
  the successor note;
- a fingerprint, a status (`pending` | `accepted` | `dismissed` | `stale`), and
  the filed and decided timestamps.

When a proposal is filed, the host refuses it unless all of these hold:

- Every target is `active` and belongs to the proposal's scope. All targets
  share one kind. A `merge` names 2–5 targets and a `replace` names 1–3. A
  `replace` successor is `active`, belongs to the same scope and kind, and is
  newer than every target.
- Merged content passes every write rule of ADR agent-long-term-memory §3: the
  1 KiB limit, the credential detector, and the exclusion list. A merge whose
  fingerprint matches a tombstone is dropped, so a pass can never bring back a
  deleted note.
- Provenance is inherited, never invented:
  - A merged `preference` or `feedback` cites the union of its targets' source
    messages (at most 16) and keeps `evidence = user_stated`.
  - A merged `fact` or `reference` keeps the weakest evidence among its
    targets.
  - The merged note takes the strongest origin among its targets (`explicit` >
    `user_ui` > `extracted`). Merging therefore never demotes a note the user
    wrote, and never promotes one the user did not write.
  - A merged `fact` or `reference` takes the shortest review interval among its
    targets. Its review clock starts at the merge.

Accepting a proposal happens in one transaction that compares and sets every
target's revision. If any target was edited, archived, or deleted after the
proposal was filed, nothing changes: the proposal turns `stale`, and the inbox
says the memory changed in the meantime. Each time the inbox lists a pending
proposal, the host checks it again, so a proposal whose targets have moved on
does not sit in the inbox until someone tries to accept it.

A dismissed proposal keeps its fingerprint, which covers the kind, the target
fingerprints and revisions, and, for a merge, the proposed content. A pass never
files a proposal whose fingerprint was dismissed. Editing a target changes its
revision, so after an edit the next pass may propose something about that note
again.

### 4. When a pass runs

- **Switch.** "Suggest cleanups" (`learnedMemory.consolidate`) is a
  device-local setting and is off by default. It needs the learning model and
  spends the same daily token budget as extraction. It does not require "learn
  automatically", because explicitly remembered notes go stale too. The setting
  recommends enabling it on one device only (§6).
- **Dirty scopes.** A scope becomes dirty when one of its notes is created,
  edited, archived, restored, or deleted, when the user keeps a suggestion in
  it, or when a sync apply changes it.
  - A dirty scope gets at most one model pass per local day.
  - A pass starts only after the app has been idle for 10 minutes, with no turn
    running anywhere.
  - Nothing runs during a turn or at shutdown.
  - A host-owned lease per scope makes a pass idempotent across restarts and
    duplicate triggers, as the extraction cursor does for sessions.
- **Input.** A pass reads the notes changed since the previous pass. For each
  one it adds up to five full-text neighbours of the same kind. It then fills
  the input with the remaining `active` notes, newest first, until the input
  reaches 24 KiB. Each note is sent with its id, kind, origin, dates, content,
  and rationale. No transcript, tool output, or workspace content is sent.
- **Output.** A pass answers with JSON: at most 8 proposals, plus optional
  volatility hints (§2). The host validates every item and silently drops any
  that fails.

### 5. Read path

- The learned-memory section of the system prompt gains one rule: when two
  notes conflict, the newer one wins. This takes effect at the next session
  start, whether or not the switch is on. It covers the time before the user
  accepts a `replace`.
- Archived notes, including superseded ones, are already excluded from the
  index and from `MemorySearch`. That does not change.
- On the device where a proposal was accepted, the manager shows "Replaced by
  …" on each superseded note.

### 6. Sync

The sync format does not change. Accepting a proposal produces only changes
that the existing `learnedMemory` domain already carries: a status change to
`archived`, and for a merge one new note. A device running v0.22.1 therefore
applies them.

Some data never leaves the device: proposals, dismissals, the per-scope pass
state, `superseded_by`, review intervals, and last-confirmed dates. As a result:

- On another device, a replaced note shows as archived, without the "Replaced
  by" link.
- A fact confirmed on one device can still show as needing review on another.

Two devices with the switch on may each propose the same cleanup. If it is
accepted on one device, sync moves the targets' revisions on the other device,
so the other device's copy turns `stale` instead of being applied twice.

### 7. Still out of scope

- Applying any proposal without the user.
- Deleting notes as part of consolidation.
- Detecting stale notes by comparing them with the workspace, as Codex does with
  workspace diffs.
- Embeddings.
- A model-callable tool that updates, archives, or confirms notes.
- Consolidating or reviewing pinned project memory.
- Syncing proposals, `superseded_by`, or review state.

## Consequences

- Conflicting notes no longer stay active side by side indefinitely, and index
  lines no longer go to duplicates.
- Facts are checked at a pace that matches how fast they change, and the user
  can see when each fact was last confirmed. The list never interrupts: the
  user opens it.
- The newer-wins prompt rule improves behavior immediately, at no cost, and
  whether or not the switch is on.
- Cleanup costs review time and model tokens. The cost is bounded: at most one
  pass per dirty scope per day, with 24 KiB of input and 8 proposals per pass.
- Host schema v27 adds `memory_proposals`, the per-scope pass state, and the
  per-note review state. As with every migration, an older app cannot open the
  migrated database.
- Proposals and review state are per device; only their results sync.
- A wrong proposal costs one dismissal. If the user accepts a wrong merge, they
  can undo it by restoring the archived notes and deleting the merged one.

## Alternatives

- **Apply cleanups automatically, with undo.** Rejected by the user's decision.
  This can be revisited once the proposal acceptance rate shows that passes are
  trustworthy.
- **Check for a superseded note synchronously when writing.** Rejected,
  because `MemoryRemember` would have to wait on a model call, and no user flow
  may wait on a model (ADR 0323). A dirty scope plus the newer-wins rule covers
  the gap.
- **Use one review age for every fact.** Rejected. Volatile facts would wait too
  long, and stable facts would be asked about for no reason. Per-note intervals
  keep 90 days as the default.
- **Push review cards into the inbox.** Rejected by the user's decision. Review
  is a list the user opens, with a count.
- **Let facts expire after a fixed age.** Rejected, because notes would be lost
  silently.
- **Use `last_used_at` as the staleness signal.** Rejected, because index
  injection does not count as use, so the most useful notes would look the
  most stale.
- **Store proposals as `suggested` notes.** Rejected. A suggestion is a new
  note, while `merge` and `replace` act on existing notes, so they need targets
  and a compare-and-set accept.
- **Sync proposals and review state.** Rejected. The inbox and the review list
  are per device, the results already sync, and a new synced field would be
  dropped by older builds when they upload again.
- **Store learned memory in a personal Markdown knowledge base.** Rejected for
  the same reasons as the Markdown-directory alternative in ADR
  agent-long-term-memory: it would bypass host validation and tombstones, and
  not every user has such a vault. A `reference` note can point to a page in
  one.
