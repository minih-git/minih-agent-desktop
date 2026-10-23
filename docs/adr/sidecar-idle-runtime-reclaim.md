# ADR: Reclaim idle agent runtimes in the sidecar

- Status: Accepted
- Date: 2026-10-23
- Related: `03-runtime/02-agent-runtime.md`,
  `docs/superpowers/specs/2026-10-23-memory-retention-bounds-design.md`

## Context

The agent sidecar keeps one live runtime per session, because rebuilding one
costs a history read and a provider prompt-cache miss. Nothing used to take a
runtime away again: a session left alone for hours kept its full conversation,
its decoded attachments (base64 read back from the transcript) and its tool
clients in memory for the life of the process. On a desktop left running all
day the sidecar reached several hundred megabytes for sessions the user had
not touched since the morning.

A rebuild path already existed and is the normal one: `session.get` restores
history and the compaction record, so a disposed runtime resumes as if the
process had just started.

## Decision

The sidecar sweeps its runtimes once a minute and disposes those nobody can
resume:

- not busy: no running turn, no pending tool confirmation, no plan awaiting
  approval, no pending plan;
- untouched for the idle window (30 minutes by default);
- additionally, at most eight idle runtimes stay resident; beyond that the
  least recently used ones are disposed first.

Native Pi sessions are excluded: their state belongs to the canonical JSONL
session service, not to this map. `MINIH_AGENT_IDLE_RUNTIME_SECONDS` and
`MINIH_AGENT_MAX_IDLE_RUNTIMES` shorten the policy for measurements.

## Consequences

- Idle sessions no longer pin the sidecar's memory; the next prompt pays one
  history read and one cold prompt (provider cache miss).
- A finished delegation chain cannot be resumed after its parent runtime was
  reclaimed, matching the existing "an evicted chain cannot resume" semantics.
- Learned-memory capture runs again on rebuild, as it does after a restart.
- The reclaim decision is a pure function, unit tested with a controlled clock;
  the sidecar owns only the timer and the disposal.

### Electron-side bookkeeping after a reclaim

Electron main keeps per-session bookkeeping; only plain data may outlive a
runtime, and each entry was checked against the reclaim path:

- `sessionProjects` (project path), `activeTurns` (turn id),
  `approvedExecutionIdsBySession`, `claimedExecutionSessions` and
  `activeToolCalls` hold paths, ids and call descriptors, never a runtime
  handle. They are written while a turn runs, and a running turn is never
  reclaimable; `agent.getStatus` answers an absent runtime with an idle status,
  so the renderer stays consistent.
- `AgentExtensionBridge.sessions` (commands, diagnostics, load reports) also
  holds plain data, and it deliberately survives the reclaim: the trusted
  extension command list stays listed for a session that is merely idle. No
  entry points at a disposed runtime, nothing needs clearing.

One consequence is inherited rather than created: `extensions.command.run`
needs a live runtime, so invoking a trusted-extension command in a reclaimed
session answers `RUNTIME_NOT_FOUND` and the composer shows that as an error
toast. The same state is already reachable today by regenerating the last
message (`agent.disposeSession`) and then invoking a command before the next
prompt; the next prompt rebuilds the runtime and republishes the commands.
Rebuilding on command invocation would need the full launch payload and is
left out of this change.