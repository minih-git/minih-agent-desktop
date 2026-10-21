# 19. Remote Agent Control Protocol

- Protocol name: `PI Remote Agent Control Protocol` (`RACP`)
- Version: `1.0`
- Status: Target specification; post-MVP. The MVP itself does not include
  remote control; post-MVP the Gateway and browser milestones are scheduled
  as R4–R6 by D665 (ADR 0331)
- Decision: D373 / ADR 0205, amended by D374, D375, and D665
- Transport profiles: `RACP-WS` (normative v1 binding; first deployed over an
  SSH tunnel), `RACP-HTTP` (browser profile; binds with R4), `RACP-GRPC`
  (reserved)

This document is normative for the remote control contract. It defines the
operation model once and maps it to transports. It does not change the
existing Electron IPC, sidecar JSON-RPC, Rust host-core RPC, or local MCP
protocols.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
and **MAY** are to be interpreted as requirements for a future implementation.

## 1. Contract boundaries

RACP controls a running Agent Host. It is not:

- a public version of Electron IPC;
- a public version of `host.proxy`;
- a host-core network protocol;
- a provider or model API proxy;
- an arbitrary command/shell API;
- the local MCP control plane; or
- the withdrawn subagent A2A/Peer protocol.

The Agent Host remains responsible for authentication context, authorization,
workspace selection, tool policy, permission decisions, persistence, and
provider credentials. A RACP server MUST route a request through those same
authorities rather than reproducing them in a Gateway or client.

RACP v1 is a strict subset of what the local desktop can do. The remote-host
profile in §6.2 is the v1.1 addition that lets the desktop itself act as the
Remote Client of a `agent-host-cli` on another machine (D375); operations that stay
deferred are listed in §6.3 so that no binding invents them under another
name.

## 2. Terminology

| Term | Meaning |
|---|---|
| Host | The logical Agent Host that owns sessions and executes turns |
| Client | A UI, CLI, native application, or service controlling a Host |
| Gateway | An optional authenticated router between Clients and Hosts |
| Session | A durable conversation and workspace/project binding |
| Turn | One admitted prompt and its whole model/tool lifecycle; it equals the local `turnId` returned by `agent/prompt`, not one local `turn_start`/`turn_end` model round |
| Item | A durable unit inside a Turn: a message, a tool call, or a compaction checkpoint |
| Event | An ordered state or progress notification for a Session or a Host |
| Durable event | An event that receives a sequence number and is retained for replay |
| Ephemeral event | A progress event that is delivered live, never sequenced, and never replayed |
| Epoch | A Host-generated identifier for one continuous sequence stream of a Session |
| Cursor | An `{ epoch, sequence }` position inside a Session's durable event stream |
| Principal | The authenticated user, device, service, or Gateway identity |
| Binding | A transport-specific encoding of the RACP operations |
| Host link | The outbound Gateway-to-Host connection that relays logical client connections |

## 3. Version and initialization

Every remote connection MUST begin with `connection/initialize`. No other
request, notification, or server request is valid before the initialization
response and the client's `notifications/initialized` notification.

The client sends:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "connection/initialize",
  "params": {
    "protocolVersion": "1.0",
    "client": {
      "name": "minih-agent-desktop-web",
      "version": "0.1.0"
    },
    "bindings": ["RACP-WS", "RACP-HTTP"],
    "capabilities": {
      "eventReplay": true,
      "approvals": true,
      "inputRequests": true,
      "attachments": true,
      "turnQueue": true,
      "hostEvents": true,
      "history": true,
      "toolRelay": true,
      "terminal": true
    },
    "maxReceiveBytes": 1048576
  }
}
```

The Host returns:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "result": {
    "protocolVersion": "1.0",
    "server": {
      "name": "minih-agent-desktop-agent-host",
      "version": "0.1.0"
    },
    "connectionId": "conn_01J...",
    "principal": {
      "subject": "user_123",
      "roles": ["viewer", "controller"]
    },
    "capabilities": {
      "eventReplay": true,
      "snapshot": true,
      "approvals": true,
      "inputRequests": true,
      "attachments": true,
      "serverRequests": true,
      "turnQueue": true,
      "hostEvents": true,
      "history": true,
      "remoteHostProfile": true,
      "toolRelay": true,
      "terminal": true,
      "notifications": false,
      "bindings": ["RACP-WS"]
    },
    "limits": {
      "maxFrameBytes": 1048576,
      "maxPromptBytes": 262144,
      "maxAttachmentBytes": 52428800,
      "maxSubscriptionsPerConnection": 8,
      "maxQueuedTurnsPerSession": 8,
      "replayWindowEvents": 10000
    },
    "policy": {
      "remoteMaxPermissionMode": "ask",
      "applyCeilingToPairedDevices": false,
      "approvalLifetimeMs": 1800000
    }
  }
}
```

The Host MUST reject unsupported major versions with `PROTOCOL_MISMATCH`.
Minor-version additions are compatible when the client can ignore unknown
fields and the Host does not require an unadvertised capability.

`policy` is informational. It tells a client which permission ceiling applies
to turns it starts (§7.3) and how long an approval stays answerable (§12). A
client cannot change either value through RACP.

## 4. Message envelopes

### 4.1 JSON-RPC profiles

`RACP-WS` uses JSON-RPC 2.0 messages. Each WebSocket text frame contains one
complete UTF-8 JSON-RPC message. Binary frames are rejected on client
connections. JSON-RPC batch requests are not supported.

`RACP-HTTP` maps each operation to one HTTP request with an equivalent JSON
operation body; it does not require a JSON-RPC envelope. Responses are JSON
domain objects. The request context is carried in the operation body and, where
available, the equivalent `X-Request-Id`, `Idempotency-Key`, and
`If-Match-Revision` headers. Event streaming uses `text/event-stream`; each
SSE `data` field contains one `EventEnvelope` JSON object, not a JSON-RPC
notification.

Requests that mutate state MUST include an application-level
`idempotencyKey`, stable for the lifetime of a retry. JSON-RPC `id` identifies
the transport request; it is not the idempotency key.

### 4.2 Common request fields

```ts
type RequestContext = {
  requestId: string
  idempotencyKey?: string
  expectedRevision?: number
  traceparent?: string
}
```

The binding maps `RequestContext` into the JSON-RPC `params.context` object,
HTTP headers, or transport metadata. A Gateway MUST preserve the context values
and MUST NOT replace an idempotency key while retrying a request.

### 4.3 Server notifications and requests

The WebSocket binding MAY send server notifications and server-initiated
requests. A server request has its own JSON-RPC id and MUST receive a response
on the same logical client connection (§11.4 defines how a Gateway relays that
connection).

The HTTP/SSE binding cannot require a client to answer a server-initiated JSON-
RPC request. It represents approval and input requests as events and requires
the client to call the corresponding `approval/respond` or `input/respond`
HTTP endpoint.

## 5. Canonical resources

The following shapes define the semantic model. They are authored as typebox
schemas in `packages/shared` (frozen decision 28); the JSON Schema fixtures and
any future Protobuf file are generated from that source (§14). Every binding
MUST preserve field meaning and state transitions.

### 5.1 Session

```ts
type Session = {
  id: string
  title: string
  projectId?: string
  workspaceLabel?: string
  mode: "agent" | "plan" | "goal"
  status: "idle" | "running" | "waiting_permission" | "waiting_input" | "aborted" | "error"
  planningState: "inactive" | "planning" | "awaiting_approval"
  permissionMode: "ask" | "accept-edits" | "auto"
  activeTurnId?: string
  queuedTurnIds: string[]
  revision: number
  createdAt: string
  updatedAt: string
}
```

`status` and `planningState` mirror the local session state machine
(`10-session-state-machine.md` §0–§1): `planningState` is the Plan/Goal
projection and `awaiting_approval` means a pending contract approval exists
even though no turn is running. `waiting_input` means the agent asked a question
and holds the turn open until it is answered; it is distinct from
`waiting_permission`, which is a tool call waiting to be allowed, because the two
are answered on different surfaces (a form versus an allow/deny decision). A
client that lists sessions must show the two separately — a phone that cannot
tell them apart reads a question as a busy turn (UX spec §17.4.1). An absolute workspace path MUST NOT be
included unless the principal has an explicit path-disclosure scope. A
`workspaceLabel` is display-only.

### 5.2 Turn

```ts
type Turn = {
  id: string
  sessionId: string
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "completed"
    | "interrupted"
    | "failed"
    | "canceled"
  admission: "reject_if_busy" | "queue"
  queuePosition?: number
  effectivePermissionMode: "ask" | "accept-edits" | "auto"
  idempotencyKey?: string
  startedAt?: string
  endedAt?: string
  error?: RemoteError
}
```

Only one turn per session may be `running`, `waiting_approval`, or
`waiting_input`. Up to `maxQueuedTurnsPerSession` turns may be `queued`; the
Host releases them first-in first-out after the active turn's terminal event.
Queued turns and their idempotency keys are persisted by Rust host-core
(D375), so a Host restart restores the queue in order. A restored queue is
held; release resumes on the first controller attach, local or remote, so a
reboot never starts work unattended.
Runtime events received before a queued start is acknowledged belong to the
dequeued turn being started. They must not change the next waiting entry's
status or prevent that entry from being canceled.
`canceled` is the terminal state of a queued turn that never started;
`interrupted` is the terminal state of a started turn that was stopped or
aborted. Terminal turns are immutable.

`effectivePermissionMode` is the mode the Host actually applied to the turn
after the remote permission ceiling in §7.3. It never changes the durable
`Session.permissionMode`.

### 5.3 Event envelope

```ts
type EventEnvelope = {
  eventId: string
  scope: "session" | "host"
  sessionId?: string
  turnId?: string
  epoch: string
  sequence?: number
  afterSequence?: number
  revision: number
  kind: EventKind
  occurredAt: string
  parentToolCallId?: string
  agentName?: string
  payload: unknown
}

type EventKind =
  | "session.created"
  | "session.changed"
  | "session.archived"
  | "host.changed"
  | "turn.queued"
  | "turn.started"
  | "turn.completed"
  | "turn.interrupted"
  | "turn.failed"
  | "turn.canceled"
  | "turn.activity"
  | "item.started"
  | "item.delta"
  | "item.completed"
  | "tool.progress"
  | "terminal.changed"
  | "terminal.output"
  | "approval.requested"
  | "approval.resolved"
  | "input.requested"
  | "input.resolved"
  | "resync.required"
```

Durable events carry `sequence`. Ephemeral events (`turn.activity`,
`item.delta`, `tool.progress`, `terminal.output`) carry `afterSequence`
instead: the sequence of the last durable event they follow. Ephemeral events are never retained,
never replayed, and never counted against the replay window; the snapshot's
`activeItems` carry the content they accumulated (§5.4). A client applies gap
detection to `sequence` only.

`sequence` is allocated by the Host, starts at `1` for a new epoch, is
strictly increasing inside that epoch, and is never derived from
`occurredAt`. A new `epoch` starts whenever the Host cannot prove continuity,
for example after a Host process restart; the pair `(epoch, sequence)` is
therefore never reused for a Session. A Gateway MUST forward both unchanged.

`parentToolCallId` and `agentName` are set on every event emitted inside a
subagent, exactly as on the local `AgentEventEnvelope` (ADR 0062), so a remote
transcript can nest delegate rows the same way the desktop does.

Turn-scoped kinds carry the shared normalized `AgentEvent` unchanged under
`payload.event`, plus `payload.itemType` for item kinds, so a remote client can
reuse the desktop transcript reducer instead of implementing a second one. The
mapping is fixed:

| Local `AgentEvent.type` | RACP `kind` | Durable | Notes |
|---|---|---|---|
| `agent_start` | `turn.started` | yes | `turn.queued` precedes it for queued admissions |
| `agent_end` | `turn.completed` or `turn.interrupted` | yes | `interrupted` when the Host recorded the turn as aborted or stopped |
| `error` (terminal) | `turn.failed` | yes | Carries the normalized `AppError` |
| `turn_start`, `turn_end`, `status` | `turn.activity` | no | Model rounds and activity phases such as `waiting-model`, `compacting`, `waiting-subagents` |
| `message_start` | `item.started` | yes | `itemType: "message"` |
| `message_update` | `item.delta` | no | `stream: \"delta\"` plus `deltaText`/`deltaThinking`; content is complete in `item.completed` (D412) |
| `message_end` | `item.completed` | yes | Full `UiMessage` |
| `tool_start` | `item.started` | yes | `itemType: "tool"` |
| `tool_update` | `tool.progress` | no | Partial results are complete in `item.completed` |
| `tool_end` | `item.completed` | yes | Full result with `isError` and usage |
| `compaction_start`, `compaction_end` | `item.started`, `item.completed` | yes | `itemType: "compaction"`; compaction adds a transcript row locally (D203) |
| `planning_state`, host `plans.changed` | `session.changed` | yes | Planning projection and contract approval state |
| `tool_permission_request` | `approval.requested` | yes | `kind: "tool"` |
| host `plans.changed` with a `pending` proposal | `approval.requested` | yes | `kind: "plan"` or `"goal"`; resolution arrives as `approval.resolved` plus `session.changed` |
| `asktool_request` | `input.requested` | yes | Same questions as the local asktool card |

`turn.completed` therefore maps to the local `agent_end`, never to the local
`turn_end`, which only closes one model round (`01-ipc-protocol.md` §6).

`terminal.changed` (durable) records a terminal opening, closing, or exiting.
`terminal.output` (ephemeral) carries pty bytes; it is recoverable only from
the terminal's bounded replay ring (§6.2), never from the event log.

An event payload that would exceed `maxFrameBytes` is emitted with
`payload.truncated: true` and a bounded preview; `session/history` returns the
item `itemId` names, capped for display the way §7.6 describes. Events are
never dropped to satisfy the frame limit.

### 5.4 Snapshot

```ts
type ItemSummary = {
  id: string
  turnId: string
  itemType: "message" | "tool" | "compaction"
  status: "streaming" | "completed"
  sequence?: number
  createdAt: string
  parentToolCallId?: string
  agentName?: string
  content: unknown
}

type SessionSnapshot = {
  session: Session
  activeTurn?: Turn
  queuedTurns: Turn[]
  items: ItemSummary[]
  activeItems: ItemSummary[]
  pendingApprovals: ApprovalRequest[]
  pendingInputs: InputRequest[]
  hasMoreHistory: boolean
  cursor: { epoch: string; sequence: number }
  revision: number
  generatedAt: string
}
```

`items` is the newest bounded page of completed items; older pages come from
`session/history`. `activeItems` are the in-flight message and tool items with
the content accumulated so far, which is why ephemeral deltas need no replay;
the Host builds them from the same in-flight state that feeds the local
inflight checkpoint (D299). `pendingApprovals` and `pendingInputs` let a
late-attaching client render open requests that were raised before it
subscribed. A snapshot is valid only together with its `cursor` and
`revision`: a client that attaches and then opens the stream must start that
stream at the snapshot's `cursor` (or attach after subscribing), because the
snapshot does not say where the stream begins and the events between the two
calls are otherwise lost.

### 5.5 Approval and input request

Approval decisions are a superset of the local vocabulary, never a
simplification of it. A tool approval offers the local
`ToolPermissionResolution` decisions; a Plan or Goal approval offers the local
`plans.resolve` actions plus the explicit permission-mode selection the
desktop requires (`10-session-state-machine.md` §3.13).

```ts
type ToolApprovalDecision = "allow-once" | "allow-session" | "deny"
type ContractApprovalDecision = "approve" | "reject"

type ApprovalRequest = {
  id: string
  sessionId: string
  turnId: string
  kind: "tool" | "plan" | "goal"
  summary: string
  expiresAt: string
  revision: number
  toolName?: string
  risk?: "low" | "medium" | "high"
  agentName?: string
  parentToolCallId?: string
  title?: string
  question?: string
  artifact?: { relativePath: string; sha256: string; sizeBytes: number }
  allowedDecisions: ToolApprovalDecision[] | ContractApprovalDecision[]
  allowedPermissionModes?: Array<"ask" | "accept-edits" | "auto">
}

type ApprovalResponse = {
  approvalId: string
  decision: ToolApprovalDecision | ContractApprovalDecision
  permissionMode?: "ask" | "accept-edits" | "auto"
  context: RequestContext
}

type InputRequest = {
  id: string
  sessionId: string
  turnId: string
  expiresAt: string
  agentName?: string
  parentToolCallId?: string
  questions: Array<{
    id: string
    question: string
    options: string[]
    multiSelect: boolean
  }>
}

type InputResponse = {
  inputId: string
  answers: Array<string[] | null>
  context: RequestContext
}
```

Rules:

1. `allow-session` grants the tool by name for the rest of the Session
   (frozen decision 18). The Host offers it to a remote approver only when its
   policy allows session grants from remote principals; otherwise
   `allowedDecisions` omits it.
2. A Plan or Goal approval is a session-level transition, not an in-turn wait.
   `turnId` identifies the submitting turn, the request outlives that turn,
   `Session.planningState` is `awaiting_approval` while it is pending, and a
   Host restart interrupts it without replay. `approve` requires
   `permissionMode` from `allowedPermissionModes`; the desktop default is
   `ask`.
3. An `InputResponse` answer of `null` means the question was skipped; the
   whole array may be `null` entries when the user declined the prompt, which
   is the local `AskToolResolution` contract.
4. Approval summaries MUST be safe to display. Raw provider credentials,
   secret values, and unbounded tool results are never included.
5. Expiry maps a legacy `PERMISSION_TIMEOUT` from an older local host, and
   `PLAN_APPROVAL_TIMEOUT`, to `APPROVAL_EXPIRED`; the tool is never executed
   after expiry. Current local permission prompts do not expire.

### 5.6 Attachment

```ts
type Attachment = {
  id: string
  sessionId: string
  name: string
  mimeType: string
  sizeBytes: number
  sha256: string
  status: "pending" | "ready" | "expired" | "rejected"
  expiresAt: string
}
```

Remote turns reference attachment ids. They MUST NOT send a local absolute path
and MUST NOT make a remote client path visible to host tools.

### 5.7 Host and project summaries

```ts
type HostSummary = {
  id: string
  label: string
  status: "online" | "offline"
  lastSeenAt: string
  protocolVersion: string
}

type ProjectSummary = {
  id: string
  label: string
  archived: boolean
}
```

`HostSummary` exists only behind a Gateway, which is the only place a principal
has more than one Host. `ProjectSummary` never contains an absolute path unless
the principal has the path-disclosure scope.

## 6. Operation catalog

### 6.1 v1 operations

All operation names are lower-case, singular-resource paths. Every binding maps
to this same catalog.

| Operation | Role | Behavior |
|---|---|---|
| `connection/initialize` | authenticated | Negotiate protocol, capabilities, limits, and policy |
| `connection/ping` | authenticated | Return connection health and server time |
| `host/list` | authenticated | List Hosts visible to the principal; Gateway deployments only |
| `project/list` | viewer | List projects the principal may create sessions under |
| `model/list` | viewer | List the models the principal may start a session on (§16.1) |
| `session/list` | viewer | List sessions visible to the principal |
| `session/get` | viewer | Return metadata and current state |
| `session/create` | controller | Create a session under an authorized project id |
| `session/attach` | viewer | Establish a session role and return a snapshot |
| `session/history` | viewer | Page older completed items backwards from an item id |
| `events/subscribe` | viewer | Subscribe to a session or host stream from a cursor |
| `events/unsubscribe` | viewer | Remove a subscription |
| `events/ack` | viewer | Acknowledge the highest applied durable sequence |
| `turn/start` | controller | Admit a turn immediately or into the Host queue; return `turnId` |
| `turn/get` | viewer | Return the current turn state |
| `turn/stop` | controller | Finish the current assistant/tool boundary, then end the turn; idempotent |
| `turn/interrupt` | controller | Abort the turn now; cancels a queued turn; idempotent |
| `turn/cancel` | controller | Remove a queued turn that has not started; idempotent |
| `turn/prioritize` | controller | Move a queued turn to the head of its session's queue; idempotent |
| `approval/respond` | approver | Resolve one live approval request |
| `input/respond` | controller | Resolve one live input request |
| `attachment/create` | controller | Reserve a bounded attachment slot |
| `attachment/complete` | controller | Verify an uploaded attachment hash and size |
| `tools/advertise` | owner | Advertise client-executed tools for a session; replaces the connection's previous set; cleared on disconnect |
| `session/revoke` | owner | Revoke a client or session membership |
| `session/archive` | owner | Archive an idle session |

The server MUST reject unknown operations with `METHOD_NOT_FOUND`. A client
MUST use capability discovery rather than assuming optional operations exist.

### 6.2 Remote-host profile (v1.1, required by rollout R2)

When the desktop is the Remote Client of a `agent-host-cli` on another machine, the
renderer expects the session controls it has locally. These operations are
part of the contract from v1.1 and are advertised through the
`remoteHostProfile` capability. Each one keeps its local rule: configuration
and fork are idle-only, deletion is owner-only, and every workspace read is
resolved against the Session's durable root with the Host's ignore rules and
`PATH_OUTSIDE_WORKSPACE` boundary. Terminals run on the Host machine with the
session root as working directory and stream through `terminal.output`.

| Operation | Role | Behavior |
|---|---|---|
| `session/configure` | controller | Change mode, provider/model, thinking level, or permission mode while idle; same rules as `minih-agent-desktop/session/configure` |
| `session/fork` | controller | Fork an idle session, optionally through a message id, into a new idle session |
| `session/rename` | controller | Rename a session |
| `session/deriveTitle` | controller | Apply the Host's deterministic first-prompt title to a still-untitled session; returns `{ updated }` and never overrides a rename |
| `session/delete` | owner | Delete a session and its transcript on the Host |
| `session/compact` | controller | Run a manual context checkpoint on the active session |
| `workspace/list` | viewer | List entries under the session root, bounded, honoring the Host ignore rules |
| `workspace/read` | viewer | Read one bounded file under the session root; images as data URLs |
| `workspace/diff` | viewer | Return the working-tree diff of the session root |
| `terminal/open` | controller | Open a pty on the Host with the session root as cwd; returns a terminal id and the bounded replay ring; policy-gated (security §4.1) |
| `terminal/input` | controller | Write bytes to an open terminal |
| `terminal/resize` | controller | Resize an open terminal |
| `terminal/close` | controller | Close a terminal; idempotent |
| `connection/pair` | authenticated | Exchange the single-use pairing token presented on the upgrade for a device credential (security §3.4); only valid on a pairing connection (D448) |
| `project/register` | controller | Register a Host directory as a project: the Host canonicalizes the path, confines it to its browse root (the user's home directory), and returns the project id (D448; role lowered from owner by the D666 amendment of 2026-10-19) |
| `project/browse` | controller | List directories under a Host path, bounded, confined to the same browse root, for the remote folder picker (D448; role lowered from owner by the D666 amendment of 2026-10-19) |

### 6.2.1 Local-Agent workspace services

New Desktop remote projects keep the Agent, transcript, project metadata, model
selection and provider transport locally. These additive, owner-only operations
serve their remote tool workspace without creating a Host project or session.
Legacy remote-Agent operations above remain unchanged.

- `workspace/toolShell` accepts `{}` and returns `{ shell: CommandShellOption }`.
  Desktop supplies this effective Host shell to its local Agent. Bash execution
  verifies the same shell id and dialect, including a second check before spawn.
- `workspace/toolExecute` accepts `{ path, sessionId, turnId, toolCallId,
  toolName, args, timeoutMs?, expectedCommandShellId?,
  expectedCommandShellDialect? }`. Only Read, Glob, Grep, Write, Edit and Bash are
  accepted; extra top-level fields and provider/credential inputs are rejected.
  `path` is the owner-selected absolute workspace root, independently
  canonicalized by the Host. Local permissions and tool admission precede this
  RPC. The Host reuses the existing bounded runner and containment rules with
  external paths disabled. It returns the ordinary `{ ok, content, isError?,
  errorCode?, toolCallId?, ...runnerMetadata }` result.
- `workspace/toolAbort` accepts `{ sessionId, toolCallId }`, and cancels only
  the calling device's active operation. Closing the originating connection
  cancels its outstanding calls. Host restarts invalidate late results.
- `workspace/files` accepts `{ path, operation, ref?, mimeType? }`, where
  operation is list/read/index/resolve/image/diff/instructions. It reads only the
  canonical workspace boundary using existing helpers and no persistent Host
  session. Existing operations and their payloads remain unchanged; this is an
  additive operation, not a protocol-major change.
  For `instructions`, Desktop sends `{ path, operation: "instructions" }` and
  the Host returns `{ entries: [{ source, content }] }`, or `{ entries: [] }`.
  Root-only selection takes the first readable, nonempty, contained file in
  `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` order.
  A file symlink escaping the root is skipped. At most one entry is returned;
  `source` is that recognized relative name, not a remote HOME or absolute path.
  File content is capped at 32 KiB of UTF-8 without splitting a character, with
  an explicit truncation notice. Desktop validates recognized sources, at most
  one entry and at most 33,280 UTF-8 bytes including the notice, then merges
  local global defaults before remote root instructions. Nested traversal and
  remote global defaults are not supported by this operation.

`workspaceTools` and `workspaceFiles` are optional advertised capabilities; an
older Host fails with CAPABILITY_UNAVAILABLE/METHOD_NOT_FOUND rather than
falling back to the Desktop filesystem. Tools are not automatically replayed
on reconnect. The Host namespaces execution by paired device and local session,
limits concurrent tools to 32, retains a bounded 4096-key replay fence, and bounds
arguments/results to 1 MiB. These services never carry model requests, model
settings, provider headers, API keys or OAuth tokens.

If Write/Edit/Bash loses its reply with HOST_DISCONNECTED, TIMEOUT,
AGENT_UNAVAILABLE or REMOTE_CONNECTION_FAILED, the Desktop relay reports
`REMOTE_MUTATION_OUTCOME_UNKNOWN` with `retriable: false`. It cannot prove that
the mutation did or did not run; inspect remote state before an explicit retry.
This is a Desktop execution error mapping, not a new wire method or an
exactly-once guarantee. Read/Glob/Grep retain their ordinary failure mapping.

### 6.3 Deferred operations

The desktop offers these locally. RACP does not expose them yet; the names
are reserved so a later minor version adds them under the same catalog and
no binding invents a substitute.

| Reserved operation | Local equivalent | Why deferred |
|---|---|---|
| per-turn model or thinking override | composer next-turn configuration | `session/configure` covers the idle case; per-turn overrides need their own policy review |
| provider, secret, and vendor account management | settings and secrets IPC | Explicitly out of scope; remote Host providers are configured over the SSH bootstrap channel |

## 7. Core operation shapes

### 7.1 `session/attach`

Request:

```json
{
  "sessionId": "ses_01J...",
  "role": "controller",
  "after": { "epoch": "ep_7f", "sequence": 314 },
  "includeSnapshot": true,
  "context": {
    "requestId": "req_attach_1"
  }
}
```

Response:

```json
{
  "session": { "id": "ses_01J...", "status": "idle", "revision": 22 },
  "role": "controller",
  "replayComplete": true,
  "snapshot": {
    "cursor": { "epoch": "ep_7f", "sequence": 314 },
    "revision": 22,
    "items": [],
    "activeItems": [],
    "queuedTurns": [],
    "pendingApprovals": [],
    "pendingInputs": [],
    "hasMoreHistory": true
  }
}
```

If `after` names an epoch the Host no longer serves, or a sequence older than
the retained window, the response MUST set `replayComplete` to `false` and
include a current snapshot. The client MUST NOT present the result as a
continuous replay.

### 7.2 `events/subscribe`

Request:

```json
{
  "scope": "session",
  "sessionId": "ses_01J...",
  "after": { "epoch": "ep_7f", "sequence": 314 },
  "includeSnapshot": false,
  "context": { "requestId": "req_events_1" }
}
```

Response:

```json
{
  "subscriptionId": "sub_01J...",
  "scope": "session",
  "sessionId": "ses_01J...",
  "starting": { "epoch": "ep_7f", "sequence": 315 },
  "replayComplete": true
}
```

`scope: "host"` omits `sessionId` and subscribes to `session.created`,
`session.changed`, `session.archived`, and `host.changed` for every session
the principal may see, with its own epoch and sequence stream. Without a host
subscription a client never learns about sessions the local user creates.

The WebSocket server then sends `session/event` notifications. The HTTP server
returns an SSE stream whose `id` is `"<epoch>:<sequence>"` and whose `data` is
the `EventEnvelope`. A client MUST treat an SSE `Last-Event-ID` as `after` on
reconnect.

### 7.3 `turn/start`

Request:

```json
{
  "sessionId": "ses_01J...",
  "idempotencyKey": "turn-client-7f9c",
  "admission": "queue",
  "input": {
    "text": "Inspect the failing test and propose a fix.",
    "attachments": []
  },
  "context": {
    "requestId": "req_turn_1",
    "expectedRevision": 22
  }
}
```

Response:

```json
{
  "accepted": true,
  "turn": {
    "id": "turn_01J...",
    "sessionId": "ses_01J...",
    "status": "queued",
    "admission": "queue",
    "queuePosition": 1,
    "effectivePermissionMode": "ask",
    "idempotencyKey": "turn-client-7f9c"
  },
  "cursor": { "epoch": "ep_7f", "sequence": 315 }
}
```

The response is an admission result, not the final model response. Repeating
the same request with the same principal and idempotency key returns the same
turn. Reusing the key with different input returns `IDEMPOTENCY_CONFLICT`.

`admission` defaults to `reject_if_busy`, which returns `AGENT_BUSY` while a
turn is active, exactly like a direct local prompt. `queue` places the turn in
the Host-owned per-session queue; the Host releases queued turns in order
after the active turn's terminal event and emits `turn.queued` immediately.
The queue lives in the Host so every client, including the local desktop,
sees the same pending prompts; a client-side queue is not part of the
contract. A full queue returns `AGENT_BUSY` with `details.queueFull: true`.

The Host applies a remote permission ceiling: a turn started by a remote
principal runs under the lower of `Session.permissionMode` and the Host's
`remoteMaxPermissionMode` (default `ask`, ordered `ask` <
`accept-edits` < `auto`) unless the principal also holds `approver` and Host
policy allows approvers to use the session's own mode. The result reports the
applied value as `effectivePermissionMode`; the durable session mode is never
changed by the ceiling. A desktop device paired through the SSH bootstrap
holds `owner` and is exempt from the ceiling by default; the Host policy
`applyCeilingToPairedDevices` re-applies it
(`05-security/02-remote-control-security.md` §4.3).

### 7.4 `turn/stop`, `turn/interrupt`, and `turn/cancel`

Request:

```json
{
  "turnId": "turn_01J...",
  "reason": "user_requested",
  "context": {
    "requestId": "req_interrupt_1",
    "idempotencyKey": "interrupt-turn_01J..."
  }
}
```

The three operations share this shape and each returns the current turn state.

- `turn/stop` is the local graceful stop: the Host finishes the current
  assistant response and tool batch, then ends the turn as `completed` at the
  next boundary and releases the next queued turn. It does not cancel an
  active provider stream or running tool.
- `turn/interrupt` is the local abort: the Host stops the stream, cancels
  interruptible tools, and ends the turn as `interrupted`. Completed writes
  are never rolled back. On a queued turn it behaves as `turn/cancel`.
- `turn/cancel` removes a queued turn and marks it `canceled`; on a started
  turn it returns `CONFLICT`.
- `turn/prioritize` moves a queued turn to the head of its session's queue
  (the desktop's "send now") and emits `turn.queued` with the new position;
  it never touches the running turn, so a client that wants the entry to
  start at the next boundary also calls `turn/stop`. On a started turn it
  returns `CONFLICT`.

A late call after a terminal event is a successful no-op. None of the three
rewinds a persisted transcript.

### 7.5 `approval/respond` and `input/respond`

`approval/respond` carries an `ApprovalResponse`; `input/respond` carries an
`InputResponse` (§5.5). Both require `context.idempotencyKey` and
`context.expectedRevision`. The Host verifies the request id, session, turn,
principal role, expiry, allowed decision, permission-mode selection, and
current revision in one operation and answers with the resulting state:

```json
{
  "approvalId": "approval_01J...",
  "status": "resolved",
  "decision": "allow-session",
  "alreadyResolved": false,
  "revision": 23
}
```

A second valid response for an already-resolved request returns the stored
result with `alreadyResolved: true`; it never re-executes or reverses the
decision.

### 7.6 `session/history`

Request:

```json
{
  "sessionId": "ses_01J...",
  "beforeItemId": "item_01J...",
  "limit": 100,
  "context": { "requestId": "req_history_1" }
}
```

The response is `{ items: ItemSummary[], hasMore: boolean, revision: number }`
ordered oldest to newest. `limit` is capped at 200. Omitting `beforeItemId`
returns the page that precedes the snapshot's `items`. The same operation
returns a single complete item when a truncated event points at it.

A page is one bounded window of the transcript, not the whole file: the Host
reads `limit` items ending where `beforeItemId` names and reports `hasMore`
from the transcript itself, so a client pages a long conversation without the
Host materializing it.
A row that appears on more than one physical line — a retried append, a
rewritten row — resolves to the position it is rendered at, which is its first
occurrence, so "the page before it" is strictly older than it. Resolving a later
duplicate instead makes the window overlap the rows the client already holds, and
a client that deduplicates then sees a page with nothing new in it. `hasMore` is the only signal that older items exist;
when the named item is gone (a compaction rewrote the transcript after the
client read a page) the Host answers an empty page with `hasMore: false`
instead of the tail, because the tail would be replayed into the client's
older-page slot.

The Host MAY cap the display size of an item's text and tool payload. The cap
is per field and counts characters, `limit` counts items and is never affected
by it, and what was clipped is marked inside the returned text
(`[truncated for display; the full content remains in the transcript]`), which
is the same cap and the same marker the desktop renderer's own bounded
transcript reads use. A capped item is therefore self-describing: a client
renders the marker instead of guessing. §5.3's truncated-event preview is
served by this operation and inherits the cap.

### 7.7 `host/list` and `project/list`

`host/list` returns `HostSummary[]` and exists only behind a Gateway; a direct
Host connection returns `METHOD_NOT_FOUND`. `project/list` returns
`ProjectSummary[]` for the projects the principal may create sessions under,
so `session/create` never needs a path.

## 8. Event replay and backpressure

The Host MUST retain enough durable events to cover the configured replay
window. The initial target is:

- 10,000 durable events per session or 24 hours, whichever comes first;
- ephemeral events are never retained;
- eight subscriptions per session per principal;
- sixteen connected clients per Agent Host;
- one megabyte maximum encoded event/frame; and
- a bounded per-connection send queue.

Because deltas and activity phases are ephemeral, a long streaming turn cannot
exhaust the replay window by itself; the window is consumed only by item and
lifecycle boundaries.

Where the log lives is an ownership decision, not a binding detail. In the
first implementation the durable event log is kept in Agent Host process
memory, a Host restart therefore starts a new epoch, and every reconnecting
client resynchronizes from a snapshot. Rust host-core owns SQLite exclusively
(frozen decision 12); moving the log into host-core requires its own ADR and a
schema decision, and is not implied by this specification.

The Host MAY evict old durable events after the limit. Eviction and epoch
change MUST make the cursor invalid and cause `resync.required`, never silent
loss.

WebSocket clients SHOULD send `events/ack` with the highest applied durable
sequence. The Host MAY use the acknowledgment to release transport buffers, but
it MUST NOT delete durable session state solely because a client acknowledged
an event.

When a client is too slow for the send queue, the Host MAY drop ephemeral
events first. If durable events would be lost, it MUST close the subscription
or connection with `CLIENT_TOO_SLOW` and include the last safely queued
cursor. The client reconnects with that cursor.

## 9. Server-initiated approval and input

### 9.1 WebSocket

The Host sends:

```json
{
  "jsonrpc": "2.0",
  "id": "server-request-42",
  "method": "approval/request",
  "params": {
    "approval": {
      "id": "approval_01J...",
      "sessionId": "ses_01J...",
      "turnId": "turn_01J...",
      "kind": "tool",
      "summary": "Run the selected shell command",
      "toolName": "Bash",
      "risk": "medium",
      "expiresAt": "2026-09-09T12:00:00.000Z",
      "revision": 22,
      "allowedDecisions": ["allow-once", "allow-session", "deny"]
    }
  }
}
```

The client responds to the same JSON-RPC id with an `ApprovalResponse`. The
Host then emits `approval.resolved` to every subscriber, including the local
desktop renderer, so an open confirmation card closes wherever it is shown.

### 9.2 HTTP/SSE

The Host emits an `approval.requested` SSE event. The client calls:

```text
POST /v1/approvals/{approvalId}:respond
```

with an `ApprovalResponse`. Closing the SSE stream does not approve, reject,
or cancel the approval.

### 9.3 Resolution rules

Only the Host may move an approval or input request to a terminal state. The
first valid decision wins whether it arrives as a server-request response, an
`approval/respond` call, or the local desktop card; later valid responses
return the stored result with `alreadyResolved: true`. Expiry, stale session
revision, an unknown request id, a decision outside `allowedDecisions`, or a
missing `permissionMode` on a contract approval fails closed.

Pending requests are Host state, not connection state. Host-core already owns
the pending permission table and its timer; the Agent Host exposes that table
through a `permissions.pending` read so a late-attaching client receives open
requests in its snapshot and every client sees the same resolution.

### 9.4 Relayed tool execution

A desktop paired as `owner` MAY advertise tools that execute on the desktop
(`tools/advertise`): its user-configured MCP servers and plugin tools that do
not require the session workspace. The Host merges them into that session's
catalog as relayed tools while the advertising connection lives. When the
Agent calls one, the Host runs its normal permission flow first, then sends
a server request on the advertising connection:

```json
{
  "jsonrpc": "2.0",
  "id": "server-request-77",
  "method": "tool/execute",
  "params": {
    "executionId": "exec_01J...",
    "sessionId": "ses_01J...",
    "turnId": "turn_01J...",
    "toolCallId": "call_01J...",
    "toolName": "mcp_corp_search",
    "args": { "query": "release notes" }
  }
}
```

The client executes the tool locally under its own plugin permissions and
confirmation rules and responds with `{ result, isError }` bounded by
`maxFrameBytes`, or with an error. Rules:

1. A relayed tool never runs on the Host and never receives Host secrets; the
   Host passes only the Agent's arguments, which are untrusted.
2. The Host-side permission decision, including session grants, precedes the
   relay request; the client does not re-ask the Host.
3. The request deadline is the tool's own timeout. If the advertising
   connection is gone or does not answer, the tool fails with `TOOL_FAILED`
   and the turn continues; nothing is retried on another connection.
4. Plugin tools whose manifest requires workspace or filesystem access are
   not accepted by `tools/advertise`, because they would act on the desktop's
   filesystem while the session root is on the Host.
5. Relayed results are items like any other and are audited on both sides.

## 10. Attachments

Small text and image inputs MAY be embedded in `turn/start` when their encoded
request remains below `maxPromptBytes`. This inline form is implemented
(§16.2 step 1) and is the only form a Host is required to accept; larger inputs
use the two-phase flow below, which no Host implements yet:

1. `attachment/create` returns an opaque attachment id and an upload target.
2. The client uploads bytes over an authenticated HTTPS request.
3. `attachment/complete` supplies size and SHA-256.
4. The Host verifies the bytes, stores them in session-scoped scratch or
   attachment storage, and marks the attachment `ready`.
5. `turn/start` references only the ready attachment id.

Upload targets MUST be single-purpose, size-bounded, short-lived, and scoped to
one principal and session. A remote path, `file://` URL, or arbitrary URL MUST
not be accepted as a substitute for an upload, and the same holds for the inline
form: there is no way to say "the file is already on my computer".

Inline entries carry `name`, an optional declared `mimeType`, and base64 `data`
without a data-URL prefix. The Host validates the bytes, never the label: the
type is read from the content, and a declared type that disagrees with it is
`INVALID_ARGUMENT`. PNG, JPEG, WebP, GIF, and UTF-8 text are accepted; SVG is
refused on both paths, because it is markup that can carry script. Anything else,
including bytes with a NUL or an invalid UTF-8 sequence, is `INVALID_ARGUMENT`.
The bytes are then stored where the agent runtime already reads attachments from
and the runtime receives their path — a prompt never carries a path the client
chose.

Behind a Gateway the Host has no inbound port, so the upload target is served
by the Gateway and the bytes cross the Host link in bounded chunks (§11.4).
The Gateway holds them only until `attachment/complete` succeeds or the upload
expires, verifies nothing beyond size, and never inspects or persists them
further; the Host performs the hash and MIME verification.

## 11. Transport mappings

### 11.1 WebSocket JSON-RPC (`RACP-WS`, normative v1 binding)

- Endpoint: `wss://<authority>/v1/racp/ws`, or
  `wss://<gateway>/v1/hosts/{hostId}/racp/ws` behind a Gateway
- Subprotocol: `pi-racp.v1.jsonrpc`
- One UTF-8 JSON-RPC message per text frame
- Full-duplex server requests enabled
- Ping/pong heartbeat target: 30 seconds

Authentication happens on the HTTP upgrade request and never in the URL query
string. Browsers cannot set request headers on the `WebSocket` API, so the
binding defines two authentication profiles:

- **Non-browser clients** send `Authorization: Bearer <access token>` on the
  upgrade request.
- **Browser clients** rely on a cookie-backed Gateway session
  (`HttpOnly`, `Secure`, `SameSite=Lax` or stricter) plus the per-tenant
  Origin allowlist checked on the upgrade, and a CSRF token on every mutation
  sent over the socket after `connection/initialize`.

A token in the URL is rejected in both profiles.

First deployment (rollout R2): a `agent-host-cli` binds loopback on the remote
machine and the desktop reaches it through an SSH port forward on the header
profile with a device token obtained by the SSH bootstrap pairing. Plain
`ws://` is accepted on that port only when both the bind address and the peer
address are loopback; the SSH channel provides confidentiality
(`05-security/02-remote-control-security.md` §5.1). The cookie profile ships
with the Gateway and browser milestones (R4–R6, D665).

### 11.2 HTTP/JSON + SSE (`RACP-HTTP`, browser profile)

| Operation family | HTTP mapping |
|---|---|
| Capabilities | `GET /v1/capabilities` |
| List hosts (Gateway only) | `GET /v1/hosts` |
| List projects | `GET /v1/projects` |
| Register project | `POST /v1/projects` (body `{ path }`) |
| Browse folders | `GET /v1/projects:browse?path=...` (`path` optional; omitted means the browse root) |
| List sessions | `GET /v1/sessions` |
| Create session | `POST /v1/sessions` |
| Get/attach session | `GET /v1/sessions/{sessionId}` / `POST ...:attach` |
| Session history | `GET /v1/sessions/{sessionId}/history` |
| Start turn | `POST /v1/sessions/{sessionId}/turns` |
| Get turn | `GET /v1/turns/{turnId}` |
| Stop / interrupt / cancel turn | `POST /v1/turns/{turnId}:stop` / `:interrupt` / `:cancel` |
| Prioritize turn | `POST /v1/turns/{turnId}:prioritize` |
| Session event stream | `GET /v1/sessions/{sessionId}/events` |
| Host event stream | `GET /v1/events` |
| Pair a device (Gateway only) | `POST /v1/hosts/{hostId}/pair` |
| Resolve approval | `POST /v1/approvals/{approvalId}:respond` |
| Resolve input | `POST /v1/inputs/{inputId}:respond` |

The event endpoints MUST support `Last-Event-ID` with the `"<epoch>:<sequence>"`
form. Commands return JSON and never require the caller to keep a request open
for turn execution.

The same two authentication profiles apply. A browser `EventSource` cannot set
headers, so it uses the cookie session and Origin allowlist; a browser client
MAY instead consume the stream through `fetch` with header authentication, in
which case it sends `Last-Event-ID` as a request header itself and implements
its own reconnect.

`RACP-HTTP` is required before any browser client ships. It is delivered by
the Gateway and browser milestones (R4–R6, D665): the mapping binds when R4
ships and the binding joins the conformance fixture with `RACP-WS` before any
browser client uses it.

#### Gateway mapping

A self-hosted Gateway (`ADR 0331`) fronts one or more Hosts and serves the same
table under a Host prefix, so a client sets its base URL to
`https://<gateway>/hosts/{hostId}` and uses the mapping above unchanged.

- Gateway-level endpoints outside that prefix: `GET /healthz` (unauthenticated,
  `{ ok, version }`), `GET /v1/hosts` (the Hosts the caller's device may reach,
  each with `online`), `POST /v1/hosts/{hostId}/pair`, and — in account mode
  only — `POST /v1/account/login` and `GET /v1/account/hosts` (§11.5). The two
  account routes are the only place an AccessKey-derived credential is accepted:
  `GET /v1/hosts` and every `/hosts/{hostId}/...` route take a device token
  exclusively, and a Gateway without account mode answers both with `NOT_FOUND`
  like any other unknown path.
- A command body is `{ jsonrpc, id, method, params, idempotencyKey? }`. The
  Gateway answers `INVALID_ARGUMENT` when `method` does not match the route, and
  places `idempotencyKey` where the operation schema defines it: only
  `turn/start` has one (`params.idempotencyKey`), so a key on any other
  operation is `INVALID_ARGUMENT`. A successful response is `{ result }`; a
  failure is `{ error: { code, message, data: RemoteError } }` with the HTTP
  status of the §13 mapping. A path parameter is authoritative: a body that
  repeats it with another value is `INVALID_ARGUMENT`.
- A GET route carries its non-path parameters in the query string, and the route
  table declares exactly which keys and types it accepts
  (`RACP_HTTP_QUERY_PARAMS`):

  | Route | Query parameters |
  | --- | --- |
  | `GET /v1/sessions/{sessionId}/history` | `beforeItemId` (`string`), `limit` (`integer`) |
  | every other route | none |

  An undeclared or repeated key is `INVALID_ARGUMENT`, as is an `integer` that
  is not a signed decimal literal or a `boolean` other than `true`/`false`. The
  Gateway merges the parsed values into the forwarded parameters and the path
  parameter still wins. Neither a credential nor an event cursor is ever
  accepted in a URL: the cursor travels in `Last-Event-ID`.
- Every relayed logical connection performs its own `connection/initialize` with
  `bindings: ["RACP-WS"]` (the Host link framing, §11.4) and the client
  capabilities `eventReplay`, `hostEvents`, `history`, and `turnQueue` set to
  `true`; `approvals`, `inputRequests`, `toolRelay`, `terminal`, and
  `attachments` are `false`. A server-initiated request the Host sends anyway is
  answered with `CAPABILITY_UNAVAILABLE`; the Gateway never decides for the
  user.
- The browser profile uses two cookies scoped to `Path=/hosts/{hostId}` with
  `Max-Age=34560000` (400 days, the Chromium cap), so a pairing survives a
  browser restart: the `HttpOnly` device token (`racp_device`) and a
  page-readable `racp_csrf` whose value is
  `HMAC-SHA256(gateway-secret, deviceId)`. Every mutation repeats that value in
  `x-csrf-token`. A cookie-authenticated request must carry an allowlisted
  `Origin`, except a same-origin `GET`/`HEAD` that the browser sends without one
  (`Sec-Fetch-Site: same-origin`), which is the shape of every H5 read and event
  stream; a request whose `Origin` is present but not allowlisted is always
  refused, a mutation is never exempt, and CORS never answers `*`. Revocation
  stays server-side: a revoked token answers `401`.
- Every command and every event stream sends `x-minih-racp-client:
  <name>/<version>` and `content-type: application/json`; the cookie profile
  adds `x-csrf-token`, the header profile adds `authorization`, and a resumed
  stream adds `last-event-id`. A native webview is a cross-origin caller for all
  of them, so the preflight answer must allow exactly this set — one list shared
  by the client and the Gateway (`RACP_HTTP_CORS_ALLOW_HEADERS`), because a
  header the client adds without the Gateway allowing it fails only on a phone.
  CORS-safelisted headers (`accept` and friends) are never part of it. Every
  response to an allowlisted origin also carries
  `access-control-expose-headers: x-trace-id`, so a cross-origin client can read
  the trace id off a failure instead of seeing `null`.
- Commands share one logical connection per `(device, host)`; each event stream
  takes its own, and a device holds at most four streams, so a Gateway cannot
  exhaust the Host's `maxConnectedClients`.

### 11.3 gRPC (`RACP-GRPC`, reserved)

gRPC is not part of the v1 conformance surface. It is reserved for a typed
service binding if a native service client or a Gateway implementation needs
it after the semantic model has stabilized. If adopted:

- the `.proto` file is generated from the typebox source of §5, never written
  by hand, and preserves field meaning, enums, and state transitions;
- `SubscribeEvents` is a server stream, not a long-running `StartTurn` call;
- authentication, principal, idempotency, cursor, and error semantics map to
  metadata and status without changing their meaning; and
- the binding joins the same conformance fixture before it ships.

Reserving gRPC rather than requiring it keeps v1 at one interactive binding
and one browser profile; the Host link (§11.4) uses `RACP-WS` framing.

### 11.4 Host link relay profile

The Host link ships with the Gateway milestone R4 (D665, ADR 0331). The
SSH-tunnel topology does not use it.

The Host link is the outbound connection from an Agent Host to a Gateway. It
is not a third client binding: it multiplexes logical client connections onto
one authenticated WebSocket so that every RACP rule above applies per logical
connection.

```ts
type HostLinkFrame =
  | { link: "racp-hostlink.v1"; type: "client.open"; clientConnectionId: string; routeContext: string; credential: string }
  | { link: "racp-hostlink.v1"; type: "client.message"; clientConnectionId: string; message: unknown }
  | { link: "racp-hostlink.v1"; type: "client.close"; clientConnectionId: string; reason: string }
  | { link: "racp-hostlink.v1"; type: "host.message"; clientConnectionId: string; message: unknown }
  | { link: "racp-hostlink.v1"; type: "host.close"; clientConnectionId: string; code: string }
  | { link: "racp-hostlink.v1"; type: "attachment.chunk"; uploadId: string; offset: number; last: boolean }
  | { link: "racp-hostlink.v1"; type: "link.ping" | "link.pong" }
  // Account mode (§11.5, D666): the device directory's own frames.
  | { link: "racp-hostlink.v1"; type: "host.capabilities"; capabilities: string[] }
  | { link: "racp-hostlink.v1"; type: "device.request"; request: DeviceRequest }
  | { link: "racp-hostlink.v1"; type: "device.grant"; grant: DeviceGrant; signature: string;
      signerCertificate: string; deviceToken?: string }
  | { link: "racp-hostlink.v1"; type: "device.revoke"; revoke: DeviceRevoke; signature: string;
      signerCertificate: string }
```

Rules:

1. `client.open` carries the `HostRouteContext` and the client's raw
   bearer `credential` (a device token or a pairing token) for that client.
   The Host authorizes every operation on the logical connection by
   re-authenticating that credential with its own `DeviceTokenAuthenticator`
   under the connection origin `"gateway"`; the Gateway's cached token hash
   is only a pre-routing fast reject and a rate-limit key. The link's own
   mTLS identity authenticates the Gateway, not any user. In the
   self-hosted, user-local Gateway scenario the route context is not
   separately signed: its integrity is guaranteed by the authenticated Host
   link, so the Host does not verify a second signature on `routeContext`;
   it still rejects a context whose
   `hostId` is not its own, that has expired, or whose `clientConnectionId`
   is already in use on the same link. The `credential` appears only in
   `client.open` frames and never in logs, audit records, or error payloads.
2. Each logical connection has its own `connection/initialize`, subscriptions,
   server-request id space, and send queue. A server-initiated request is
   addressed to a `clientConnectionId`; the Gateway relays it on the matching
   client connection and relays the response back on the same logical
   connection, which satisfies §4.3.
3. The Gateway MUST NOT renumber, reorder, coalesce, or re-key anything inside
   `message`. It MAY drop ephemeral events for a slow client; it MUST close
   that logical connection with `CLIENT_TOO_SLOW` rather than drop a durable
   event.
4. `attachment.chunk` frames are followed by one binary WebSocket frame of at
   most 256 KiB and are the only binary payload permitted on the link.
5. Loss of the link closes every logical connection with a resumable cursor.
   The Host reconnects with bounded exponential backoff; local turns continue
   throughout.
6. `host.capabilities`, `device.request`, `device.grant`, and `device.revoke`
   exist for account mode only, and §11.5 defines what they carry. The Host
   sends `host.capabilities` on every link as soon as it is up, and the Gateway
   MUST NOT send a `device.request` or a relayed `device.grant` to a Host that
   has not announced the matching capability: a Host that predates these frames
   ignores an unknown `type` silently, so a frame sent to it would leave the
   client waiting forever. Unknown capability strings are ignored by the reader,
   so a newer Host may advertise more than an older Gateway understands. A
   malformed frame and an unknown `type` are dropped without closing the link,
   in both directions.

7. **Desktop-class devices and the sibling-desktop route (planned, R8; ADR
   `remote-control-router-account-binding` amendment 3).** `device.request` and
   the account login/device bodies gain `client: "desktop"` beside `web` /
   `ios` / `android`. A desktop request also carries `hostProof`: the
   applicant's `hostId` and a signature over the request id and a nonce, made
   with the private key of the Host certificate this Gateway issued to that
   computer. The Gateway verifies the chain to its own CA, the
   `OU=account:<accountId>` binding against the account of the presented
   AccessKey, and the signature; only then is the request a desktop request. A
   verified desktop request whose target computer advertises
   `device.desktop-auto` and has automatic admission on is granted without a
   human answer, and the device holds `owner`. Without the capability the
   Gateway MUST NOT send the new frames — an old Host drops an unknown `type`
   silently (rule 6) — and the requesting desktop reports that computer as
   needing an update. A `desktop` client reaches the Host over
   `RACP-WS` at `GET /v1/hosts/{hostId}/ws`, authenticated by its device token
   exactly like the device-token routes of §11.2, and the Gateway relays
   `RACP-WS` frames byte for byte onto the same logical connection a
   `RACP-HTTP` command uses. Phones keep `RACP-HTTP` + SSE unchanged.

Enrollment and pairing run against the same listener:

- **Enrollment (Host to Gateway).** An administrator prints a one-time
  enrollment code with `remote-gateway enroll-code --label <name>`, valid 15
  minutes. The Host generates its key pair locally and sends the CSR and the
  code with `POST /v1/enroll` on the Host link port, which authenticates by
  server TLS only and requires no client certificate. The link itself is
  `wss://<gateway>:<port>/v1/hostlink`. The
  Host pins the Gateway identity with the `--gateway-ca` certificate and
  refuses a fingerprint mismatch. The Gateway issues a one-year client
  certificate with the `hostId` as CN, which the Host then uses for the
  mutual-TLS link.
- **Pairing (client to Host through the Gateway).** The Host displays a
  single-use pairing code with a 10-minute validity locally, never through
  the Gateway. Because the pairing call is Host-scoped and the cookie path never
  exposes `GET /v1/hosts`, the Host prints the same code as a ticket,
  `mpt1:<hostId>:<pairingToken>` — one copy-pasteable line that names the Host
  and carries the token (the desktop settings page and
  `agent-host-cli remote-pair` both emit it; the ticket is a secret and never
  travels in a URL). The client calls `POST /v1/hosts/{hostId}/pair` with
  `Authorization: Bearer <pairingToken>` and
  `{ deviceLabel, client: "web" | "ios" | "android" }`. The Gateway opens a
  logical connection whose `credential` is the pairing token and performs
  `connection/initialize` followed by `connection/pair` on it. The Host
  issues a device token with the gateway device origin (security §3.7), and
  the Gateway records only
  `{ deviceId, hostId, sha256(token), label, createdAt }`, delivering the
  token as an `HttpOnly; Secure; SameSite=Strict; Path=/hosts/{hostId};
  Max-Age=34560000` cookie plus a CSRF token for browsers, or as
  `{ deviceId, token }` in the response body for native clients to store in the
  iOS Keychain or the Android Keystore.
  The response also carries `hostLabel`, the Host's own name as its owner
  registered it. It is optional and additive, and it is the only occasion a
  device learns that name: `GET /v1/hosts` is unreachable from the browser
  profile (§11.2) and a device has no per-Host credential yet. A client that
  receives none shows the host id; it must not substitute the device label,
  which names the phone that paired, not the computer.

### 11.5 Account mode (D666; the account directory is implemented)

Account mode binds a Minih-Router AccessKey to Hosts and devices (ADR
`remote-control-router-account-binding`). It is additive: every clause of
§11.2 and §11.4 keeps its meaning, and the self-hosted enrollment and per-Host
pairing paths stay available for users without a Router key.

The Gateway account directory — key verification, enrollment by key, account
login, the account host list, and the device request / confirm / grant relay —
is implemented (rollout R7 packages C and D). A Host that can ask its own user
advertises `device.confirm` on the link, one approval on any Host of the account
mints one device token for all of them, and every clause below is implemented as
written.

- **Key verification.** The Gateway validates a presented AccessKey by calling
  the Router's `GET /api/auth/session` over loopback with
  `Authorization: Bearer <AccessKey>`, forwarding the original caller address in
  the header named by the Router's `CLIENT_IP_HEADER`. The Gateway's loopback
  peer must be inside the Router's `TRUSTED_PROXIES`; otherwise the Router
  ignores the header and evaluates `allowed_peer_cidrs` against `127.0.0.1`. The
  account is the answered `access_key_id`. Only a clean `code: 0` answer whose
  `data` carries `authenticated: true`, `principal_type: "access_key"`, and a
  positive `access_key_id` verifies a key: an admin principal, an
  unauthenticated answer, and the Router's own error envelope are refusals, and
  a Router that cannot be reached, times out, answers a status of `500` or more,
  or returns an unreadable body is a retriable error and never a pass. A
  locked-out caller is its own answer: the Router's `429` with `Retry-After` and
  `{ code: "AUTH_LOCKED", data: { retry_after_seconds } }` — what it sends after
  too many failed authentications from one address — is reported as
  `RATE_LIMITED`, retriable, with the Router's own delay in the message and in a
  `Retry-After` header, and never as an invalid key. The
  Gateway keeps no digest of the AccessKey: the only durable state a login
  leaves is the hash of the session credential it mints, and a successful
  verification is never cached — every login calls the Router again.
- **Client address.** The Gateway takes the caller address from its configured
  header only when the TCP peer is inside its configured trusted-proxy set, and
  otherwise from the peer itself. The header name and the trusted proxy are one
  setting: a half-configured pair refuses to start, because a header name with
  no trusted peer would never be read and a trusted peer with no header name
  resolves nothing. `X-Forwarded-For` is read as a chain — the caller is the
  rightmost entry that is not inside the trusted-proxy set, or the leftmost
  entry when every entry is trusted — and any other header carries exactly one
  address; an entry that is not an IP address falls back to the peer, because a
  malformed chain proves nothing. This is the rule the Router itself applies
  (`internal/platform/utils/client_ip.go`), so the address the Gateway forwards
  means to the Router what it means at the Gateway. The resolved address keys
  the per-IP rate limits and the audit record, and it is the value the Gateway
  forwards to the Router. Without both settings the resolved address is the TCP
  peer, exactly as before.
- **Key lifecycle.** Rotation keeps the account because the Router keeps the id.
  A disabled or deleted key fails `GET /api/auth/session` (the Router indexes
  only active keys), so new logins and new enrollments with it fail. Key state
  revokes nothing by itself: already approved device tokens and already issued
  Host certificates stay valid until revoked through the existing revoke paths.
  A Host's link can still end for network reasons: when the mesh issues per-key
  credentials, a Host whose key is disabled or deleted cannot refresh its
  bootstrap and keeps the link only until that credential expires.
- **Host enrollment by key.** The Router's `GET <root>/api/easytier/bootstrap`
  answer gains the optional additive
  `remoteGateway { hostlinkUrl, publicOrigin, caPem }` object (provider-config
  §3). `POST /v1/enroll` on the Host link port then accepts exactly one
  credential: the self-hosted `enrollmentCode`, or
  `Authorization: Bearer <AccessKey>` with the field absent. `hostId` and `csr`
  are required either way, no other field is accepted, and the self-hosted body
  is unchanged, so `agent-host-cli` and the desktop keep working. The Gateway
  verifies the key, records the Host under that account, and issues the client
  certificate that binds `hostId` to the account: the subject DN is
  `CN=<hostId>` followed by `OU=account:<accountId>`, and a Host reads that
  attribute back from a sibling's certificate to check the signer belongs to its
  own account. A certificate without the attribute is a self-hosted one and
  belongs to no account. The Gateway refuses a `hostId` already enrolled under
  another account, an account-bound `hostId` presented with an enrollment code
  instead of that account's key, a self-hosted `hostId` presented with an
  AccessKey by a request that does not certify the key its current certificate
  certifies, a key that does not verify, and an unreachable Router. Its
  enrollment error codes are `ACCESS_KEY_INVALID` (401),
  `ACCESS_KEY_UNAVAILABLE` (503, retriable), `HOST_ACCOUNT_MISMATCH` (403), and
  `RATE_LIMITED` (429, retriable). The client address on this endpoint is the
  Host link's TCP peer: that port is reached directly over the overlay and is
  never behind the client proxy. An absent `remoteGateway` object, or a `404`
  from the bootstrap, means account mode is unavailable and the Host uses the
  enrollment code of §11.4. `agent-host-cli enroll` reads the key from
  `--access-key-file <path>` (a regular file, mode 0600, owned by the caller),
  `--access-key-stdin`, or `MINIH_ROUTER_ACCESS_KEY`, and refuses a key typed on
  the command line: argv is readable by every user on the machine and lands in
  the shell history. The key is presented once on `POST /v1/enroll` and is not
  written to disk; `gateway-link.json` holds only the issued certificate and the
  Host's own private key.
- **Account login.** `POST /v1/account/login` takes
  `Authorization: Bearer <AccessKey>` and a body
  `{ client: "web" | "ios" | "android", label? }`, follows the pairing route's
  browser rules, and answers `{ result: { accountId, keyName?, expiresAt,
  token?, csrfToken? } }` under the §11.2 command envelope. The account is the
  Router `access_key_id` as a decimal string. The session credential is a
  `rat1.`-prefixed bearer value with a twelve-hour bounded lifetime; the Gateway
  stores only its SHA-256 hash, and revocation stays server-side. A native
  client receives it in the body; a browser receives it as an
  `HttpOnly; Secure; SameSite=Strict` cookie scoped to `Path=/` with a `Max-Age`
  equal to the lifetime, plus a page-readable CSRF cookie whose value is the
  same HMAC the pairing profile uses. A key that does not verify answers
  `401 UNAUTHORIZED`, an unreachable Router answers
  `503 AGENT_UNAVAILABLE` with `retriable: true`, and a caller the Router has
  locked out answers `429 RATE_LIMITED` with `retriable: true` and a
  `Retry-After` header carrying the Router's own delay.
- **Account host list.** `GET /v1/account/hosts` takes the account session
  credential in either profile and answers only the Hosts whose `accountId` is
  the session's account, each with its online state. The route is account-scoped
  and names no Host, so a foreign Host cannot be addressed through it at all. It
  authorizes no relayed Host operation: `/hosts/{hostId}/...` still requires the
  device token of §11.4, and an account session presented there is refused with
  `401 UNAUTHORIZED` — the same answer a Host that does not exist produces, so
  the refusal never reveals whether a foreign Host exists.
- **Device request, confirm, grant.** A logged-in client requests a device with
  `POST /v1/account/devices`. The Gateway records the request under the
  session's account, sends `device.request` to every online Host of that account
  that advertises `device.confirm`, and answers the caller with the request id,
  its deadline, and the account's whole Host roster. The first Host whose user
  approves mints a device token with the ordinary §11.4 machinery, keeps only
  its SHA-256, signs a `DeviceGrant` with the private key of its own Host
  certificate, and answers `device.grant`. The Gateway verifies that signature
  against its own CA before it relays anything — it never signs a grant itself
  (ADR `remote-control-router-account-binding` decision 5 is rejected) — then
  relays the grant to the account's other Hosts. Each accepting Host verifies
  the signer's chain to the pinned Gateway CA, the `OU=account:<accountId>`
  binding in the signer's certificate, the signature over the canonical grant
  payload, the signer's `hostId`, the `deliverUntil` deadline, the exact
  `viewer` / `controller` / `approver` role set, and that the device is not
  revoked locally; every other outcome is a refusal that leaves the Host
  unchanged (security gate 32). The client ends with ONE device token usable on
  every Host of the account, and drops the AccessKey. In-flight requests are
  bounded per account (four) and in total; a request beyond either bound is
  `RATE_LIMITED` rather than an eviction, so one account can never push another
  account's request — or a granted token it has not taken yet — out of the
  table.
- **The device token.** The approving Host mints it, keeps only its hash, and
  signs the grant; the siblings adopt the device by that hash, so the raw token
  is never in the grant they receive. It travels exactly once from the approving
  Host to the Gateway, in the `deviceToken` field of a `device.grant` frame that
  is valid only on that leg: the Gateway MUST strip it before relaying the grant
  to any other Host, MUST NOT log, audit, or persist it, and hands it to the
  client that asked. The Gateway records the device as it does for §11.4 — the
  hash, scoped to the account instead of to one Host — so its pre-routing fast
  reject accepts that token on every Host of the account and on no other. The
  Gateway holds the token in memory only, hands it to the client that asked on
  the first read that reports `granted`, and keeps it available for a further
  thirty seconds so a retried HTTP request still succeeds; after that it drops
  the token and reports `tokenDelivered: false`, and a client that lost it
  starts a new request rather than waiting for one that no longer exists. A
  device minted this way is a gateway-origin principal of security §3.7:
  `viewer` / `controller` / `approver`, `pairedDevice: false`, always under the
  remote permission ceiling, never offered `allow-session`. A token handed to
  the client before its siblings adopted the grant is refused by them until they
  do.
- **Client routes.** `POST /v1/account/devices` takes the account session
  credential, never a device token, with a body `{ deviceLabel, client }`, and
  answers `{ result: { requestId, expiresAt, hosts } }` under the §11.2 command
  envelope. `GET /v1/account/devices/{requestId}` answers
  `{ result: { requestId, status, expiresAt, hosts, deviceId?, token?,
  csrfTokens?, roles?, signerHostId?, tokenDelivered? } }`, where `status` is
  `pending`, `granted`, or `expired`, `tokenDelivered` says whether this
  response carried the token, and `token` is present exactly while the request
  is `granted` and its pickup window is open. `csrfTokens` is what a browser
  session receives instead of `token`: one CSRF value per Host of the account,
  as described below. A request belongs to the account session that created it:
  an unknown id, a request of another account, and a request of another session
  of the same account all answer the same `NOT_FOUND`, because the request id
  travels to every Host and through the Gateway's logs and is therefore not a
  credential (gate 29). Every account response carries
  `Cache-Control: no-store`, because each one carries a session credential, a
  device token, or both. A malformed body is
  `INVALID_ARGUMENT`, a caller over its budget is `RATE_LIMITED`, and a missing
  or foreign session credential is the uniform `UNAUTHORIZED` of §13. A denial
  has no status of its own: a Host that declines sends nothing, so the request
  stays `pending` until `expiresAt` and the client's own deadline ends the wait.
  Each entry of `hosts` is `{ hostId, label, online, canConfirm,
  willAcceptGrant }`; `canConfirm` is true only for an online Host that
  advertised `device.confirm`, and `willAcceptGrant` only for one that
  advertised `device.accept-sibling-grant`, so the client learns immediately
  which Hosts cannot answer (gate 33).
- **Browser device handover.** A browser session (`client: "web"`) is handed the
  device token the way it was handed its own session: as cookies. The first
  status read that reports `granted` sets one `HttpOnly; Secure; SameSite=Strict`
  device cookie per Host of the account, scoped to `Path=/hosts/{hostId}`, and
  answers `csrfTokens` in the body — a map from `hostId` to the CSRF value that
  Host's device cookie pairs with — so the client can record every Host of the
  account without ever holding the token. `token` is absent from that body and
  `tokenDelivered` is still `true`, because the token was handed over. A native
  session (`client: "ios"` / `"android"`) receives the token in the body and no
  cookie at all. Which of the two happens is decided by the session created at
  login, never by the caller of the status route, so a status read can never
  write a cookie into a native webview's jar. Each per-Host cookie is exactly the
  cookie `POST /v1/hosts/{hostId}/pair` sets, so every host-scoped screen and
  route of §11.4 works unchanged for a device granted through account mode.
- **Account logout.** `POST /v1/account/logout` takes the account session
  credential in either profile and ends that session: the Gateway revokes its own
  session record and clears the account cookie and its page-readable CSRF
  companion with `Max-Age=0`. It authorizes no Host operation, answers
  `{ result: { accountId, revoked } }` under the §11.2 command envelope, and
  leaves every device token untouched — a device is a separate credential of
  §11.4. It follows the browser rules of §11.2: an allowlisted `Origin`, and for
  the cookie profile the CSRF header. The route exists because a browser cannot
  clear an `HttpOnly` cookie itself: without it a client that has just adopted
  the device would leave a usable account session behind for up to twelve hours.
  A client that does not call it is still correct — the session expires on its
  own — but it holds a credential it no longer needs.
- **Client flow (rollout R7 package F).** The client half of "confirm once, use
  everywhere" is a discovery step, one login, one request, one wait, one
  adoption, and a dropped session:
  - **Discovery.** Account mode is discovered from a credential-free
    `GET /v1/account/hosts`: `401` means this Gateway serves account mode (the
    route exists and wants a session), `404` means it does not, and `403` means
    this origin is refused — so nothing account-scoped would work from here
    either. Anything else, including a transport failure, leaves the client
    undecided. "Credential-free" binds the browser too: the probe sends no
    `Authorization` header **and no session cookie** (`credentials: "omit"`),
    because a surviving session would authenticate it, and the `200` that comes
    back is none of the answers above — an authenticated probe therefore hides
    the entry instead of offering it. Only a `401` offers the AccessKey entry;
    every other answer keeps the §11.4 pairing flow and hides it, so a Gateway
    without account mode behaves exactly as before (rollout exit criterion 7).
  - **Login.** The AccessKey is presented once, in the `Authorization` header of
    the login call, and is dropped as soon as that call returns: it is never
    written to `localStorage`, `sessionStorage`, IndexedDB, a cookie, a native
    store, a URL, or a log, and it is not part of the session the call produces
    (gate 30). The client's own text input is cleared on every outcome.
  - **Roster.** The Hosts of the answered `POST /v1/account/devices` are shown
    immediately, including the ones that cannot confirm, so a user learns up
    front which computer can answer. When no Host of the account can confirm,
    the client says so and offers the per-Host pairing ticket of §11.4 instead of
    waiting for an answer that cannot come (gate 33).
  - **Waiting.** The status route is read every two seconds. A failed read backs
    off exponentially to a fifteen-second ceiling; a `RATE_LIMITED` answer waits
    exactly as long as its `Retry-After` asked, never less than the normal
    interval; a run of eight consecutive failures ends the wait as a failure
    rather than polling forever. The client's own `expiresAt` deadline also ends
    it, as `expired`, without another read. A `granted` answer that carries
    neither a token nor `csrfTokens` — the pickup window closed before it was
    read — is reported as its own outcome, and both it and `expired` let the user
    ask again under the same session. `NOT_FOUND` means the Gateway no longer
    knows the request (it expired, or the session changed) and returns the client
    to sign-in. Because a denial has no frame, the client also offers an explicit
    cancel, which stops the wait and keeps the account session.
  - **Adoption.** The client records the device on every Host the Gateway named —
    one cookie per Host for a browser, the platform secure store for a native
    shell — and only then drops the account session, revoking it through the
    logout route above when the Gateway serves one. A storage failure is reported
    as its own outcome and leaves the account session usable, because the device
    exists on the Gateway but was not kept here.
  - **Switching.** A device token of §11.4 is accepted on every Host of the
    account, so `GET /v1/hosts` on that token lists the account's Hosts and the
    client switches between them without pairing again.
- **A Host that has not adopted the device.** A Host that has not accepted this
  device yet — it was offline when the grant was issued, or it is in strict mode
  and its own user has not confirmed — refuses the token, and the Gateway reports
  that refusal to the client as `401 HOST_UNAUTHORIZED`, which is deliberately
  not the `401 UNAUTHORIZED` of a credential that no longer exists. Only an
  account-mode device can be reported this way: a device paired through §11.4
  that a Host refuses has been revoked on that Host, its credential really is
  gone, and the answer stays `UNAUTHORIZED` (security gate 26). A client MUST
  keep the two apart: `HOST_UNAUTHORIZED` means the device is intact and this
  computer has not synced it, so the next step is a retry or a local
  confirmation on that computer; `UNAUTHORIZED` means the credential is gone —
  revoked, or never valid — and the only next step is a new pairing or a new
  device request. A client that reports the first as the second discards a
  working device.
  A retry is only a next step for a Host that may still catch up. A Host in
  strict mode refuses every sibling grant for good (ADR decision 9), so the
  client must not offer a refresh that can never succeed: when the roster
  answered `online: true, willAcceptGrant: false` for that Host, the client
  tells the user to ask for a device again and approve it on that computer, and
  offers that request as the action. The new grant mints a new device, which the
  strict Host signs itself and the account's other Hosts adopt as usual, so the
  new token works everywhere; the client replaces the previous device on every
  Host it knows (browser cookies, native secure store, registry entries) instead
  of keeping both. A Host that was offline at grant time is not one of these: it
  may adopt the deferred grant when it returns, so a retry is honest there.
- **The Hosts a browser can reach.** A browser receives the device as one
  `HttpOnly` cookie per Host, and the Gateway sets those for the Hosts of the
  account that exist when the grant is issued. A Host enrolled into the account
  afterwards therefore has no cookie in that browser and no registry entry, so
  it is not reachable from that browser until the user asks for a device again
  (or pairs that Host with a ticket). A native client is not affected: it holds
  one account-scoped token and sends it to whichever Host id it is addressing, so
  a Host enrolled later works without a new request once that Host has adopted
  the grant.
- **Capability advertisement.** A Host sends `host.capabilities` on every link,
  as soon as the link is up, with the capability strings it supports:
  `device.confirm` when it has a confirmer wired up, and
  `device.accept-sibling-grant` when it adopts a sibling's grant. A Host with no
  confirmer advertises nothing, and a Host in strict mode advertises
  `device.confirm` alone (ADR decision 9). The Gateway MUST send a
  `device.request` only to a Host that announced `device.confirm`, and a relayed
  `device.grant` only to one that announced `device.accept-sibling-grant`, and
  MUST report every other Host of the account to the client as unable to confirm
  instead of leaving it waiting (gate 33); the client then offers that Host the
  per-Host ticket of §11.4. What a Host accepts is known only once it has
  announced, so the Gateway offers deferred grants and revocations when the
  announcement arrives on a new link, not when the link comes up, and a Host
  that reconnects in strict mode is never offered a grant it would refuse.
- **Deferred grants.** A Host that is offline when the grant is issued receives
  it when its link comes up: the Gateway keeps the signed grant for that
  account, without the token, and offers it again on every reconnect. The
  `deliverUntil` the approving Host signed is relayed byte for byte, because it
  is part of the signed payload and rewriting it — even to shorten it — would
  make every sibling refuse the grant; the Gateway bounds its own retention with
  a separate `relayUntil` that nothing signs, which is the signed deadline or 24
  hours, whichever is sooner. Re-delivery is idempotent — a Host that already
  adopted the device answers `already-adopted` and changes nothing — and until a
  Host has adopted the grant it does not accept that device token.
- **Revocation.** Any Host of the account can revoke a device, and the
  revocation reaches the others. The Host revokes the device locally first, so
  its own user's decision never waits for the network, and signs a
  `DeviceRevoke` with its own Host certificate. A frame that cannot go out — the
  link is down, or it is still reconnecting — is queued under the Host's data
  directory and re-offered on the next link until its delivery window closes,
  because the protocol has no acknowledgement and a revocation must not be lost
  with a socket. Re-delivery is idempotent. The Gateway verifies the signature
  and relays the frame to every other Host of the account that announced a
  capability frame at all — that is, to every Host that has a device directory —
  and not only to those that accept sibling grants: a Host may have adopted the
  device while it was not strict, or while it had a confirmer, and then
  restarted in strict mode or without one, and filtering by
  `device.accept-sibling-grant` would leave exactly that Host accepting a
  revoked token. A Host that never adopted the device records it as revoked
  anyway, so a grant still in flight cannot resurrect it, and a Host that
  predates these frames never announces and is never sent one. The Gateway also revokes its own record
  for the device, so its fast reject stops accepting the token at once, and
  drops any pending grant for that device before it relays the revocation.
- **Roles and policy.** A device minted through account mode is a
  gateway-origin principal under security §3.7: `viewer` / `controller` /
  `approver`, `pairedDevice: false`, always under the remote permission ceiling,
  never offered `allow-session`. A Host in strict mode refuses sibling grants
  and confirms every device with its own user.
- **Desktop Host (package E2).** The desktop is one of these Hosts, and it
  settles the parts a headless Host leaves to the embedding application. It
  enrolls itself through the Router account when the Router advertises one
  (§11.5 "Account login" above; provider-config §3), reading the account
  AccessKey from the saved `minih-router` provider row inside the main process,
  using it for that one enrollment request, and then discarding it — it never
  enters a renderer payload, a log line, an audit record, or the credential
  file, which keeps only the Host certificate and key. The bootstrap request that
  carries this answer is made at **startup** with the saved row as its credential
  source, not only after the user touches a setting: a build that starts without
  one never learns which Gateway serves the account. Nothing is enrolled and
  nothing listens while the user's own remote-control switch is off, and an
  unavailable advertisement leaves the self-hosted registration-code flow
  untouched. Being off does not make account mode invisible, though: whether it
  could work — an advertised endpoint plus a configured account key — is read
  without enrolling, dialing, or opening anything, and reported in the status so
  the page can offer the switch at all; every status read asks again (concurrent
  reads share one call, and a settled answer is never reused), because both the
  overlay and the account key can appear after the page was first opened. In
  No-TUN mode the request goes to the loopback forward the tunnel installs — the
  Router's overlay address is not routable there — and once the tunnel is up a
  start without an answer asks once more through that forward and restarts the
  tunnel a single time so the answered identity applies. TUN mode asks the
  configured Router address, which its routing makes reachable. An unavailable
  account mode always names a reason: the last bootstrap failure when there is
  one, otherwise that the configuration has not been fetched yet.
  Turning that switch on is what enrolls
  the desktop: a desktop that waited for an enrollment before offering the switch
  while the enrollment waited for the switch had no way in. Its confirmer is the
  desktop's own window: `device.request` is
  shown as a modal that names the device and the client, focus starts on Deny,
  Escape denies, and the dialog closes when the request's `expiresAt` passes.
  There is no answer that is not a decision: a renderer that reports it is going
  away (a reload, a closed window) denies everything pending at once, which is
  what the desktop tells the Gateway through `remoteGateway/devicePresence` and
  `remoteGateway/deviceDecision`. A request no window can show is not answered
  early — it stays queued until its `expiresAt` and is refused then, so the
  client waits out the window instead of being told a dialog nobody saw was
  dismissed. Every mint, adoption, and revocation produces a notice the settings
  page lists (ADR decision 6), and a device revoked there goes out as the signed
  frame above, queued while the link is down. The address this link dials is
  resolved per connection from the current `EasyTierStatus.remoteGateway`
  (provider-config §3): the stored credential names the advertised endpoint, so a
  forward port the overlay re-allocated neither re-enrolls the desktop nor
  strands it.
- **Cross-account isolation.** No route, Host listing, device record, pending
  grant, or audit query may cross accounts, and every routing decision and cache
  lookup is scoped by account. The Gateway's per-IP rate limit (ADR decision 10)
  applies across accounts by nature; per-account limits stay independent
  (security §8), and no rate-limit response discloses another account's data
  (security §9). Account login and enrollment by key share one tight credential
  bucket keyed on the resolved address, so a caller cannot spend the command
  budget guessing a key. Reachability on the shared overlay grants nothing. A
  `hostId` already registered through the self-hosted flow is not an account
  asset: an AccessKey enrollment may take it over only by presenting the key its
  current certificate certifies, so learning a `hostId` never lets a key move
  another user's Host into its own account. The
  error code of a cross-account attempt is `HOST_ACCOUNT_MISMATCH` (403) on
  enrollment, where the caller already holds a valid key of another account and
  the Host must learn that its `hostId` is taken; that code names no account, so
  it reveals only that the `hostId` is enrolled. Every account-scoped route
  answers the uniform `UNAUTHORIZED` of §13 instead, so a listing or a routing
  attempt never discloses another account's Hosts.

- **Desktop-class devices (planned, R8).** A device granted to a
  `client: "desktop"` request with a verified Host-certificate proof is a
  desktop-class device: it holds `owner`, is exempt from the remote permission
  ceiling exactly like an SSH-paired desktop device, and reaches the Host over
  the WebSocket route above. Admission is automatic when the target computer
  advertises `device.desktop-auto` and its "allow same-account computers to
  join automatically" switch is on (default on); with the switch off the
  request falls back to the ordinary confirmation of this section. Every
  automatic admission produces the same "new device" notice and audit record a
  confirmed one does, and any Host of the account can revoke it. Which
  operations the device may call is decided per operation by the desktop Host:
  it opens the desktop surface explicitly and keeps refusing it to a phone. A
  phone or browser device is unchanged by this clause.

### 11.6 Redacted push (R5 PR-6; ADR 0331 decision 7)

Push is optional and redacted: it tells a user that something needs them, on a
device they registered, and it never carries what the session said. The Gateway
owns every decision — whether push exists, who is told, and what the notification
says — so a Host never chooses an audience and a client never receives content.

- **Host announcement.** A Host that will report events advertises `push.notify`
  in its `host.capabilities` frame (§11.5), which it sends on every link. A Host
  without a notifier advertises nothing, and the Gateway then expects no
  `host.notify` from it.
- **The event frame.** `host.notify` carries exactly
  `{ link, type: "host.notify", notify: { notifyId, kind, sessionId, approvalId?,
  attentionCount?, occurredAt } }`, where `notifyId` is the Host's own id for the event (bounded to
  128 characters, so one push per event survives a Host retry), and `kind` is one
  of `approval.requested`, `input.requested`, `turn.completed`, `turn.failed`.
  The object is closed: no prompt, tool name, path, transcript, or session title
  can be added, and a frame carrying one is dropped rather than delivered.
  Every id is additionally restricted to `^[A-Za-z0-9._:-]{1,128}$`, which is
  what a UUID, a `<prefix>_<uuid>`, or a decimal id needs: a length limit alone
  would leave a Host free to put a sentence in `sessionId`, and the Gateway would
  deliver it to a lock screen. A
  Gateway that predates this frame drops it and keeps the link, exactly as §11.4
  rule 6 requires; a Host that predates it sends none and nothing changes.
- **Which events.** The four kinds are the whole list: a person must decide
  about an approval, answer an input request, or learn that a turn finished or
  failed. An interrupted or canceled turn is the user's own action on a screen
  they are looking at, so it is not a notification — and neither is anything
  about a message, a tool, or a token count.
- **Registration.** `PUT /v1/push/registration` takes a **device token** — never
  an account session — with `{ platform: "ios" | "android", token, appId? }` and
  answers `{ result: { enabled, platform, hostIds } }` under the §11.2 command
  envelope. `token` is the provider token (an APNs device token or an FCM
  registration token), bounded to 4096 characters so the route cannot be used as
  storage; it is stored, never echoed, and never logged. A registration belongs
  to a device, so its audience follows the credential: one Host for a §11.4
  device, every live Host of the account for an account-mode device (§11.5).
  `hostIds` is that audience as the Gateway resolved it, and a later Host
  enrollment does not silently widen it — registering again does. One device has
  one registration: registering again replaces its token, because a device is one
  platform. The device's state is re-checked inside the write, so a registration
  request that was already in flight when the device was revoked is answered
  `UNAUTHORIZED` instead of resurrecting a registration the revocation deleted. A
  registration may also carry `onlyActionable: true`, which asks the Gateway to
  deliver only the two requests that need the user (`approval.requested`,
  `input.requested`) and to drop `turn.completed` and `turn.failed` for that
  device; the answer echoes `preferences: { onlyActionable }`, and omitting the
  field on a later registration keeps the stored value rather than resetting it. A
  Gateway that predates the field ignores it and echoes nothing, which is how a
  client knows not to offer the switch.
  `DELETE /v1/push/registration` drops the caller's own registration and answers
  `{ result: { removed } }`. Both routes follow the browser rules of §11.2
  (allowlisted `Origin`, CSRF header for the cookie profile) and carry
  `Cache-Control: no-store`.
- **Push off.** With no provider configured the Gateway stores nothing and the
  registration route answers `enabled: false` with an empty `hostIds`, so a client
  can stop asking instead of believing a registration exists. A registration for
  a platform the Gateway has no provider for is `CAPABILITY_UNAVAILABLE` (501):
  storing a token nothing can deliver to would be a silent failure.
- **The payload.** A push contains `{ kind, titleKey, bodyKey, hostId,
  sessionId, approvalId?, attentionCount?, notifyId }` and nothing else. `titleKey` and `bodyKey`
  are always `push.notify.<kind>.title` and `push.notify.<kind>.body`, resolved by
  the client from its own catalog — the Gateway never sends a sentence. APNs
  receives them as `aps.alert.title-loc-key` / `loc-key` plus the ids beside them;
  Android gets a **data-only** FCM message (no `notification` block) whose every
  value is a string, so the app is called in both states and draws the
  notification itself — which is what lets it name the session after delivery.
  The visible text is therefore the app's, in the user's language, and the ids
  survive to drive the tap. `attentionCount` is the number of decisions the Host
  says the session still holds for the user at the moment of the event; the
  Gateway copies it into `aps.badge` and into Android's `attentionCount` data
  field, and omits the badge when the Host did not count rather than inventing a
  number. APNs also receives `aps.thread-id`, and the Android app groups its own
  notifications by `sessionId`, so several events about one session stay together
  on the lock screen; both are derived from an id the payload already carries, so
  grouping adds no field to this contract. The keys are the app's to resolve:
  Android resource names cannot contain dots, so they are generated as
  `push_notify_<kind>_title`.
- **Rendering happens in the app bundle.** When the app is in the background or
  closed the *system* renders the notification, so the eight keys must exist in
  the app's own resources: `ios/App/App/en.lproj/Localizable.strings`,
  `ios/App/App/zh-Hans.lproj/Localizable.strings`,
  `android/app/src/main/res/values/strings.xml`, and
  `values-zh-rCN/strings.xml`. They are generated from the client catalogs by
  `apps/remote-web/scripts/generate-push-strings.mjs` and guarded by a test, so
  an edit to a catalog cannot leave a lock screen showing a raw key. Neither file
  carries anything but fixed copy, and neither is an operator-supplied artifact.
- **Audience (gate 29).** A device is pushed about a Host only when it may open
  that Host: its own Host for a §11.4 device, a live Host of its own account for
  an account-mode device. A revoked device has no registration at all, because
  revoking it deletes one.
- **One push per event.** A Host may repeat a frame (a reconnect, a retried
  read); the Gateway delivers one push per `notifyId`, so a retry is not a second
  buzz. De-duplication is per Host and per id, and the window is bounded.
- **Budget.** A per-Host token bucket and a per-device one bound a Host that is
  looping: the Host bucket is checked first, so a noisy Host cannot spend a
  device's budget, and one device over its own budget is dropped alone rather
  than blocking the others.
- **Cleanup.** A registration is deleted when the device is revoked — by the
  Gateway's own revoke and by a revocation propagated from a Host (§11.5) — and
  when the provider reports this token as gone: APNs `410` or the reason
  `Unregistered`, or FCM `UNREGISTERED`. Nothing else deletes a registration.
  `DeviceTokenNotForTopic` (a wrong `--apns-topic`, or a build of another bundle
  id), `BadDeviceToken` (also what every token gets on the wrong APNs
  environment, such as production tokens on the sandbox endpoint), a bare FCM `404`/`NOT_FOUND` (a wrong project id, a wrong
  endpoint path, a proxy), `PERMISSION_DENIED`, and a refused provider credential
  are all configuration errors: they affect every token the Gateway holds, so
  deleting registrations on one would empty the platform in a single call. A
  transient provider failure keeps the registration as well.
- **Operator configuration.** `--apns-key-file`, `--apns-key-id`,
  `--apns-team-id`, `--apns-topic`, and `--fcm-service-account-file`; all four
  APNs flags are required together or not at all, a half-configured provider
  refuses to start, and both files must be regular files owned by the caller with
  mode 0600 — the same rule as `--access-key-file`. The credentials never appear
  in a log line, an audit record, or an error message; the audit records the
  event kind, the Host, and the device, which is exactly what §11.6 allows a push
  to say.
- **Credentials in flight.** APNs uses HTTP/2 with an ES256 provider JWT
  (`kid` = key id, `iss` = team id, one-hour validity, refreshed well inside it)
  and FCM the HTTP v1 API with an OAuth2 access token minted from the service
  account's RSA key and cached until a minute before it expires. The OAuth2
  exchange is single-flight, and a `401`/`403` from the messaging endpoint drops
  the cached token so the next push mints a fresh one. The provider endpoints are
  absolute `https:` URLs, checked at startup.
- **Delivery deadline.** Every provider call has a hard deadline (10 seconds by
  default). A provider that accepts the connection and then says nothing ends
  the attempt at the deadline, and the APNs session is destroyed rather than
  reused, so a wedged provider costs one timeout instead of a leaked connection.
  One notification is delivered with a fixed small concurrency (four), and one
  device's failure or timeout neither stops the others nor skips the audit
  record. The APNs session itself is pooled and reused between pushes — Apple
  asks clients to reuse the connection — and dropped on error or `GOAWAY`, when
  it has been idle for five minutes, and when the Gateway stops.

## 12. Limits and deadlines

The initial target limits are:

| Limit | Target |
|---|---:|
| JSON request or event frame | 1 MiB |
| Prompt payload | 256 KiB |
| Inline attachment, one entry (§10) | 160 KiB of raw bytes |
| Inline attachments, one prompt (§10) | 224 KiB encoded, at most 6 entries |
| Item text or tool payload, display reads (§7.6) | 64 Ki characters per field |
| Compaction summary or checkpoint payload, display reads (§7.6) | Same field budget as item text |
| Attachment | 50 MiB |
| Host link attachment chunk | 256 KiB |
| Durable session event replay | 10,000 events or 24 hours |
| Ephemeral events | Not retained |
| Queued turns per session | 8 |
| Concurrent subscriptions per connection | 8 |
| Connected clients per Agent Host | 16 |
| `connection/initialize` deadline | 10 seconds |
| Read/metadata operation deadline | 15 seconds |
| `turn/start` admission deadline | 5 seconds |
| Approval lifetime, local default | No automatic deadline; explicit decision or cancellation |
| Approval lifetime, remote policy | 30 minutes by default while a remote subscriber is attached; Host-configured, bounded, advertised as `approvalLifetimeMs` |
| Heartbeat interval | 30 seconds |
| Terminal output replay ring | 128 KiB per terminal |
| Open terminals per session | 2 |
| Relayed tool execution deadline | The tool's own timeout |
| Push notifications per Host | 20 burst, then one every 5 seconds |
| Push notifications per device | 10 burst, then one every 10 seconds |
| Remembered push event ids (de-duplication) | 4,096 per Gateway process |
| Push provider request deadline | 10 seconds per request |
| Concurrent push deliveries per event | 4 devices |
| Idle APNs session reuse | 5 minutes, then closed |

The Host MAY advertise stricter limits. It MUST return a structured limit
error rather than truncating a command silently.

Approval lifetime is a Host policy. Local desktop permission requests have no
automatic deadline and remain pending until an explicit decision, cancellation,
or shutdown. While a remote subscriber is attached, the remote approval record
has a 30-minute default lifetime (D375), because a remote approver is rarely at
the keyboard; the Host operator may shorten or lengthen it within a bound, and
a disconnect never extends it.

## 13. Errors

Every failed operation returns a JSON-RPC error or HTTP status with this
semantic payload:

```ts
type RemoteError = {
  code: string
  message: string
  retriable: boolean
  traceId: string
  details?: unknown
}
```

Initial RACP codes are:

| Code | Retriable | Meaning |
|---|---:|---|
| `UNAUTHORIZED` | no | Missing, expired, or invalid credential |
| `HOST_UNAUTHORIZED` | no | The Host behind the Gateway refused an account-mode device it has not adopted yet (§11.5), so a retry or a new request confirmed on that computer is the next step. A §11.4 device that a Host refuses stays `UNAUTHORIZED`, because that credential is gone |
| `FORBIDDEN` | no | Principal lacks the operation or session scope |
| `PROTOCOL_MISMATCH` | no | Unsupported major version or required capability |
| `INVALID_ARGUMENT` | no | Request schema or field value invalid |
| `NOT_FOUND` | no | Host, project, session, turn, approval, input, or attachment missing |
| `AGENT_UNAVAILABLE` | yes | Host or runtime is offline |
| `AGENT_BUSY` | no | Session cannot admit the turn under the requested admission mode, or the queue is full |
| `CONFLICT` | yes | Expected revision is stale or the turn is no longer in the required state |
| `IDEMPOTENCY_CONFLICT` | no | Same key was reused with different input |
| `CURSOR_EXPIRED` | no | Epoch changed or the replay window no longer contains the cursor |
| `CLIENT_TOO_SLOW` | yes | Bounded event queue was exceeded |
| `APPROVAL_EXPIRED` | no | Approval is no longer executable; maps from `PERMISSION_TIMEOUT` and `PLAN_APPROVAL_TIMEOUT` |
| `APPROVAL_STALE` | no | Approval response targets an old revision |
| `PAYLOAD_TOO_LARGE` | no | Request, event, or attachment exceeds a limit |
| `RATE_LIMITED` | yes | Principal, session, or host quota exceeded |
| `PAIRING_FAILED` | no | The pairing token is unknown or was already exchanged |
| `PAIRING_TOKEN_EXPIRED` | no | The pairing token's bootstrap window passed |
| `CAPABILITY_UNAVAILABLE` | no | The Host does not advertise the capability the operation needs; on `PUT /v1/push/registration` it means this Gateway has no provider configured for that platform (§11.6) |
| `REMOTE_PATH_NOT_FOUND` | no | A Host-side path does not exist |
| `REMOTE_PATH_FORBIDDEN` | no | A Host-side path is outside what the principal may reach |
| `INTERNAL` | maybe | Unexpected failure with a trace id |

Implementations MUST map these codes into the shared `AppError` vocabulary
before adding them to production code. The same error code MUST mean the same
thing across all bindings.

## 14. Compatibility and conformance

1. New fields are additive. Existing field names and enum meanings are never
   reused.
2. Clients ignore unknown response fields and preserve unknown event kinds for
   diagnostics.
3. A server advertises optional capabilities before a client uses them.
4. A server never changes a terminal turn, approval, or input request back to
   an active state.
5. The typebox schemas in `packages/shared` are the single source of the
   contract. JSON Schema fixtures, documentation tables, and any Protobuf file
   are generated from them; a hand-maintained second contract is a defect.
6. A binding conformance suite runs the same command/event trace through
   every shipped binding. `RACP-WS` is the reference binding; `RACP-HTTP`
   joins before a browser client ships; a reserved binding joins before it
   ships.
7. Conformance covers duplicate mutations, cursor replay, epoch change, cursor
   expiry, queued-turn ordering, approval decisions including `allow-session`
   and permission-mode selection, approval expiry, slow clients,
   authorization, the remote permission ceiling, relayed tool execution,
   terminal streaming, queue restoration after a restart, attachment hashes,
   and host restart recovery.
8. The client treats a new major protocol version as incompatible unless an
   explicit compatibility adapter is selected.

## 14a. RACP-WS binding implementation notes (D448)

`packages/racp` is the reference implementation of the `RACP-WS` binding.
Beyond the rules above it fixes these wire details:

- `connection/initialize` answers with `server.hostId`, the Host's stable
  identity minted at first start; a client keys its Host records by it, never
  by hostname, address, or path.
- The client sends `notifications/initialized` after the initialization
  result; the Host closes a connection that has not initialized within the
  §12 deadline.
- A JSON-RPC error carries the `RemoteError` under `error.data`; the numeric
  `error.code` is `-32601` for `METHOD_NOT_FOUND`, `-32602` for
  `INVALID_ARGUMENT`, and `-32000` otherwise.
- When the Host closes one subscription (`CLIENT_TOO_SLOW`) it sends the
  `events/closed` notification with the subscription id, the `RemoteError`,
  and the last safely delivered cursor; the connection stays open.
- Terminal events are connection-local and are never entered into the
  session's durable log; their `epoch` is the session's and
  `terminal.changed` carries the current sequence without allocating one.
- Device tokens are `pdt1.`-prefixed and pairing tokens `ppt1.`-prefixed;
  both are presented as `Authorization: Bearer` on the upgrade, stored
  hashed (SHA-256) on the Host, and never accepted from a URL.
- Reconnect never re-sends an in-flight request: the pending calls of the
  dropped connection fail with `HOST_DISCONNECTED`, and a caller that retries
  presents the same idempotency key.

## 15. Amendment history

D374 (2026-09-10) revised the D373 draft before implementation:

- approval and input decisions became a superset of the local
  `allow-once` / `allow-session` / `deny`, `approve` / `reject` plus
  permission mode, and asktool answer contracts;
- cursors gained an `epoch`; deltas and activity phases became ephemeral and
  left the replay window; the first log lives in Host memory;
- envelopes gained `parentToolCallId` / `agentName` and carry the shared
  `AgentEvent`; the local-to-RACP mapping table and the
  `turn.completed` = `agent_end` rule were added;
- `host/list`, `project/list`, `session/history`, host-scope subscriptions,
  `turn/stop`, `turn/cancel`, the Host-owned turn queue, and the deferred
  operation list were added; `turn/interrupt` became the immediate abort;
- `RACP-WS` became the only normative v1 binding, `RACP-HTTP` the browser
  profile, `RACP-GRPC` reserved; typebox became the single IDL;
- browser authentication profiles, the Host link relay profile, the remote
  permission ceiling, and the remote approval lifetime policy were defined;
- `replayComplete`, a single `revision`, `ItemSummary`, and the
  `APPROVAL_EXPIRED` mapping replaced the inconsistent draft names.

D375 (2026-09-10) re-sequenced the deployments and extended the catalog:

- the remote-host profile (§6.2) with `session/configure`, `session/fork`,
  `session/rename`, `session/delete`, `session/compact`, `workspace/list`,
  `workspace/read`, and `workspace/diff`, advertised as `remoteHostProfile`;
- the SSH-tunnel deployment of `RACP-WS` with the loopback rule and the
  ceiling exemption for SSH-paired owner devices;
- `RACP-HTTP`, the cookie profile, and the Host link marked as belonging to
  unscheduled milestones;
- `terminal/open`, `terminal/input`, `terminal/resize`, `terminal/close`, the
  `terminal.changed` / `terminal.output` kinds, `tools/advertise`, the
  `tool/execute` server request (§9.4), and `turn/prioritize` for the
  desktop's "send now", all in the same milestone; and
- queued turns persisted by host-core and held after a restart, the
  30-minute default approval lifetime for remote subscribers, and the
  `applyCeilingToPairedDevices` policy.

D665 (2026-10-17, ADR 0331) scheduled the Gateway and browser milestones
(R4–R6) and refined this contract:

- `RACP-HTTP` (§11.2) binds with R4 and joins the conformance fixture before
  any browser client uses it; the HTTP mapping gains
  `POST /v1/hosts/{hostId}/pair` beside the existing `GET /v1/hosts`;
- the Host link (§11.4) ships with R4; `client.open` gains the `credential`
  field, the Host re-authenticates every relayed logical connection with its
  own `DeviceTokenAuthenticator` under the connection origin `"gateway"`, and
  the route context's integrity is guaranteed by the authenticated Host link
  in the self-hosted scenario; and
- enrollment (one-time 15-minute code, pinned Gateway CA, one-year client
  certificate with the `hostId` as CN) and Gateway pairing (Host-displayed
  10-minute code, hash-only Gateway storage, cookie or response-body token
  delivery) are specified on the same listener.

D666 (2026-10-18, ADR `remote-control-router-account-binding`) adds the planned
account mode of §11.5: key verification through Router `/api/auth/session` over
loopback with the caller address forwarded, the key-lifecycle rule (a disabled
or deleted key starts no new login or enrollment but revokes nothing by
itself), enrollment by AccessKey plus CSR from the additive `remoteGateway`
bootstrap object, account-scoped login and host listing, the device request /
confirm / grant exchange over the new `device.request` and `device.grant`
Host-link frames, and the rule that those frames reach only Hosts that
advertise support. The self-hosted enrollment code and per-Host ticket of §11.4
are unchanged, and account-mode devices keep the gateway-origin roles and
restrictions of D665.

R7 follow-up (2026-10-20, no new decision) made §5.3, §7.6, and the §12 table
match what a phone actually reads:

- `session/history` is defined as one bounded window of the transcript ending
  where `beforeItemId` names, and `hasMore` as the transcript's own answer, so
  a long conversation pages without the Host materializing the whole file;
- the display cap on an item's text and tool payload is stated with its
  in-band marker and its limit, which is the cap the desktop renderer's
  bounded transcript reads already applied; and
- a page whose `beforeItemId` is gone is an empty page with `hasMore: false`,
  not the tail, so a client never replays newer items into its older-page slot.

The same follow-up caps a display read's compaction records. Measured on a real
572-message session, the newest checkpoint was 599 KB and was sent twice (once
as `compaction`, once as the last entry of `compactions`), of which 488 KB was
the runtime's `retainedTail` and 86 KB a model-facing `systemMessageJson`; the
metadata read that every attach and every turn admission performs was 1.2 MB
for that reason and is now 29 KB. The uncapped read is unchanged, because the
sidecar rebuilds the model context from those fields.

The 64 Ki-character field budget was re-measured against a 16 KiB alternative
on the same session: the largest field in a 100-item page is 63,626 characters
and only one item reaches the cap, while 16 KiB saves a further 0.34 MB per
page at the cost of truncating several ordinary tool results. The budget stays
at 64 Ki.

## 16. R7 additions (§16.1 implemented; §16.2 still proposed)

§16.1 (`model/list`) was approved on 2026-10-21 and is implemented; the
normative catalog in §6.1 and the HTTP route table carry it, and the amendment
that records the decision is
[ADR `remote-control-router-account-binding` amendment 2](../../adr/remote-control-router-account-binding.md).
§16.2 step 1 (inline attachments) was approved on 2026-10-21 and is
implemented; step 2 (the two-phase upload of §10) remains a proposal, and nothing
of it exists in code.

### 16.1 `model/list` — the catalog a remote device may choose from

`session/create` and `session/configure` already accept `providerId`,
`modelId`, and `thinkingLevel`, but no operation lets a client learn the valid
values, so a phone can neither offer a choice nor name the model a session runs
on.

Implemented: the operation `model/list`, role `viewer`, `GET /v1/models` in
the RACP-HTTP route table, parameters none, response
`{ models: ModelSummary[] }`:

```ts
type ModelSummary = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  thinkingLevels: string[];
  defaultThinkingLevel?: string;
  supportsImages: boolean;
  isDefault: boolean;
};
```

Requirements, in the order they bind:

- The response MUST be metadata only. No credential, API key, base URL, proxy,
  header value, or price may appear; a Host that cannot describe a model without
  one of those omits the model.
- `RacpSession` (§5.1) gains optional `providerId`, `modelId`, `modelLabel`,
  and `thinkingLevel`. Optional and additive: a Host that sends none still
  produces a valid session.
- `session/configure` keeps its existing shape; changing the model of a session
  with a running turn is `AGENT_BUSY`, the same rule the desktop applies.
- The Gateway needs no new code (it validates against `RACP_OPERATIONS` and the
  shared route table) but MUST have a test proving `GET /v1/models` is
  forwarded like every other declared route.

### 16.2 Attachments — the §10 flow, in two steps

§10 already defines the flow and §12 the limits; no Host implements either, so
`attachment/create`, `attachment/complete`, and `turn/start` with attachments
are unavailable today.

Step 1 (implemented 2026-10-21), the form a phone actually sends:

- Inline `turn/start` attachments, bounded by `maxPromptBytes` (256 KiB for the
  whole request, so far under `maxFrameBytes`), with the per-entry and per-prompt
  budgets of §12. A Host advertising `attachments` advertises the inline budget
  it enforces as `limits.maxInlineAttachmentBytes`.
- The Host validates the bytes, not the claim: PNG, JPEG, WebP, GIF, and UTF-8
  text only; a declared MIME type that disagrees with the content is
  `INVALID_ARGUMENT`. SVG is refused.
- The Host stores the bytes in its content-addressed attachment store — the same
  place, and the same `attachments/<sha256>` name, that the desktop uses for the
  files its own user attaches — and passes the runtime the path it already reads.
  Content addressing means two devices sending the same picture cost one copy;
  the store is shared with local attachments, so it is deliberately not swept
  when one session is deleted.
- A path, `file://` URL, or arbitrary URL in place of an upload stays forbidden
  (§10), including as an "already on my computer" reference.
- The client is not obliged to ask first: it downscales a picture until it fits,
  so what crosses the wire is what a model reads rather than what the camera
  wrote, and a file it cannot fit is refused in the composer with a reason.
- A Host that cannot take the bytes advertises `attachments: false` and answers
  `CAPABILITY_UNAVAILABLE`; it never accepts a prompt and silently drops the
  attachment.

Step 2 (proposed second): the same §10 flow with a Gateway-served, single-use,
time-bounded upload target, `attachment/complete` verifying size and SHA-256,
bytes crossing the Host link in 256 KiB chunks, and the serving proxy's body
limit (`client_max_body_size`, 10 MiB on the reference deployment) as the real
per-file ceiling rather than the protocol's 50 MiB maximum.

### 16.3 What does not change

Roles (`viewer` reads, `controller` writes and creates), the session-scoped and
host-scoped event model, cursors and replay, snapshot composition, the
permission ceiling for gateway-origin principals, and the approval lifetime
policy are all untouched by this proposal.
