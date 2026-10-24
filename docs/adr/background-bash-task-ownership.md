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

Amended 2026-10-24: limits are 10 running tasks per session and 64 total,
16 finished entries, 256 KiB per output stream and 12 visible Composer rows.
Admission checks the session and both limits before spawn under the existing
lifecycle lock; rejected commands never execute. Successful session/batch deletion
and project removal signal only deleted sessions' tasks. Cleanup is signal-only;
supervisors retain tree termination, drain and reap ownership. Archiving, switching
conversations and aborting a turn leave registered tasks running. The renderer
uses a shared Todo/task dock and cannot dismiss still-running/settling tasks.
The global list RPC, foreground semantics and restart-without-replay stay intact.

## Alternatives

Keeping ownership in the turn defeats the requested lifetime. Renderer-owned
processes violate the frozen process model and lose lifecycle ownership on
reload. A durable daemon/service manager would add persistence and recovery
semantics outside this request and is not introduced.
