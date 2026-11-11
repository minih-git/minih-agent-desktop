# ADR: The parent steers a running delegation

- Status: Accepted for implementation
- Date: 2026-11-11
- Deciders: Minih-Agent-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0165](0165-withdraw-a2a-peer-stack.md) ·
  [ADR 0279](0279-resumable-subagent-delegations.md) ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5f ·
  [03-runtime/03-tools-and-permissions.md](../spec/03-runtime/03-tools-and-permissions.md) §10.2
- Amends: ADR 0062's "the brief is written once" clause. Every other boundary
  in 0062, 0089 and 0279 still holds.

## Context

ADR 0062 gives the `Task` tool one `task` argument and makes it immutable: the
delegate's only instruction is a string the parent writes before the run
starts. The catalog of what a delegate may do, where it writes, and what it
reports back is fixed at spawn time; the words are fixed too.

That was right for a bounded worker whose work is separable. It is wrong the
moment the parent learns something the delegate cannot see — a user changed
the requirement, another delegate reported a conflict, a file turned out to be
the wrong one, the test command is different in this repository than the brief
assumed. The parent had exactly one remedy: `TaskStop`, then a cold restart
with a corrected brief. Everything the delegate had already read, grepped,
read into its context, and edited is discarded, and the second run pays for it
again. In the common case the delegate is ninety percent right and the
correction is one sentence.

Two facts make the smaller fix cheap:

- pi's `Agent` has a steering queue. `agent.steer(message)` enqueues a user
  message that the loop injects **after the current assistant turn and its
  tool batch, before the next model request** — never in the middle of a tool
  call, which is what makes a correction safe to apply to running work.
- ADR 0279 already persists a delegate's rows with `parentToolCallId` and
  `agentName` and already rebuilds a chain's context from them. An injected
  instruction is one more user row, so resume inherits the correction for free.

ADR 0165 withdrew the sibling (`Peer`) and cross-session A2A stacks. That
decision was about *who may address whom*, not about a parent's authority over
the work it started: `Task`/`TaskWait`/`TaskStop` already let the parent read,
wait on and cancel its own delegates. Steering is the same relationship, one
step finer.

## Decision

### 1. `TaskSend(delegationId, message)`, parent-only

A new Agent-mode tool beside `Task`/`TaskWait`/`TaskList`/`TaskStop`:

| Field | Bound | Why |
|---|---|---|
| `delegationId` | non-empty, ≤ 256 | must be the id `Task` returned; there is no name lookup |
| `message` | non-empty, ≤ `MAX_TASK_SEND_CHARS` (12,000) | the same budget as the delegate's report, so one correction cannot flood the delegate's window |

The call **returns as soon as the message is queued**. It never waits for the
delegate: waiting would block the parent's turn on work the parent asked to
run in the background. The result says the instruction was queued, names the
delegate, and points at `TaskWait` for the answer.

It lives in its own module (`packages/agent-runtime/src/subagent-send-tool.ts`):
argument bounds and every refusal message are pure functions there, and
`runtime.ts` only registers the tool and resolves the delegation.

### 2. Delivery is pi's steering queue, not a side channel

`SubagentRun.send(text)` calls `agent.steer({ role: "user", ... })`. The
message therefore arrives at the delegate the way its own brief did, as a user
turn in its own context, is visible in its own transcript, and costs it context
— which is the honest accounting for an instruction.

There is no delegate-to-delegate traffic, no broadcast, and no addressing of any
run the caller did not start itself. `TaskSend` resolves its target through the
session's own delegation registry, so a delegation id from another session or
another parent simply does not exist.

### 3. The invariant: never silently dropped

"The message is queued" is not the guarantee. The guarantee is that every call
ends in exactly one of two observable states:

1. **delivered** — the instruction reached a model request, or
2. **refused** — the tool returned an error, before or after queueing.

Three mechanisms, all in `SubagentRun`, make that true:

- **Drain before closing.** After `prompt()` returns and after every retry or
  fallback `continue()`, `run()` checks the queue. A queued message while the
  transcript still ends on an assistant row means the delegate is not done:
  the run calls `continue()`, which replays the queue, and loops. A run that
  accepted an instruction therefore cannot reach its final result with that
  instruction still waiting.
- **A closing flag.** Once the run commits to producing a result (after the
  drain loop, in the `finally`), `closed` is set and `send()` refuses with
  `SUBAGENT_RUN_CLOSING`. A `send()` racing the last turn sees either a live
  queue or this refusal — never a promise that quietly evaporates.
- **Anything accepted and not delivered is reported.** When the run commits to
  its result, every accepted-but-unsent instruction is counted as discarded:
  the queue is cleared, the cleared entries are subtracted from what was
  accepted, and the result carries `steering: { delivered, discarded }` plus a
  line in the report naming the cause ("N instructions sent to this subagent
  did not reach it (the subagent was cancelled / it ended first)"). A
  cancellation — user Stop, `TaskStop`, runtime disposal, terminal parent error
  — additionally refuses later sends with `SUBAGENT_RUN_ABORTED`. A stop, or a
  run that ended before a queued turn could be replayed, must never read like a
  delivered instruction.

`SubagentRunResult.steering` is today's public trace of that accounting; the
parent reads "queued" and the settled result reads "delivered" or "discarded".

### 4. Validation is a tool error the model can act on

| Condition | Result |
|---|---|
| unknown `delegationId` | `Unknown delegation "<id>"` plus the running ids, or `TaskList` when none are running |
| the delegation has settled | `... is no longer running (status: <s>)`; `completed`/`failed`/`timed_out` add `Task(resume: "<id>")`, others say to start a new `Task` |
| the run is closing | `is finishing and cannot accept instructions`; wait with `TaskWait`, then resume |
| empty or oversized `message` | the bound and the limit, refused before anything is queued |
| not Agent mode | the ordinary contract-mode execution denial (declaration retained, execution rejected) |

No new error code is invented for a delegation that never existed versus one
that was pruned: the model's only correct action is identical.

### 5. Persistence and resume

An injected instruction reaches the delegate's own stream as a `message_end`
with `role: "user"`. Only the objects `send()` handed to the queue are
forwarded, matched by identity: the opening brief is a user message in the same
stream, and forwarding it would duplicate it on resume (the brief is rebuilt
from the `Task` row's arguments) and read as an instruction in the delegate's
transcript. The run emits the row itself, because that is the only place that
can tell "delivered" from "queued". Two existing paths are extended, not
replaced:

- the runtime appends it to `transcriptHistory` through the same
  `appendDelegationRow` path every other delegate row uses, tagged with
  `parentToolCallId` and `agentName`;
- Electron main's `persistAgentEvent` writes it to the session transcript with
  the same attribution (and returns the row so it reaches the renderer once,
  instead of being echoed as a parent-owned user message).

Because the row is an ordinary attributed user row,
`delegation-history.chainRowsToMessages` already replays it as a user turn, so
`Task(resume)` after a `TaskSend` continues the conversation *including* the
correction. No schema, protocol, or migration change.

### 6. Authority: the parent has it, a delegate does not

`TaskSend` joins `SUBAGENT_INHERIT_DENY_TOOLS`, so `tools: inherit` never
carries it and a definition naming it does not get it. A delegate that could
steer another delegation would be steering work its own brief never
authorized, and a delegate that could steer itself could rewrite its brief
mid-run — the one thing ADR 0062's bounded worker must not do.

In the runtime it is otherwise treated exactly like `TaskStop`: an Agent core
tool, retained across contract-mode switches (declared for conversation
compatibility, refused before execution), and `sequential` in the execution
model so it never joins a `Task` fan-out batch.

### 7. The transcript shows it, inside the delegation

The instruction is a delegate row and renders in the delegate's conversation —
the topology panel and the subagent tab — with a one-line marker
("Instruction to the subagent", i18n in every locale). It is *not* drawn as a
user message in the turn stream: it never came from the person watching the
session, and the parent's own row is its `TaskSend` call.

## What this is not

- **Not `interrupt`.** There is no way to break into the delegate's current
  assistant turn or a running tool call. The instruction waits for the next
  request. Interrupting a tool call mid-flight is a different mechanism with
  different failure modes (a half-written file, a half-sent HTTP request) and is
  deliberately out of scope; `TaskStop` is the answer when the current turn
  itself must not finish.
- **Not a replacement for the brief.** `Task`'s description still asks for the
  goal, paths and facts the delegate cannot infer. Steering costs the delegate
  a turn and costs the parent a tool call each time; a vague brief is paid for
  repeatedly.
- **Not a revive path.** A settled delegation is refused, not reopened:
  `Task(resume)` is that mechanism (ADR 0279), and keeping one path for
  continuing a chain keeps its bounds (one live record per chain, read budget,
  resumable statuses) intact.

## Alternatives considered

- **Reopen the brief by mutating the `Task` row.** Rejected: the row is
  evidence of what was asked, and rewriting it would make the transcript lie
  about the run's opening instruction.
- **Queue instructions in the runtime and hand them to the delegate at the next
  `TaskWait`.** Rejected: `TaskWait` may never be called (the run may finish
  first), which is precisely the silent-drop failure this ADR exists to
  prevent.
- **Give the delegate a mailbox it polls.** Rejected: it duplicates the
  steering queue pi already has, inside the delegate's tool surface, and turns
  a bounded worker into a message-processing loop.
- **Let the delegate ask the parent a question mid-run.** Out of scope and the
  opposite direction: a delegate has no user (ADR 0062), and an interactive
  delegate would need a permission-shaped UI and a new wait state.
- **`interrupt: true` on `TaskSend`.** Deferred; see above.

## Consequences

- One new Agent-mode tool schema per request when the session has subagents
  (four delegation tools become five). Sessions without subagents are
  unchanged.
- A delegate's context can now grow between turns without a new `Task` call.
  Its own context protection (ADR 0299) still applies at every turn boundary,
  and the 12k bound caps a single instruction.
- The delegation transcript gains user rows. They are attributed, collapsed
  with the rest of the delegation, and never replayed into the parent's
  context.
- Cross-session and sibling addressing remain withdrawn (ADR 0165): the only
  new edge is parent → its own running delegate, the same edge `TaskStop`
  already uses.
