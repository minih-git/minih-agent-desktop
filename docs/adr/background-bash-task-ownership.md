# ADR: Host-owned background Bash tasks

- Status: Accepted for implementation
- Date: 2026-10-19
- Scope: Optional local Bash execution and its additive IPC/RPC surface
- Sources: [selected upstream revisions](../project/upstream-import-2026-10-19.md)

## Context

Foreground commands belong to a turn: its timeout or cancellation terminates the
owned tree. A development server or watcher sometimes needs to outlive that
turn. Reusing foreground cancellation or moving process ownership into a mounted
renderer would make ordinary turn completion or renderer reload kill it.

## Decision

The existing Rust host-core process owns a bounded background-task registry. An
explicit `runInBackground: true` still passes normal authorization and shell pin
checks; pending approval remains cancellable. After successful registration the
call returns an id, and explicit Stop or Host shutdown owns termination. Startup
and registry admission are serialized with shutdown. Isolated cwd/environment
remain session-owned and are passed to the runner unchanged.

The renderer only projects list/output/state and sends explicit Stop. Main is a
thin allowlisted relay. The additive local methods are `backgroundTasks.list`,
`backgroundTasks.output`, `backgroundTasks.stop`, and a changed notification.
No SQLite schema, model provider, Router API, plugin permission, or persisted
command format changes. Remote background execution is not silently emulated.

## Consequences

The user must stop long-lived work explicitly; aborting a turn no longer stops
commands explicitly launched in the background. Limits are 32 running tasks,
16 finished entries, 256 KiB per output stream and 12 visible Composer rows.
Output readers drain the final bytes before settling state. Host restart does
not restore tasks. Foreground timeout/cancellation behavior stays unchanged.

## Alternatives

Keeping ownership in the turn defeats the requested lifetime. Renderer-owned
processes violate the frozen process model and lose lifecycle ownership on
reload. A durable daemon/service manager would add persistence and recovery
semantics outside this request and is not introduced.
