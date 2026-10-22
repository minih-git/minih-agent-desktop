# ADR active-turn-steering: Bind Composer steering to the active durable turn

- Status: Accepted
- Date: 2026-09-12
- Issue: https://github.com/minih-git/minih-agent-desktop/issues/164

## Context

The Composer queues follow-ups, but cannot redirect a running turn. A second
prompt is correctly rejected with `AGENT_BUSY`. pi-agent-core already supplies
`Agent.steer`; Codex's [turn/steer contract](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
provides the expected-turn admission model.

## Decision

Keep Send/Enter as follow-up. Alt+Enter (Option+Enter on macOS) uses an additive
`agent/steer` channel with `expectedTurnId`. The existing queue slice submits
optimistic input and restores rejected drafts. The agent IPC handler reuses
attachment validation against the running model and workspace; the sidecar
rechecks the target after asynchronous preparation and calls `Agent.steer`.

Steering keeps the active configuration and durable turn. Started tools finish
before the next model request consumes input, except `TaskWait`, which yields
to accepted user input without canceling its delegates (issue #1607). The
runtime handles admission at its closing boundary and while awaiting delegates.
Stop closes admission
and retains accepted input as history without independently replaying it.

The existing event-persistence module journals input through the outbox.
`precedingAssistant` reserves an unfinished reply's position before the user
row. Host append permits a terminal assistant to replace its own streaming
reservation, retaining sequence and turn ownership; completed rows remain
immutable on replay. Recovery updates the reservation in place. The persisted
`UiMessage.steering` marker protects input from Smart Stop, including after
renderer reload; no separate renderer submission registry is needed. Host
provenance treats steering into a claimed collaboration delivery turn as extra
human input: it must target that delivery's session, does not inherit the
delivery's agent origin, and strips any client-supplied `session_message`
(D597).

## Consequences and validation

No new provider transport, host protocol version, or storage migration is
required. Streaming reservation updates are the sole exception to append-only
message persistence. Existing regression suites cover surrounding behavior;
E2E-AGENT-alt-enter-steers-active-turn specifies the full journey and remains
Draft until rendered E2E validation is performed.

## Side notes (2026-10-20 correction)

Side notes are independent read-only questions, not active-turn steering.
The shared steering channel interrupted TaskWait and mixed answers into the
main transcript. Asking the model to continue was not execution isolation.

Dedicated ask/list IPC reads the running task's context synchronously and uses
the existing tool-free one-shot completion, current model and authentication.
It has a separate request identity, timeout and disposal signal. It never calls
Agent.steer or mutates main messages, activity, usage, queues or turn lifecycle.
No new model-facing tool, agent type or provider transport is introduced.

Rust Host persists completed question/answer pairs in a per-session
`.side-notes.jsonl` companion, outside the main transcript and its model
context. Session deletion removes the companion. Existing transcript sideNote
markers remain readable legacy questions; replies are never inferred or moved.
No SQLite migration or destructive history rewrite is needed.

The panel requires an active steer-capable local turn on submission. A submitted
answer can finish after the main task, and stays bound to its original session.
Pending requests prevent duplicates across panel remounts. Failures preserve
the draft; success clears only its unchanged submitted draft. Questions and
answers reload in the panel only. Direction-changing questions here only get
an explanation; actual steering remains in the normal Composer.

E2E-AGENT-side-note-keeps-running-turn checks a side-panel answer while the
parent stays in TaskWait and both delegates continue.
