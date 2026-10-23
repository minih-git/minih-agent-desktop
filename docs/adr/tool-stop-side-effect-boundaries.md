# ADR: A user stop preserves tool side-effect boundaries

- Status: Accepted for implementation
- Date: 2026-10-23
- Issues: #1767 (upstream)
- Amends: spec 03-runtime/03-tools-and-permissions.md §3,
  spec 03-runtime/06-host-rpc-protocol.md §5

## Context

The runtime registered an abort listener for every tool call but returned
immediately unless the tool was `Bash` or `GenerateImages`. For every other
tool — `Grep`, `Read`, `Glob`, `WebFetch`, MCP and plugin calls — the listener
was inert, and `tools.execute` was awaited with no deadline and no race against
the signal. The agent loop only re-checks `signal.aborted` between tool calls,
so a single long call held the turn, and the session, hostage: one report
measured a `Grep` that ran 21m39s after the user clicked Stop six times, with
the abort applying in the same millisecond the tool finally returned.

A stop can also reach the runtime without reaching the tool it was meant to
cancel. In that case the executor keeps awaiting `tools.execute`, the turn
never settles, and `abort()` — which awaits that settlement — never returns.
The renderer awaits the abort RPC before it clears "processing", so the session
stayed pinned even though the durable turn was already recorded as aborted.

The fix must not trade one false state for another. It must not tell the user
that a turn stopped while a pending permission can still be approved, while a
queued tool can still start, or while a mutating extension call is still
running. Minih also owns two behaviors the generic fix must preserve: a
background Bash approval is cancellable before admission, and an admitted
background task survives the turn's Stop as a Host-owned process.

## Decision

The runtime sends a typed `tools.abort` request for each in-flight tool call.
The request carries `sessionId`, `toolCallId`, and the optional `toolName`.
Current runtimes include the name; an older caller may omit it, in which case
the Host keeps the legacy Bash cancellation behavior and can still stop
whichever typed tool currently holds that call id. Host-core registers
cancellation before permission evaluation, so stopping a pending approval or a
queued admission prevents the tool from starting. Registration also covers a
background Bash call while it is awaiting approval; a refusal there starts no
process.

`Bash` and `GenerateImages` use the existing process-cancellation path. The
runtime waits a bounded 10-second grace window for the host to return the
output it collected before the kill; an expired window settles as
`TOOL_ABORTED` without claiming that buffered output was delivered. The
complete process tree is still terminated by the host.

Local `Read`, `Glob`, and `Grep` calls may end the runtime's wait immediately
with `TOOL_ABORTED`. The host observes the same cancellation and discards a
late result. These tools are read-only, so a blocking filesystem worker that
runs until it returns cannot mutate the workspace. The runtime does not claim
that the worker thread was terminated.

Mutating calls, MCP calls, plugin calls, remote writes, and built-in session
delivery calls that have already started are not abandoned locally. The
runtime requests cancellation and waits for the host result before it settles
the turn, so Stop cannot hide a write, a session delivery, or a plugin action
that is still running. A pending approval for any of them is cancelled at the
host and cannot be approved afterwards.

An admitted background Bash task remains outside this contract: it is detached
from the turn after admission, `tools.abort` does not kill it, and Stop settles
the turn without stopping the task. Only explicit task Stop or graceful Host
shutdown terminates its process tree.

`abort()` also drives the in-flight tools directly instead of relying only on
the signal each tool was handed. Both entry points apply the same policy:
read-only waits may end immediately, process tools retain their bounded grace,
and started mutations still await their result. Abandoning a permitted wait
does not terminate the host call; its late result is discarded and cannot
surface inside a later turn. Cleanup removes listeners, timers, progress and
output resources.

Typed cancellation records are keyed by session, call id, and tool name, so a
delayed abort for one tool cannot cancel a different tool that reuses the call
id. Bash keeps its short-lived early-arrival tombstones for the same reason.
The runtime's cancellation state lives in a small
`tool-execution-cancellation.ts`, and the Host's typed registry lives in a
small `tool_cancellation.rs`; the existing runtime and RPC entry points keep
their business branches and only wire these helpers.

## Consequences

- A long local read-only tool no longer holds the turn open after Stop; its
  blocking worker may still drain. The renderer leaves "processing" after
  the abort RPC returns.
- A started mutating or extension operation may keep the turn in its stopping
  state until the Host returns its result. This wait preserves observable
  side effects rather than reporting a false completion.
- A mutating or extension action is never presented as stopped while it can
  still change state. The user may wait for that result after Stop.
- Pending permission prompts and queued admission are cancelled before a tool
  starts, including for background Bash; an admitted background process
  survives the turn as designed.
- A retry uses a distinct tool call id. Typed records also prevent an early
  abort for one tool name from being inherited by another tool.
- Progress output for an abandoned call stops at the moment of the stop.

## Alternatives

- **Locally abandon every tool.** Could report a stopped turn while a pending
  `Write` approval is later accepted or an already-started plugin/MCP action
  continues. Rejected because it hides side effects.
- **Send an untyped `tools.abort` and keep the legacy call-id tombstone.** A
  later tool reusing the id could inherit the abort. Rejected because the
  cancellation must be scoped to the tool that was actually stopped.
- **Skip cancellation registration for the whole background Bash call.**
  Rejected: it would make a background approval impossible to cancel. Minih
  registers until admission only and leaves the admitted process detached.
- **Only arm a grace timer on abort (no race for cancellable tools).** Simpler,
  but leaves every non-cancellable tool waiting the full window and still keeps
  the turn blocked for that window.
- **Wait for host-core to grow cancellation for every tool.** Correct durable
  direction, tracked separately; it cannot ship as a fix for a turn that is
  stuck today.

## Validation

Runtime cancellation regressions, Host approval/admission and background-task
filters, the remote-write settlement regression, and the offline real-Host Stop
fixture pass. Remote Write/Edit receipts remain observable after Stop; existing
remote read-only and Bash cancellation behavior is retained. Actual counts,
failure baselines and platform limits are recorded in the
[selective import record](../project/upstream-import-2026-10-23.md#implementation-and-validation-2026-10-23).