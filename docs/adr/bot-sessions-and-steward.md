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
- `homeHostId` is display and routing intent only. It is never proof of
  locality and never an authorization. Nothing in this ADR resolves a bot to a
  host; that is a later, cross-host decision.

### 2. The steward is a bot with no side-effecting tools

The steward is a built-in bot, defined like any other subagent definition, and
it owns exactly one capability set: `SessionList`, `SessionSend`,
`SessionResult`, `SessionCreate`, and the task-card tool. It has no `Write`,
`Edit`, `Bash`, network-write, browser, plugin, or MCP tool, and it does not
receive inherited tools.

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
- **The executing side recomputes permission.** The effective mode is
  `min(Mandate.permissionMode, the ceiling the receiving host grants this
  source, the bot's own ceiling)` and `mustAsk` is the union of all three, with
  `deploy`, `delete` and `spend` always added by the executing side. A Mandate
  asks; it never grants. A tampered, replayed, or forged card therefore cannot
  raise authority, because nothing on the receiving side reads authority *from*
  the card.
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
| A card's `permissionMode` narrows the delivery ceiling | **Yes** — the ledger ceiling is `min(sender, card)` at send time, and turn admission re-checks it | shipped |
| A card can never widen authority | **Yes** — the ceiling is a minimum, and a target wider than the card is refused | shipped |
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
  model typed: an observing employee never starts by itself, and an `auto` card
  always waits for a click. A `policy` confirmation is recorded as `policy`, so
  an audit can always tell it apart from a person's.

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
