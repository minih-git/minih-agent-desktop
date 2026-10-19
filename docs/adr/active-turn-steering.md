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

## Side notes (2026-10-18)

The same channel also carries side notes: user input the running turn answers
without being redirected by it. `AgentSteerRequest.sideNote` marks the request,
main echoes `UiMessage.sideNote` on the durable row, and the runtime frames only
the model-visible prompt, so "summarize progress" or "adjust direction" reaches
the turn without replacing its task while the transcript keeps the user's own
words. The work panel's side-notes tab is the entry point; it lists the
session's marked rows and disables its input when no turn can receive a note.
No new channel, event kind, storage schema, or migration is introduced.
E2E-AGENT-side-note-keeps-running-turn specifies the journey and remains Draft.
