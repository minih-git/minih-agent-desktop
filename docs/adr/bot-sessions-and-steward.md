# ADR bot-sessions-and-steward: Bot sessions, the steward, and the mandate

- Status: Accepted (2026-11-10, D687)
- Date: 2026-11-10
  [ADR 0239](0239-session-collaboration-messages.md),
  [ADR 0237](0237-session-orchestrator-as-a-plugin.md),
  [ADR 0023](0023-independent-conversation-session-fork.md),
  [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md),
  [ADR 0329](0329-session-worktree-isolation.md),
  `03-runtime/04-data-storage.md` §4.6c, §4.19,
  `03-runtime/10-session-state-machine.md` §6

## Context

The product is chat-first: a person talks to their computer and work happens.
What is missing is an *employee*: someone the person addresses by name, who
keeps memory across weeks, who decides what a sentence actually asks for, and
who reports back inside the same conversation.

Every substrate that shape needs already exists, and none of it was designed
for it:

- a durable session with its own project, model, permission mode, transcript,
  context compaction and memory scopes;
- a durable, host-owned collaboration ledger with idempotent deliveries,
  completion receipts and a permission ceiling (ADR 0239);
- built-in `SessionList/Send/Result/Create` tools that let one session address
  another (D663, D672), currently local-only;
- subagent definitions with a tool allow-list and a permission scope
  (ADR 0062), which is exactly the shape of a persona plus a capability
  boundary;
- isolated worktrees per session (ADR 0329);
- an approval card and a structured question card already rendered in the
  transcript.

What does not exist is a durable *identity* for an employee, a frozen record of
what the person actually authorized, and a stage vocabulary the person can read
at a glance. Three concrete failures follow from that gap:

1. **Nothing distinguishes a bot from a conversation.** A session is a session.
   Any list, search, tray menu or "recent" surface treats an employee like a
   chat that can be renamed, deleted, or buried — deleting it silently
   destroys the employee's continuity.
2. **Authorization is prose.** Once a delegating agent has a task in hand, the
   only record of scope is text in a prompt. A later turn cannot tell whether
   pushing was authorized, whether the criteria changed, or whether this task
   is still the one the person approved. ADR 0239's ledger records delivery,
   not authorization.
3. **Progress has no vocabulary.** A task is `queued/running/completed/failed/
   cancelled/interrupted` (the ledger's delivery status). That answers "did the
   turn finish", never "am I the one holding it up" — which is the only thing
   a person supervising several employees can act on.

The prototype `dsh-superagent-prototype` (deepseek-ai, 8c32a9d, a single-host
single-employee research prototype) settled the vocabulary for (2) and (3) that
this product inherits: a two-layer evaluation, a four-value decision, a
six-value report, and a stage table where only person-owned stages disturb the
person. Those are adopted as-is rather than re-derived, because a supervisor's
cues should not read differently in two products by the same author.

Alternatives considered:

1. **Bots as subagent definitions only.** No new identity: a "bot" is a
   definition plus a `Task` call. Cheapest, and it fits the existing tool. But a
   subagent is bounded to one parent turn, has no durable conversation, cannot
   be addressed later, and cannot hold memory across tasks — none of which is
   an employee.
2. **Bots as a new first-class table.** A `bots` table with its own lifecycle,
   and a session per assignment. Cleaner in the abstract, but it duplicates
   session configuration, project binding, permission ceilings and transcript
   ownership in a second place, and ADR 0239 already made the session the unit
   of identity and delivery. Two identities for one worker is the duplication
   ADR 0023 and 0239 both refused.
3. **Authorization as a transcript message.** A structured "task card" message
   in the target session, with no ledger record. Visible, but nothing durable
   outlives transcript compaction or replacement, and the permission ceiling
   check at turn admission would still have no scope to enforce.
4. **Everything at once, including cross-host dispatch.** Rejected as an
   ordering error: cross-host delivery is a protocol change (new RACP
   operations, capability negotiation, receive policy on the executing machine)
   that would be designed against a Mandate shape nobody had used yet. The
   local shape has to exist and be exercised first.

## Decision

### 1. A bot is a long-lived Agent session with an explicit role

A bot is **not** a new entity. It is a durable session whose `role` is `bot`
and which carries a `botProfile`. The session remains the only session
identity, and the ledger remains the only delivery identity, exactly as
ADR 0239 requires.

- `role` is `user | bot`, defaulting to `user`. Only `bot` is accepted today;
  any other stored value fails closed on read rather than being guessed.
- `botProfile` carries `name`, `avatar`, `duty`, `homeHostId` (nullable),
  `permissionMode` (`inherit | ask | accept-edits | auto`), `mustAsk` (a
  subset of `push | merge | deploy | delete | spend | criteria-change`), and
  `observe`.
- `observe` is **required and defaults to true**. A new bot records what it
  would have done and does not start work until the person switches it to
  `auto-start`. This is the prototype's rule, kept because a bot that starts
  acting on day one is the one failure mode that cannot be undone by a setting.
- A bot's persona (name, description, prompt, tools, model) continues to come
  from its subagent definition. `botProfile` stores what a definition cannot: an
  operating identity that outlives every turn, plus the person's current
  willingness to let it act.
- A bot session cannot be deleted from an ordinary session list; it is
  "dismissed" through bot settings with a second confirmation, and its memory
  retention is a separate choice. Rename, model, project, and permission-mode
  changes remain ordinary session operations.
- **The name is the employee's own.** `botProfile.name` is what every surface
  shows, and `bot.update` keeps `sessions.title` equal to it, so one rename
  reaches the sidebar, the workbench rows, the task card's heading and the task's
  origin chip through the existing `botsChanged` event. No surface writes the
  role's name into copy: those labels interpolate it, and fall back to the
  default only when no steward exists yet. The steward's default name is
  `Super Agent` — the internal definition id stays `steward`, and so do the
  permission, tool and prompt rules — and schema v35 → v36 renames rows that
  still carry the previous default in both places, never a name the person
  chose.
- `homeHostId` is display and routing intent only. It is never proof of
  locality and never an authorization. Nothing in this ADR resolves a bot to a
  host; that is a later, cross-host decision.

### 2. The steward is a bot with no side-effecting tools

The steward is a built-in bot, defined like any other subagent definition, and
it owns exactly one capability set. As shipped in employee mode 0.5 slice 3
(§"Steward roster, briefing and wake-ups") that set is `Roster`, `TaskCard`,
`SessionSend`, `SessionResult` and `TaskStatus`; the `SessionList` and
`SessionCreate` it started with were removed, because picking a person by session
title is what made it dispatch to the wrong one. It has no `Write`, `Edit`,
`Bash`, network-write, browser, plugin, or MCP tool, and it does not receive
inherited tools.

The boundary is structural, not declarative: the tool allow-list is enforced by
the same delegate-scope check that already keeps a read-only subagent
read-only, so a steward that somehow asks for `Write` is denied rather than
trusted. The steward also has no tool that reads another session's transcript;
it sees structured reports and bounded summaries only, which keeps its context
bounded and keeps an injection in a worker's reply from reaching a component
that can dispatch work.

### 3. A task card freezes into a Mandate

The steward decides what a sentence asks for (two-layer evaluation: a
deterministic gate on who is speaking to whom, then a model assessment of what
to accept, split, and address to whom) and emits one **task card** per task
through its tool, not by parsing free text.

The card becomes a **Mandate** at the moment the person confirms it. The
Mandate is then the authorization of record: immutable, stored on the ADR 0239
ledger entry that carries the work, versioned (`version: 1`), and bounded
(encoded size, criteria and boundary counts, goal and source-utterance
lengths). Its shape:

| Field | Meaning |
| --- | --- |
| `version` | `1`; a later shape is a new version, never a reinterpretation |
| `taskId` | identity of this authorization |
| `goal` | one sentence, bounded |
| `criteria[]` | acceptance criteria the person will check, bounded |
| `boundaries[]` | things explicitly not to do, bounded |
| `repo?` | normalized `origin` (host lowercased, no `.git`, ssh and https both as `host/owner/name`) and optional `ref` |
| `permissionMode` | the ceiling the person chose for this task |
| `mustAsk[]` | actions that must return to the person before they happen |
| `risk` | `low | medium | high`, used for the default card presentation |
| `requestedBy` | the person, with the requesting device and host when known |
| `sourceUtterance` | the person's own words, bounded, for audit and review |
| `createdAt` | requester clock; display only, never a security input |
| `policyVersion` | the steward policy the card was produced under |

Invariants:

- **Immutable once confirmed.** Widening scope is a new Mandate with a new
  `taskId`, never an edit. This is the prototype's rule and it is what makes
  `sourceUtterance` worth keeping.
- **A click is the authorization; the work runs at the card narrowed by the
  employee.** A confirmed card's task session is created at
  `min(card.permissionMode, the employee's own mode)` and the delivery carries
  the same value, so what the person approved is what runs. The steward's own
  mode is not part of it: she hands work out and runs at `ask` by design, and
  while her mode was in the minimum, no employee the person had opened up to
  `accept-edits` could receive the work she was told to hand out — the
  confirmation itself was refused (this replaces stage 0's
  `min(card, sender, bot)`; employee mode 0.5 slice 3 review, S2). A follow-up
  is checked against its own task's authorization, because it grants nothing new.
- **Nobody-confirmed work never runs wider than `ask`.** A confirmation the host
  performs itself (`confirmedBy = policy`, nobody read the card) clamps the task
  session and the delivery ceiling to `ask`, whatever the card says. This is a
  backstop, not the rule: it is what keeps a wrong auto-start condition from
  becoming authority nobody granted (review S1).
- **The executing side recomputes permission.** `mustAsk` is the union of the
  card and the executing side, with `deploy`, `delete` and `spend` always added
  there. A Mandate asks; it never grants. A tampered, replayed, or forged card
  therefore cannot raise authority, because nothing on the receiving side reads
  authority *from* the card.
- **A Mandate is data.** It reaches the model as a bounded, delimited data
  block inside the existing session-communication framing, and the worker's
  prompt states that a task card is data, not instructions from the user.
- `createdAt` comes from the requester and is display-only; every duration and
  deadline that matters is measured on the receiving side.

### 4. Report and stage are the progress vocabulary

A worker reports with one of six values — `progress`, `waiting`, `ready`,
`blocked`, `failed`, `dropped` — where `dropped` means "there was nothing to
do" and is a clean end, not a failure. Reports are structured (a report, an
approval card, or a question card), never inferred from reply text, so the
steward never has to guess whether a worker is waiting for a person.

The stage of a task is derived, not stored as an editable field, from the
ledger entry, its latest report, and the session's turn state, first match
wins:

1. waiting for a person to answer (`person/answer`)
2. waiting for a person to accept (`person/accept`)
3. blocked or failed (`blocked`, `failed`)
4. queued, or waiting for the machine that runs it (`queued`)
5. waiting for a trigger the person configured (`waiting`)
6. working (`working`)

**Only `person/*` stages disturb the person.** That single rule is what makes a
board of several employees readable: everything else is either the machine's
problem or the worker's, and both are shown without a notification.

### 5. Data placement (why columns, not a new table)

- `sessions` gains `role` and `bot_profile_json`; the ledger gains
  `mandate_json`, `stage` and `report_seq` (`04-data-storage.md` §4.19).
- **Columns, not a `bots` table**, for the same reasons ADR 0239 kept one
  ledger: a bot is a session, so its identity cannot diverge from the session's;
  and the Mandate belongs to the delivery, so it cannot diverge from the
  delivery's target, ceiling, and turn binding. A separate table would need a
  second foreign key to keep those in step, which is a constraint the schema
  would have to enforce anyway.
- **A column, not a row in `kv`**, because `botProfile` is read with every
  session row a list query returns; a side lookup per row would put a join into
  the most frequently served query in the product.
- **`stage` and `report_seq` are stored, not computed on read.** Stage is
  written by the same transaction that settles a report, because it will be a
  filter and an index target once several employees are listed together, and
  `report_seq` is the monotonic counter that makes an out-of-order or duplicated
  report ignorable. Neither is ever edited by a client.
- **The Mandate is opaque to the host.** Rust stores, scopes, and returns the
  encoded value; its shape, its bounds and its invariants live in one shared
  module so the renderer, Electron main, the plugin gateway and a later
  cross-host protocol validate the same thing once.
- Every one of these additions is nullable or defaulted, and they arrive as an
  ordered schema step, **v30 -> v31** (`migrate_v30_to_v31`), like every other
  structural change since v8. Pre-existing sessions read as `user` with no
  profile, and pre-existing ledger entries have no Mandate, no stage, and
  `report_seq = 0`.

### 6. Explicitly out of scope

- **Cross-host dispatch.** Delivering a Mandate to a bot on another machine, a
  receive policy on the executing machine, offline queuing, reconciliation, and
  delivery idempotency across hosts belong to a later `cross-host-collab`
  decision, which amends ADR 0239's single-machine assumption and extends ADR
  0331's protocol. Nothing here presumes it.
- **Bot and device memory scopes**, the steward's prompt, the task-card UI,
  push notifications, and the board are separate changes. This decision fixes
  the identity, the authorization record, and the vocabulary they consume.
- **Automatic routing.** The first version dispatches a task only when exactly
  one bot matches; anything ambiguous returns to the person.

## Consequences

- Employee mode needs no new storage authority, no new process, and no second
  source of truth for identity, delivery, or permission. A bot is a session, a
  Mandate is a delivery column, and a stage is derived from records the host
  already owns.
- A bot's continuity is separate from a chat's: deleting a conversation and
  dismissing an employee are different operations, and only the second is
  offered for a bot.
- `observe` is the default, so the first version of every bot produces cards
  and no work until the person opts in. This is deliberately slower than it
  could be.
- Two vocabularies now coexist and must not be conflated: the ledger's delivery
  `status` answers "did the turn finish", the stage answers "who is holding
  this". A surface that shows one must not read the other as the same thing.
- A frozen Mandate is broader than its delivery: one authorization may cover
  several deliveries (a split task), so the Mandate's `taskId` is not the
  ledger's message id.
- Because authority is recomputed on the executing side, the Mandate's
  `permissionMode` is advisory input. A future reviewer must not "trust the
  card" to close a permission gap.

## Enforcement status

What this decision *requires* and what the shipped code *enforces* are not yet
the same list. Naming the difference is part of the decision: a reader must not
assume a rule is live because it is stated above.

| Rule | Enforced today | Where it lands |
| --- | --- | --- |
| A card's `permissionMode` sets what the task runs at | **Yes** — a confirmed card's task session and its delivery are both created at `min(card, employee)`, and the steward's own mode is not part of it (replaces stage 0's `min(sender, card)`) | shipped |
| Nobody-confirmed work never runs wider than `ask` | **Yes** — a `confirmedBy = policy` confirmation clamps the task session and the delivery ceiling to `ask` | shipped |
| A card can never widen authority | **Yes** — the mode is a minimum of card and employee, a follow-up is checked against its own task's authorization, and a mandate attached to an existing employee session still refuses a target wider than the card | shipped |
| Confirming is a person's click, not a model decision | **Yes** — `TaskCard` has no `confirm` action, `SessionSend` has no `mandate` argument, and only `taskCard.confirm` (Electron IPC, renderer-only) freezes a card | shipped |
| A confirmation cannot approve text nobody read | **Yes** — the confirmation carries the `cardHash` the screen showed, and a revise in between is refused | shipped |
| Work reaches an employee only with an authorization | **Yes** — a delivery to a `role = bot` session needs a confirmed card or a `taskId` naming an open task already dispatched there, else `MANDATE_REQUIRED` | shipped |
| `observe` keeps an employee from starting by itself | **Yes** — the host's auto-start rule reads the employee's stored `observe` and refuses; a person's click still dispatches | shipped |
| An employee runs under its definition, not the session's full catalog | **Yes** — the runtime resolves `botProfile.definition` into a tool ceiling and a prompt, and a name that does not resolve fails the turn | shipped |
| A card draft survives a restart | **Yes** — drafts are a v32 table bound to the steward session, cascading with it | shipped |
| `deploy` / `delete` / `spend` always in `mustAsk` | **Recorded only.** They are merged into every card and every frozen Mandate, but nothing inspects them at tool-execution time | the approval-by-action PR (stage 1) |
| Other `mustAsk` actions (`push`, `merge`, `criteria-change`) | **Recorded only**, same as above | the approval-by-action PR (stage 1) |
| The steward cannot read a worker's transcript | **Yes** — it has no such tool | shipped |
| Task stage derives from structured records only | **Yes** — reports and turn state, never reply text | shipped |

Two consequences worth stating plainly:

- A card that a person confirms as `ask` is dispatched under at most `ask`, but
  "ask" inside a worker is still the *worker session's* own permission mode.
  What the card adds is a ceiling, not a step-by-step approval protocol; that
  protocol is the `mustAsk` work above.
- Auto-start is the host's decision from stored facts, never from the `risk` a
  model typed, and **the mode is never evidence**: `auto` is the widest mode the
  product has — Write/Edit, Bash and plugin tools all run without asking — so
  reading it as "read-only" let a model label a task "research" and have files
  written with nobody watching (review S1). The card has to say
  `readOnly: true`, which itself requires `permissionMode: ask`, and an
  observing employee still never starts by itself. Read-only starts; everything
  that changes something waits for a click. A `policy` confirmation is recorded
  as `policy` and clamped to `ask`, so an audit can tell it apart from a
  person's and a wrong condition cannot become authority nobody granted.

## Compatibility and validation

Schema v30 -> v31 is one ordered, transactional step in the existing migration
chain: it stamps `user_version = 31` only after the last `ALTER TABLE` succeeds,
so a failure rolls back and the next open retries from v30. It is additive —
every statement only adds a defaulted column, no row is rewritten, and existing
sessions keep their exact list/search behaviour — so it is **not destructive and
carries no `pi.sqlite.v30.bak` copy**, which `04-data-storage.md` §7 permits. Each
column is still probed with `pragma_table_info` first, so a file that already
carries some of them (created from the current DDL, or downgraded in place by a
fixture) is completed instead of failing. An older application reading a newer
file is refused by the existing version gate rather than reading the new fields
wrongly.

**The v32 -> v33 rebuild proves what it changed, not what the file contains.** A
long-lived user database arrives with orphan rows from older builds (a 525 MB
v32 file carried 214 781 dangling references). Deleting them needs the person's
authorization and a backup, so this step never touches them: it counts the
violations before and after the rebuild, fails only if the rebuild *added* one,
and asserts the copy kept every session. Refusing on any pre-existing violation
made the application fail to start on every real database while every clean
development file — and therefore every test — passed.

Validation covers: the shared Mandate codec (bounds, unknown fields, version,
normalization), the host storing and returning a Mandate and a stage on a
ledger entry (through the RPC boundary, not only the repository), report-sequence
ordering, and the v30 -> v31 step for a fresh database, a v30 database, a
re-opened database, and a step that stopped before its version stamp. The steward's tool boundary is proved by a later change that asks a
steward-scoped delegate for `Write` and gets a denial.

## Tasks under employees (employee mode 0.5, schema v33)

Decision (2026-11-12). Employee mode 0.5 settles the three-layer model the
prototype `员工模式-0.5-原型` describes: **an employee** is a long-lived person
(a session with `role = 'bot'` and a profile), **a task** is one thing that
employee is doing, and **the steward** is the default entry point that dispatches
work and reports back.

This section fixes the first two and the relation between them. It amends §1 and
§5 above: an employee session is now a **container and a profile**, and it no
longer runs turns of its own. Work runs in a task's own session.

### 1. A task is a session owned by an employee

A task is not a new identity for a worker. It is a row in `tasks` plus one
session (`sessions.role = 'task'`, `sessions.owner_session_id` = the employee),
so it keeps exactly the properties a session already has: one transcript, one
project, one permission mode, one workspace, one place in history.

- `tasks.origin` is `steward` (a confirmed task card) or `direct` (the person
  typing into the employee's workbench). It answers "who started this", never
  "who may do it".
- `tasks.delivery_id` names the ledger delivery that carries the authorization,
  for a steward-dispatched task. A direct task has none: the person's own request
  is the authorization, and no card has to confirm their own sentence.
- `tasks.stage` is the §4 stage vocabulary, written by the host only.
- `tasks.project_id` / `branch` / `source_utterance` record where the task works
  and what it was asked; `workspace_path` is reserved for the worktree slice and
  is not written yet.
- Archived is a timestamp, not a state machine: `tasks.archived_at` and
  `sessions.archived_at` are written together, in one transaction, so a task
  never leaves the sidebar while its session still looks active. Archiving twice
  returns the first stamp instead of failing.

### 2. Inheritance: what a task session takes from its employee

A task session is created through the same helper the plugin's worker `spawn`
uses (`session_collaboration::spawn_session`), so the rule has one
implementation:

- **inherited** — `mode` (`agent`), `thinking_level`, and `permission_mode`. A
  child is never wider than its parent: an employee asking for `ask` produces a
  task that asks.
- **carried by the request** — `project_id`. A task works in the repository it
  was given, and that repository is written to the *session*, because the
  runtime launches the turn in the session's workspace: a project recorded only
  on the task row left the employee working in its own repository while the
  header claimed otherwise. `tasks.project_id` is then read back from the
  session, so the two rows cannot disagree and the task's repository has one
  source of truth. When the request names no project, the employee's own project
  is used, because that is the repository the employee was hired to read.
- **not inherited** — `role`, `bot_profile_json`, and the transcript. A task is
  `role = 'task'` with no profile: it is addressed by its employee, never by
  name, and copying an identity would make two rows claim to be one employee.
- **never re-selected** — the model. A task runs on whatever the employee is
  bound to at creation time, like any other derived session.

### 3. An employee's dot and count come from its tasks

`bot.list` derives an employee's status point and `openTaskCount` from the tasks it
holds, not from a delivery aimed at the employee: waiting on the person wins, then
work in motion, then idle. The employee's own ledger is now empty, so a dot read
from it would always say idle — a bug this rule makes impossible.

### 4. Surfaces (prototype ②, ③)

- Sidebar: each employee row lists its open tasks (title · repository · stage),
  shows the open count, and folds archived ones into one "history (N)" row.
- Clicking an employee name opens its **workbench**: header (duty, model,
  permission, scope), a direct-dispatch field (repository + text, Enter starts),
  and tabs for tasks / done / profile / memory. While the workbench owns the
  center pane the titlebar band names that employee and the surface; it must not
  keep the previous conversation's breadcrumb, rename control, or session
  actions, because every one of them would act on something that is not on
  screen.
- Clicking a task opens its **session**, which shows a header with the task's
  name, employee @ repository, branch, stage, origin and short id. An archived
  task's composer is closed and says so.
- A task session does not appear in "My sessions" or a project group: it is
  entered from its employee.

### 4a. A card's `repo.origin` is not a directory

A card's `repo.origin` is a normalized git remote (`host/owner/name`, see
`normalizeRepoOrigin`), never a filesystem path. Treating it as one created a
phantom project row — visible in the person's project list — the first time a
card was confirmed. It now never reaches the project resolver. Confirming a card
resolves the origin against the remotes of the projects this computer already
knows (`git remote -v`, compared after the same normalization) and passes the
matching checkout; when nothing matches, the employee's own bound project is the
fallback, and when neither exists the confirmation fails with
`REPO_NOT_ON_THIS_COMPUTER` instead of working somewhere else. `repo.ref` still
becomes the branch the task asked for, and the branch it actually got is recorded
separately (`workspace_branch`).

### 4b. A task's stage reaches the interface from one place

The host writes a task's stage inside the transactions that settle, fail or
cancel the delivery bound to it, and those are the only signals Main ever gets.
Every one of them announces through the task-channel writer, which compares the
stage it last announced with the one the host now holds: one move, one event,
no polling, and a settle that changed nothing is silent.

The interface keeps two stage vocabularies apart. `bots.status.*` says what the
*employee* is doing ("busy", "waiting for you") and stays with the employee row;
`bots.taskStage.*` says where the *task* is ("in progress", "ready for review")
and is what the sidebar task row, the workbench card and the task header show.
Sharing one set made a finished task read "waiting for you" and a working one
read "busy". The task map is keyed by the stage union, so a new stage cannot ship
without its own word.

### 4c. A task works in its own folder inside the repository

A task that touches a repository does its work in its own git worktree at
`<top level>/.worktree/<short id>-<slug>`, built by ADR 0329's own machinery
(registry, `.worktreeinclude`, setup command, behind / sync / merge, link-safe
removal) with the placement and start-point differences recorded in ADR 0329's
2026-11 amendment. Three consequences belong to this ADR:

- **Preparation is a step of its own.** `tasks.workspace_status`
  (`none | preparing | ready | failed`) is written by the host: the task row is
  created first, the worktree is prepared outside that transaction (a git command
  cannot be rolled back), and the first turn is only sent once the workspace is
  `ready`. A failure records `workspace_error` — git's message, the setup
  command's own output, a missing repository — and the task can retry in place.
  A task without a repository is `none` and works in its session's own folder.
- **Delivery is decided here, performed later.** `tasks.delivery_mode` is `pr`
  when the project has a GitHub remote, `local` when it has another remote or
  none (ADR 0329's "merge into project"), and `none` without a project. The
  completion card and "accept and merge" belong to slice 4.
- **Archiving is what ends the workspace.** `task.archive` removes the worktree
  and its branch when nothing is left in them, and otherwise refuses with
  `WORKSPACE_HAS_UNSAVED_WORK` and the counts (uncommitted files, unpushed
  commits). Only the task's own commits count: those neither on the ref the
  branch started from nor on the delivery target, so a task that branched from
  `origin/main` while the local branch was behind is not asked to discard the
  remote's commit. A count that cannot be read (the project's branch was renamed,
  the repository is damaged, git timed out) refuses the archive with
  `WORKSPACE_UNSAVED_UNKNOWN` rather than treating the failure as zero — an
  unknown answer must not delete commits that exist only on this machine. The
  person's second click (`discard`) removes them anyway. A
  successful removal leaves `workspace_status = 'none'`; one that fails does not
  roll the archive back — the task records the pending cleanup and ADR 0329's
  orphan pass finishes it.

### 5. What this section does not do

Worktree creation and cleanup, the steward's dispatch rewrite, a "waiting for
you" channel, employee memory, and hiring are later slices. The completion card
and "accept and merge" (slice 4), the secretary (slice 3), multi-post handoff
(slice 7), the memory tab's content, and a per-repository model override carry no
behaviour yet.

### Enforcement status after this section

| Rule | Enforced | Where |
| --- | --- | --- |
| A task belongs to an employee, not to a conversation | **Yes** — `task.create` refuses a target whose role is not `bot` | `crates/host-core/src/tasks.rs` |
| A task session inherits its employee's configuration and none of its identity | **Yes** — one `spawn_session`, `role = 'task'`, no profile | `session_collaboration/mod.rs` |
| A task runs in the repository it was given | **Yes** — the project is written to the session and `tasks.project_id` is read back from it | `tasks::create_in` |
| A card's remote origin never becomes a project | **Yes** — `repo.origin` is not passed to the project resolver | `session_collaboration/drafts.rs` |
| A stage the host moved reaches the sidebar once | **Yes** — settle, fail and cancel all announce through `services/task-changes.ts` | `session-collaboration.ts`, `task-changes.ts` |
| A stage moves only when the bound delivery moves | **Yes** — `progress::report` and `settle_turn` write it in their own transaction | `session_collaboration/progress.rs`, `settlement.rs` |
| A confirmed card's work runs in its task | **Yes** — the confirmation creates the task and re-points the delivery | `session_collaboration/drafts.rs` |
| Archive is one stamp in two places, repeatable | **Yes** — one transaction, first stamp wins | `tasks::archive` |
| The model cannot reach the task surface | **Yes** — `task.*` is not in `HOST_PROXY_ALLOWED` | `packages/host-runtime` test |
| Memory per employee | **No** — the tab states it is empty | later slice |
| A worktree per task | **No** — `workspace_path` is reserved and unwritten | later slice |

## Steward roster, briefing and wake-ups (employee mode 0.5, schema v35)

Decision (2026-11-13). Slice 3 gives the steward three things she was missing —
a crew she can read, a ledger she does not have to remember, and a reason to
speak — and fixes the sixth defect (an interrupted task that nobody could see and
nobody could restart). It amends §2's tool list and §4's auto-start rule.

### 1. She picks from a roster, not from session titles

`bot.roster` answers with every employee except the caller and every other
`steward`: name, duty, model, permission mode, bound repository, open tasks, how
many of those wait on the person, and whether it is idle. `repos` is a reserved
array — one employee reads one repository today, and a field that pretended
otherwise would be a promise the host cannot keep.

The steward's five tools are `Roster`, `TaskCard`, `SessionSend`,
`SessionResult`, `TaskStatus`. `SessionList` and `SessionCreate` are gone: a
title is not an identity, and guessing one is how work reached the wrong person.
Both stay denied to every delegate, so a steward definition that still names them
receives nothing.

`SessionSend` takes `{ taskId, message }`: she addresses the work, the host
resolves the task's own session, and an archived or unknown task is refused with
an error she can act on. The older `{ sessionId, content }` shape stays for
callers that address a session directly.

### 2. A card says why it names that employee

`TaskCard` requires a `reason` — one bounded sentence ("the task is pages and
interaction; you mentioned Desktop; it is idle"). It lives on the card and never
in the frozen Mandate: it explains a choice, it does not authorize one. The person
reads it beside the goal, and the Dock renders it as a muted note under the goal.

A card may also name **no** employee. A steward that cannot attribute the work
leaves the slot empty rather than guessing, the Dock shows a picker, and
`taskCard.confirm` refuses an empty target until the person chooses. Choosing is
`taskCard.reassign`: the host narrows the card to `min(card, sender, new
employee)`, recomputes `cardHash`, and leaves it `proposed` — starting it is still
a separate click, so a reassignment can never become an unread approval.

### 3. The brief is per turn, and it is not history

Every steward turn is preceded by a short brief that Main builds from `task.list`
and `bot.list`: the counts, then only the rows she may have to act on (waiting on
the person, stopped, just finished within 24 hours). It is injected into that
turn's model request only — never into the runtime's message state — so it is not
persisted, never enters a compaction summary, and cannot go stale or accumulate.
It is built in Main because `task.*` and `bot.*` are deliberately outside the
sidecar's proxy allowlist: the process that runs the model cannot read the ledger
by itself.

A failed read is reported as a gap ("the task list could not be read right now"),
never as an empty board: "no tasks" and "cannot tell" lead to opposite advice.

### 4. Only a stage change wakes her

The completion receipt of §4 already told her when work finished. A task that
stops making progress on its own — `failed`, `blocked`, waiting for an answer, or
interrupted by the startup fence — now writes one `kind = stage` delivery to the
steward, in the same transaction that moved the stage, under an idempotency key
of (task, delivery, stage, report sequence). One stage change, one message; a
repeated write of the same stage adds nothing.

Only `origin = steward` tasks produce one. Work the person dispatched from the
employee's own workbench is theirs: she knows about it from the ledger and the
brief, and does not interfere.

### 5. An interruption is visible, and the way back is one click

ADR 0239's fence is unchanged: nothing is replayed because the application
restarted. What was missing is that the interruption was invisible. Now the fence
also announces it (§4), and a task reads as interrupted through
`tasks.delivery_status` — the status the fence writes on the delivery the task is
bound to.

**No new stage value.** `tasks.stage` carries a `CHECK` constraint, so widening it
would rebuild that table — and a real user database arrives with hundreds of
thousands of historical foreign-key violations, which is the hazard that once
stopped the application from starting. Reading the bound delivery instead costs
one correlated subquery and cannot go stale: a restart writes a *new* delivery,
and the task points at it.

「重新开工」 is `task.restart`: one new delivery from the same sender with the same
Mandate, re-pointed, `queued`, idempotent per interrupted delivery. The person's
click is the authorization that it resumes.

`session_collaboration::pending_dispatch`'s `task` arm is documented for what it
is: it lets a confirmed card start within the run that confirmed it, and it is
*not* a restart recovery, because the fence marks every queued row without a turn
as interrupted at startup.

### 6. Schema v35, and what it may not do

One vocabulary grew: the ledger's `kind` accepts `stage`. SQLite cannot alter a
`CHECK`, so `migrate_v34_to_v35_tx` rebuilds `session_collaboration_messages`
once, copying every column, comparing the row count before and after, and failing
only when the file's dangling-reference count *increased*. Historical orphans are
carried across untouched. The step is idempotent: a file that already accepts
`stage` is completed, not restarted, and nothing else in the file changes because
no other table references this one.

### Enforcement status after this section

| Rule | Enforced | Where |
| --- | --- | --- |
| The steward sees a roster, never herself | **Yes** — `bot.roster` filters the caller and every `steward` | `session_collaboration/bots.rs` |
| The steward cannot acquire `SessionList` / `SessionCreate` | **Yes** — neither is steward-only any more, and both stay in the inherit deny list | `packages/shared/src/subagent-definition.ts` |
| A card says why it names this employee | **Yes** — `normalizeTaskCard` refuses a card without `reason` | `packages/shared/src/task-card.ts` |
| A card may wait for the person to pick an employee | **Yes** — `propose` accepts an empty target, `confirm` refuses it | `session_collaboration/drafts.rs` |
| Reassignment only narrows, and still waits for a click | **Yes** — `min(card, sender, new employee)`, new hash, status unchanged | `session_collaboration/drafts.rs` |
| Read-only cards start by themselves; changing ones do not | **Yes** — `auto` + non-observing + no extra `mustAsk` | `session_collaboration/drafts.rs` |
| The brief is per turn and never persisted | **Yes** — injected into the request only | `packages/agent-runtime/src/runtime.ts` |
| Only a stage change wakes the steward, exactly once | **Yes** — `kind = stage`, keyed by task + delivery + stage + seq | `session_collaboration/notices.rs` |
| A directly dispatched task never wakes the steward | **Yes** — `origin = steward` only | `session_collaboration/notices.rs` |
| An interrupted task is visible and restartable | **Yes** — `delivery_status`, fence notice, `task.restart` | `session_collaboration/restart.rs`, `settlement.rs` |
| `SessionSend` addresses a task, not a session title | **Yes** — `taskId` resolved by the host; archived or missing refused | `services/session-collaboration.ts` |
| The model cannot reach `bot.*` / `task.*` | **Yes** — not in `HOST_PROXY_ALLOWED`; Main's tools call them | `packages/host-runtime` test |

## Waiting channel and blocked card (employee mode 0.5, schema v37)

Three rules the person had confirmed before this slice:

1. **every decision goes through one channel** — an employee must write the
   question it needs answered as *structured fields*, and the steward repeats it
   verbatim instead of guessing from prose whether the employee is waiting;
2. **one record, four surfaces** — the task session's card, the steward's dock
   row, the sidebar count and the system notification are the same record, and
   answering it anywhere makes it disappear everywhere; nothing times out;
3. **a stuck card** — an employee that cannot continue says where, what it tried
   and what it suggests, and the person chooses retry, reassign, drop, or to say
   something.

### 1. One stage writer, moved by a task's own turns

`tasks::move_stage` is the only place a stage is written. Four facts reach it,
and no fifth:

| Fact | Stage |
| --- | --- |
| a turn of the task's own session begins | `working` |
| that turn ends `completed` | `person/accept` (or `blocked`, if it reported being stuck) |
| that turn ends `error` | `failed`, with the runtime's error code in `blocker_json` |
| that turn ends `aborted` (the person stopped it) | `blocked`, `reason: "stopped"`, announced to nobody |

A delivery's `progress::report` and settlement keep writing through the same
function, so a delivery-bound task and a directly dispatched one cannot disagree.
This is what fixed the defect that opened the slice: a task the person started in
the employee's own workbench stayed `queued` for ever, because the only writers
were `progress::report` (which Main never called) and settlement (which needs a
delivery a direct task does not have).

`tasks.stage_seq` counts *changes*: a repeated write of the stage a task already
holds leaves it alone, which is what makes a notice exactly-once per change
without depending on a delivery existing. The notice key is
(task, stage, `stage_seq`); the startup fence's `interrupted` notice names its
delivery instead, because an interruption is not a stage.

### 2. The waiting record: what opens and closes it

`tasks.waiting_json` holds the requests the task's session has open right now, in
the employee's own structured words — a question with its options, or the tool a
permission was asked for. At most eight, newest kept. The stage is
`person/answer` while that array is not empty.

| Where | Opens | Closes |
| --- | --- | --- |
| Main, `runtime/sidecar.ts` (`emitAgentEvent`) | `task.waiting.open` for every `asktool_request` / `tool_permission_request`, including a subagent's | — |
| Main, `ipc/agent-ipc.ts` (`toolResolvePermission`, `askToolResolve`) | — | `task.waiting.close` by request id |
| `packages/agent-host` (`respondApproval`, `respondInput`) | — | `onInteractiveResolved` → the same `task.waiting.close`, which is the phone (RACP) and MCP path |
| host (`tasks::turn_began`, `tasks::turn_ended`) | — | a new turn or the end of the current one clears the array |
| host (`settlement::recover`) | — | the startup fence clears every array: the sidecar that held them is gone, and it stops the task itself (below) |

Closing is idempotent and names the request alone, so a handler that knows only
the id (a phone reply, an MCP client) does not need the session. A request that is
closed while its turn still runs returns the task to `working`; one closed after
the turn ended leaves the stage the turn wrote.

The question text is bounded (500 characters) and travels *with* the notice to
the steward, whose brief says to quote it exactly, say where the person answers
it, and never answer it herself.

**Everything that opens or closes a record is announced.** The record is written
by Main (`runtime/task-waiting.ts`) but every surface repaints on `tasksChanged`,
so an open or a close hands the task the host returned to the same announcer
(`services/task-changes.ts`). Its de-duplication covers the stage **and** the
request set, so a second question on a task already in `person/answer` still
repaints — reported as `reason: "waiting"`, because nothing about the stage
moved. A task session's `session.beginTurn` has no IPC of its own either, so
Main re-reads the open tasks once after it.

**A restart does not leave a task claiming work is happening.** The fence aborts
every `running` turn with plain SQL and marks its delivery `interrupted`; neither
goes through `end_turn_settling`, so `tasks::recover_interrupted` (in the same
recovery transaction) moves every open task whose stage is `working` or
`person/answer` and whose session has no running turn to `blocked` with
`reason: "interrupted"`. It is silent: a steward's task was already announced by
`delivery_interrupted`, and a directly dispatched task wakes nobody ever. The
blocked card then says the app restarted, and its retry is 「重新开工」 when the
task has a delivery, the fixed message when it does not.

### 3. `TaskReport`: the employee's one structured exit

A task session has no employee definition, so nothing told it how to give up. Two
pieces fix that:

- `TaskReport` is declared for **Agent turns of a task session only**
  (`declaresTaskReport(mode, taskReporter)`; Main sets `taskReporter` from
  `sessions.role === "task"`). The tool's schema is
  `{ status: "blocked", where, tried, suggestion }`, and the host refuses a call
  from any other session or from a delegate;
- a per-turn rule block (`TASK_SESSION_BRIEFING`) rides with the request and is
  never written to the transcript, the same mechanism the steward's brief uses.

`task.report` writes `tasks.blocker_json` and moves the stage to `blocked` in one
transaction. The turn that reported it ends by holding that stage: settlement
reads the blocker and keeps `blocked` instead of overwriting it with
`person/accept`. The tool result tells the model to end the turn.

### 4. The blocked card

One card, three sources, four decisions:

- `blocked` → the report's own `where` / `tried` / `suggestion`;
- `failed` → the error code the runtime settled (`blocker_json.reason = "error"`);
- `interrupted` → the startup fence, and the card says the app restarted.

Buttons: **retry** (a fixed message in the person's language, sent into the task
session; for an interrupted task it *is* 「重新开工」, so one card has one set of
buttons), **hand to…** (`task.reassign` proposes a new card on the steward's
conversation with the original goal and nobody assigned; the original task is
left alone), **drop** (a second click, then `task.archive`), **say something**
(open the task session and focus its composer).

### 5. Four surfaces, one record

| Surface | Shows |
| --- | --- |
| the task session | the question card the runtime raised, and the blocked card |
| the steward's dock | an orange row per open request (employee @ repository · task · question), answerable in place with the request's own options; the blocked card; the fallback 「去任务里回答」 when the request cannot be read here |
| the sidebar | 「等你 N 件」 over every source, a list whose rows go to the task or to the steward's conversation, and a red dot on an employee with anything waiting |
| the system notification | "<employee> · <task> 在等你" with the question (or the tool and its reason) as the body; for a stuck task "<employee> 卡住了: <where>" once per `stage_seq`, skipping a task the person is already reading |

Dock order is the ADR's: questions and approvals, then stuck tasks, then start
cards. A row the person answered collapses to one quiet line and **adds nothing
to the transcript**: the record is the dock's, not the conversation's.

The notification for a task is composed in the renderer
(`stores/runtime/task-waiting-runtime.ts`), not in Main: its two halves live
there — the pinned reminder is the store's toast, the OS banner goes through
`api.showNativeNotification`, and the "do not pop while they are reading it"
rule already sits in Main's `shouldShowNativeNotification` handler. Main would
have had to duplicate the banner and the toast. What Main keeps is the decision
about *whether* a banner is shown at all.

The steward's model has no tool that answers a request. `bot.*`, `taskCard.*`
and `task.*` stay out of the sidecar proxy allowlist, so the only way a request is
resolved is a person's click.

### 6. The rule that changed: a stuck task counts as waiting

Until this slice only `person/*` disturbed the person, and `blocked` / `failed`
were the employee's own quieter business. That is precisely why a stuck task could
sit there unnoticed. The rule is now: **a task the person has to act on counts**,
whether it waits for an answer, waits for acceptance, or got stuck.
`tasks::task_status_point` and the renderer's `bot-status.ts` changed together,
and `taskCountsAsWaiting` is the one predicate the sidebar, the dock and the tests
use.

### 7. Schema v37

Three additive columns on `tasks`: `waiting_json`, `blocker_json`,
`stage_seq INTEGER NOT NULL DEFAULT 0`. No table is rebuilt, no row rewritten, and
the step must run on a file that already carries historical foreign-key
violations — the v32 → v33 rebuild once refused a real user's file over one orphan
row, so every later step to this table stayed additive. A column that already
exists is completed, not restarted, and `user_version` is stamped only after the
last statement.

### Enforcement status after this section

| Rule | Enforced | Where |
| --- | --- | --- |
| One stage writer; a repeated stage write is not a change | **Yes** — every path goes through `tasks::move_stage`, `stage_seq` counts changes | `crates/host-core/src/tasks.rs` |
| A task's stage follows its own turns, delivery or not | **Yes** — `turn_began` / `turn_ended` are called from `sessions::begin_turn` / `end_turn_settling` | `crates/host-core/src/sessions.rs` |
| A repeated or replayed settlement wakes nobody twice | **Yes** — notice keyed by (task, stage, `stage_seq`) | `session_collaboration/notices.rs` |
| A directly dispatched task never wakes the steward | **Yes** — `origin = steward` only | `session_collaboration/notices.rs` |
| A stopped turn is stuck and silent | **Yes** — `blocked` + `reason: "stopped"`, written with `silent` | `tasks::turn_ended` |
| A question is stored from structured fields only | **Yes** — `task.waiting.open` takes the AskTool question/options or the tool and reason | `electron/main/runtime/task-waiting.ts` |
| A request closes from any surface | **Yes** — by request id, from Main's IPC, agent-host's RACP hook, or the turn's end | `task-waiting.ts`, `agent-host.ts`, `tasks::waiting_close` |
| A restart holds no requests | **Yes** — the fence clears every array | `session_collaboration/settlement.rs` |
| Only a task session may declare `TaskReport` | **Yes** — `declaresTaskReport`; host refuses other sessions and delegates | `packages/agent-runtime/src/task-report.ts`, `rpc/task_tools.rs` |
| A stuck report survives its own turn's settlement | **Yes** — settlement keeps `blocked` when a blocker is present | `tasks::turn_ended` |
| The rules a task runs under never enter the transcript | **Yes** — per-turn briefing only | `electron/main/services/task-status.ts` |
| The steward relays, and cannot answer | **Yes** — her brief says so; no tool answers a request | `task-status.ts`, `HOST_PROXY_ALLOWED` |
| A blocked or failed task counts as waiting | **Yes** — `taskCountsAsWaiting`, `task_status_point`, and `taskTone` for the row and the chip | `packages/shared/src/task.ts`, `task_stage.rs` |
| A restart stops every task that claimed work was happening | **Yes** — `recover_interrupted`, silent, in the recovery transaction | `task_stage.rs`, `settlement.rs` |
| Opening or closing a record repaints every surface | **Yes** — announced from `task-waiting.ts`, keyed by stage + request set | `services/task-changes.ts` |
| A question or a stuck task is announced once, and a stop is not | **Yes** — title/body per state, `stage_seq` de-dupe, `stopped` skipped | `stores/runtime/task-waiting-runtime.ts` |
| A stage write failing does not fail the turn | **Yes** — logged, the turn stays settled | `sessions.rs` |
| Schema v37 is additive and idempotent | **Yes** — three `ADD COLUMN`s, orphan-safe, pinned by migration tests | `db/task_waiting_migration.rs` |
