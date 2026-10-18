# Built-in session messaging design

- Status: Implemented (D663)
- Date: 2026-10-18
- Decision record: [ADR: Built-in session messaging tools](../../adr/builtin-session-messaging.md)

## 1. Goal

Let an Agent session hand a task to another existing Agent session by name,
without the user copying prompts and without installing the
`pi.session-orchestrator` plugin. Representative journey:

> In session A the user says "send the review task to the session titled
> 'Recent commit review'". The model calls `SessionList`, finds one match, calls
> `SessionSend`. Session B starts (or queues) the task with session-message
> provenance. When B's turn settles, A receives a completion notice.

Non-goals for version one: creating sessions (`spawn`), cancelling deliveries,
worker-to-worker orchestration, a renderer UI for composing deliveries, and any
change to `Task`, `TaskWait`, `TaskList`, or `TaskStop`.

## 2. Current state (verified on `origin/main` 52ec07b45)

| Concern | Owner today |
|---|---|
| Ledger, idempotency, inbox limit (8), hop budget, permission ceiling, callbacks, restart fence | `crates/host-core/src/session_collaboration/` |
| Turn admission and dispatch of a delivery | `apps/desktop/electron/main/services/session-collaboration.ts` (`dispatch`, `drain`, `settle`) |
| Plugin-only admission | same file, `invoke()`: `input.source !== "plugin"` → `PERMISSION_DENIED`; `sender()` reads `pluginContext` |
| Operation catalog (plugin-only, hidden from MCP) | `apps/desktop/electron/main/session-collaboration-control.ts` |
| Main-side local tools with sidecar-supplied `sessionId` / `turnId` / `toolCallId` | `packages/host-runtime/src/agent-sidecar.ts` (`setLocalTool`, `runLocalTool`), registered in `apps/desktop/electron/main/runtime/sidecar.ts` |
| On-demand built-in tool declarations | `packages/agent-runtime/src/runtime.ts` (see `scheduledToolParameters`, line ~3864) |
| Tool risk table / contract-mode allowlist | `crates/host-core/src/permissions.rs` |
| Gate-only `tools.execute` arm for desktop-run tools | `crates/host-core/src/tools/mod.rs` (`"GenerateImages" => authorized`) |

## 3. Tool contracts

All three are on-demand Agent-mode tools. Arguments are validated at the
local-tool boundary; unknown properties are rejected.

### `SessionList`

```ts
{ query?: string /* 1..200 chars, case-insensitive substring of title */ }
```

Calls `session.collaboration.list`, removes the caller's own session, filters by
`query`, and returns at most 30 rows of `{ sessionId, title, status, model,
updatedAt }`. Read-only; `Low` risk.

### `SessionSend`

```ts
{
  sessionId: string;                 // a real Session ID from SessionList
  content: string;                   // 1..65536 chars
  kind?: "task" | "message";         // default "task"
  notifyOnCompletion?: boolean;      // default true
  idempotencyKey?: string;           // default: derived from the turn and tool-call id
}
```

Returns `{ messageId, sessionId, status, queued }` from the existing delivery
projection. `High` risk. The tool description must instruct the model to resolve
names through `SessionList` and ask the user when more than one session matches.

The default idempotency key is `tool:<turnId>:<toolCallId>`, with a random
fallback when the provider omits the call id: the ledger remembers a key for the
session's whole lifetime, so a retried tool call cannot deliver twice while a
reused id in a later turn still counts as a new delivery.

### `SessionResult`

```ts
{ sessionId: string; messageId?: string }
```

Calls `session.collaboration.result`. `Low` risk.

## 4. Implementation plan

### 4.1 Collaboration service: trusted built-in entry (Main)

File: `apps/desktop/electron/main/services/session-collaboration.ts`

1. Introduce an internal `Sender = { ownerId; sourceSessionId; sourceTurnId }`.
   Move the bodies of `send`, `list`, and `result` into helpers that take a
   `Sender` (behavior-preserving refactor; existing plugin tests must pass
   unchanged before any new behavior is added).
2. Plugin path: `invoke()` keeps its checks and additionally rejects a
   `pluginContext.pluginId` equal to `BUILTIN_SESSION_OWNER`.
3. New method `invokeBuiltin({ sessionId, operation, args, signal })`:
   `sourceTurnId = deps.getActiveTurn(sessionId)`; missing → `PERMISSION_DENIED`.
   It accepts only `list`, `send`, `result`.
4. `dispatch()` currently aborts when `!deps.isPluginLoaded(current.pluginId)`.
   Treat `BUILTIN_SESSION_OWNER` as always loaded.
5. Export `BUILTIN_SESSION_OWNER = "builtin:session-messaging"` from a small
   shared constant module so tests and Main agree.

No change to `session-collaboration-control.ts`; the MCP catalog stays as is.

### 4.2 Local tools (Main)

New file: `apps/desktop/electron/main/services/session-messaging-tools.ts`
(target < 200 LOC). It exports one `LocalToolHandler` per tool, validates
arguments, calls `invokeBuiltin`, and maps errors to `{ ok: false, isError:
true, errorCode, content }` with the host error code preserved.

Registration: three `s.setLocalTool(...)` lines in
`apps/desktop/electron/main/runtime/sidecar.ts`. `index.ts` is not modified
beyond passing the existing service instance (hotspot ratchet, AGENTS.md §7).

### 4.3 Gate before the deadline (host-runtime)

File: `packages/host-runtime/src/agent-sidecar.ts`

`runLocalTool` currently calls the host gate only for `GenerateImages`, inside
the deadline race. Generalize to a small `GATED_LOCAL_TOOLS` set
(`GenerateImages`, `SessionList`, `SessionSend`, `SessionResult`) and run the
`tools.execute` gate **before** the local deadline starts, so an Ask-mode
approval that takes longer than `DEFAULT_RPC_TIMEOUT_MS` (130 s) cannot abort an
approved send. `GenerateImages` keeps its extended deadline. `tools.abort`
still cancels a pending approval (see 4.4).

### 4.4 Host-core gate and risk (Rust)

- `crates/host-core/src/permissions.rs`: `SessionList` / `SessionResult` →
  `Risk::Low`, `SessionSend` → `Risk::High`. `plan_mode_allows` is unchanged,
  so Plan and Goal deny all three.
- `crates/host-core/src/tools/mod.rs`: add a gate-only arm returning
  `{ "authorized": true }` for the three names.
- `crates/host-core/src/rpc/mod.rs` (~line 3965): include `SessionSend` in the
  cancellation-receiver match so an approval wait is abortable.

No schema, migration, or protocol version change.

### 4.5 Runtime catalog (agent-runtime)

New file: `packages/agent-runtime/src/session-tools.ts`, mirroring
`scheduled-tools.ts` (parameters + descriptions). `runtime.ts` adds the names
to the on-demand list next to `scheduledToolParameters` and returns the
descriptions from the existing lookup. The tools are not added to
`SUBAGENT_ASSIGNABLE_TOOLS` and are not core tools.

## 5. Invariants preserved

- Sender identity is never taken from tool arguments.
- The declared `turnId` must still be the session's active turn; an approval that
  outlives its turn is refused, and stopping a turn retracts it.
- A read reports only deliveries the calling session made.
- A session cannot message itself; the target must be in Agent mode; the
  target's effective permission mode cannot exceed the sender's.
- The inbox limit (8 queued per target) and the hop budget (8 autonomous hops
  per chain) are unchanged.
- Deliveries render as session messages, never as human input, and do not take
  part in editing or regeneration.
- Completion callbacks are at most once and never request another callback.
- After restart, unclaimed deliveries are marked interrupted, not replayed.
- Plugin deliveries and built-in deliveries cannot cancel each other (owner
  check in `settlement::cancel`).
- Plan and Goal modes cannot use the tools; subagents cannot use them; MCP
  callers cannot see them.

## 6. Tests (AGENTS.md §12)

| Level | Coverage |
|---|---|
| Main (`apps/desktop/test/session-collaboration-service.test.mjs`) | built-in sender derived from local tool `sessionId`; `sourceSessionId` in args ignored; no active turn → `PERMISSION_DENIED`; plugin context presenting `builtin:session-messaging` rejected; dispatch treats built-in owner as loaded; existing plugin cases unchanged |
| Main (new `apps/desktop/test/session-messaging-tools.test.mjs`) | argument validation, list excludes self and filters by query, default idempotency key from `toolCallId`, error-code mapping |
| host-runtime unit | gate runs before the deadline for gated local tools; Plan mode returns `TOOL_DISABLED_IN_PLAN`; abort during approval cancels |
| Rust unit | risk classification for the three names; contract modes deny them; gate arm authorizes only these names |
| agent-runtime unit | tools are on-demand in Agent mode, absent from Plan/Goal, absent from subagent assignable list |
| E2E | `E2E-SESSION-builtin-send-to-named-session`: A lists, sends to B, B runs with session-message provenance, A receives one completion notice; plus Ask mode showing one approval card |

Gates: `pnpm --filter @minih-agent/desktop typecheck`, `pnpm lint`,
`pnpm -r --if-present test`, `cargo test -p host-core --locked`,
`cargo clippy -p host-core --all-targets`, `node scripts/check-architecture.mjs`,
and the new E2E.

## 7. Spec and doc updates on implementation

- `docs/spec/03-runtime/02-agent-runtime.md` §5f.3: add the built-in path.
- `docs/spec/03-runtime/03-tools-and-permissions.md`: risk, Agent-only scope and
  the gate.
- `docs/spec/06-delivery/04-e2e-test-plan.md`: new scenario.
- `docs/spec/08-meta/decisions-log.md` and the zh mirror: D663.
- No i18n entry: built-in tool names render as-is, exactly like the scheduled
  tools. No changelog: the repository has no changelog file.
- `docs/spec/03-runtime/01-ipc-protocol.md`: the plugin-only paragraph now also
  names the built-in local tools.

## 8. Decisions taken

1. Version one does not create sessions. `spawn` needs worker limits, model
   opt-in (`availableForSubagents`), and inheritance rules; those stay with the
   plugin until a separate decision adds them here.
2. The three tools are on-demand rather than core, so an Agent request does not
   pay their schemas; `ToolSearch` announces them like the scheduled tools.
3. Cancel is not exposed. The ledger supports it, and version one leaves
   cancellation to the target session's own Stop control, which already
   interrupts the claimed delivery turn.
