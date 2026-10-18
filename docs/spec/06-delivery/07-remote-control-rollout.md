# Remote Agent Control Rollout and Acceptance

- Status: Target delivery specification; post-MVP
- Decision: D373 / ADR 0205, amended by D374 and D375
- Normative protocol: `03-runtime/19-remote-agent-control-protocol.md`
- Normative security: `05-security/02-remote-control-security.md`

## 1. Delivery boundary and order

Remote control is a post-MVP capability. The current MVP continues to ship:

- Electron Main as the local orchestrator;
- Node pi sidecar as the Agent runtime;
- Rust host-core over local stdio NDJSON JSON-RPC;
- optional loopback-only MCP control under ADR 0203; and
- no public or LAN Gateway listener.

Remote work MUST NOT begin by exposing the existing host-core or IPC endpoint.
The implementation starts with the typebox contract, the headless Agent Host
module, and conformance tests, then adds transport bindings behind explicit
feature flags.

D375 fixes the order of the milestones around recorded demand rather than
around transport breadth:

- issues #176 and #140 ask to operate projects on a remote Linux or WSL
  machine from the local desktop, which is the SSH-tunnel remote Host
  topology;
- issue #100 asks for task completion and approval notifications on
  Telegram, WeChat, Slack, or a webhook, plus simple commands back, which is
  an outbound integration beside the Host; and
- the maintainer asks to follow running turns, answer approvals and input
  requests, and start, stop, or interrupt turns from a phone against both an
  always-on `agent-host-cli` machine and the sessions of a running desktop,
  which schedules the Gateway, connected-Host, and browser/mobile-client
  milestones (D665, ADR 0331).

The scheduled order is R0, R1, R2, R3, then R4, R5, and R6 (D665), followed by
R7, the Router-account binding (D666, planned). The reserved gRPC binding stays
unscheduled: it is delivered only when a named consumer needs it, by a later
recorded product decision.

### Experimental desktop MVP (narrow acceptance slice)

The desktop exposes Remote Hosts in all builds with an Experimental badge. This
slice implements SSH install/pair/reconnect, explicit eligible-provider copy,
remote project registration, Agent/Ask session creation/opening, text chat,
tool/input responses, bounded transcript history, and read-only text/files/diffs.
Remote identity remains visible offline and never activates a local workspace.
Unsupported remote operations fail closed; reconnect does not replay prompts.

Terminal UI, reverse MCP/plugin relay, attachments, local model/think controls,
message edits, Plan/Goal creation UI, and cross-host handoff are deferred. This
slice does **not** satisfy every R2 exit criterion; the broader milestone remains
open. It supersedes the developer-only entry restriction below, not the full R2
acceptance gate.

Verification is layered and recorded separately:

1. Shared contracts, socket/CLI, Desktop routing/state and recovery regressions.
2. `scripts/e2e-remote-mvp.mjs`: packaged Host + actual Rust/Agent runtime + Desktop
   main routing, with a loopback model fixture. Import/reimport, pairing, session
   creation, approval across reconnect, one execution, history, files/diff and
   removal. This is not an `sshd` or full Desktop acceptance test.
3. `scripts/e2e-remote-mvp-ui.mjs`: real React/Chromium component clicks with a
   mocked IPC boundary and isolated profile; no user Desktop or real providers.
4. Full Linux SSH/Desktop bootstrap, checksum/version rejection, restart and
   password-only SSH remain E2E-231 prerequisites and require a real target.

Published SSH bootstrap requires the matching release to contain the new Host
bundle; a successful local bundle does not publish those release assets.
See `apps/agent-host-cli/README.md` for candidate build and local acceptance commands.

## 2. Milestones

### R0 — Contract and test fixtures

Deliver:

- RACP v1 resource and operation schemas as typebox definitions in
  `packages/shared`, the single source of the contract, including the
  remote-host profile operations of protocol §6.2;
- generated JSON Schema fixtures and shared request/response/event traces;
- error mapping and capability negotiation fixtures;
- cursor, epoch, snapshot, idempotency, turn-queue, and approval
  state-machine tests, including `allow-session` and Plan/Goal
  permission-mode selection;
- binding-independent authorization test vectors, including the remote
  permission ceiling and the SSH-paired owner exemption; and
- threat model review against the security specification.

Exit criteria:

1. A fixture trace has an identical semantic result for every shipped
   binding adapter.
2. Duplicate, stale, expired, and unauthorized requests have deterministic
   outcomes.
3. No fixture requires direct host-core or renderer access.
4. No hand-written second copy of the contract exists.

### R1 — Headless Agent Host module

Deliver `packages/agent-host`, a module with no Electron dependency that
owns session and turn admission, the per-session turn queue, the approval
broker, the in-memory event log with epochs, and the snapshot builder
including active items and pending requests. Electron Main hosts it; the
existing IPC handlers become adapters over it, incrementally if needed. Two
local changes ship with it:

- Rust host-core exposes `permissions.pending` so a late-attaching client
  receives open requests; and
- the renderer's in-memory prompt queue is replaced by the Host-owned turn
  queue, persisted by Rust host-core under its own ADR and schema bump
  (D375), restored after a restart and held until a controller attaches, so
  every client sees the same pending prompts and a reboot never starts work
  unattended.

A development-only loopback RACP-WS endpoint drives the module; it is not
reachable outside loopback or an explicit development tunnel.

Exit criteria:

1. A client can close and reopen without interrupting a turn.
2. A stale cursor or a new epoch results in a snapshot, not an invented event
   sequence.
3. Existing local renderer behavior and the local MCP control plane are
   unchanged, and the desktop's queued prompts now come from the Host queue.
4. The module's test suite runs without Electron.
5. A client that attaches during an open approval sees it in the snapshot and
   its decision closes the local desktop card.

Timing: the extraction starts after the release in flight ships, and each of
`permissions.pending`, the Host queue, and the module extraction lands as its
own commit, because the repository has concurrent sessions and 54 tests that
match `electron/main/index.ts` by source pattern and must be repointed.

### R2 — Remote Host over an SSH tunnel

Deliver the first remote topology (`02-architecture/05-remote-agent-control.md`
§5.2): the desktop as Remote Client of a headless Host on another machine.

R2 lands in two ordered slices so the desktop-side kernel can ship, be
tested, and stay dead code until the full topology is ready:

- **R2a — Desktop kernel (delivered, ADR 0286).** The single interception
  seam, the transport-agnostic backend, the event bridge, the coordinator, an
  encrypted-at-rest registry, and the boot hook. With an empty registry
  (default install) the kernel is a full no-op; the router has no remote
  backends, every renderer call still hits the local handler byte-for-byte.
  Every subsystem has a `node --test` fixture that exercises it against a
  fake — or, for the RACP adapter, against the real in-memory harness in
  `@minih-agent/racp/test-harness`.
- **R2b — Pairing, SSH bootstrap, terminal, and reverse tool relay.** The
  remaining bullets below. R2's exit criteria stay unchanged and land with
  R2b; R2a alone is not user-visible and does not attempt them.

Deliverables:

- the `agent-host-cli` bundle: the module, the Node pi sidecar, and the platform's
  host-core binary, versioned with the desktop, bound to loopback, downloaded
  from GitHub Releases by a bootstrap script the desktop uploads over SSH
  with the published SHA-256 verified before install, then started and paired
  over that SSH session;
- the desktop RACP client adapter in Electron Main under `lib/api.ts`, so the
  renderer needs no transport knowledge and a remote session renders like a
  local one;
- `RACP-WS` on the header profile over the forwarded port, with the loopback
  rule of security §5.1 and the device-token pairing of security §3.2;
- the remote-host profile operations (`session/configure`, `session/fork`,
  `session/rename`, `session/delete`, `session/compact`, `workspace/list`,
  `workspace/read`, `workspace/diff`) so mode, model, thinking level, and the
  work panel's files and diff work against the remote session; and
- the remote session ownership split of architecture §6.3;
- the reverse tool relay: `tools/advertise` and the `tool/execute` server
  request, so desktop MCP servers and workspace-free plugin tools run on the
  desktop for a remote session;
- the terminal: `terminal/open`, `terminal/input`, `terminal/resize`,
  `terminal/close`, `terminal.output`, and a bounded replay ring, running on
  the remote machine; and
- the Settings → Remote Hosts destination: a compact host inventory and one
  Add form with SSH and Pair tabs, marked Experimental on the rail and page
  title. The narrow MVP also exposes inline sessions and explicit model-copy
  consent; the destination and search hits are available in packaged builds.

Design decisions (D375, recorded 2026-09-10):

1. Provider configuration on the remote Host is written over the SSH
   bootstrap channel as Host-local configuration; nothing crosses RACP.
2. Desktop user MCP servers and workspace-free plugin tools reach remote
   sessions through the reverse tool relay in this milestone; plugin tools
   that require workspace or filesystem access are excluded.
3. The work-panel terminal ships in this milestone as the `terminal/*`
   operations, running on the remote machine.
4. `agent-host-cli` is downloaded from GitHub Releases per platform at the desktop's
   version by a bootstrap script the desktop uploads over SSH, with the
   published SHA-256 verified; a version mismatch is `PROTOCOL_MISMATCH`
   and the desktop offers to re-run the download. A machine without outbound
   access to GitHub is not supported in the first version.
5. The SSH-paired desktop device holds `owner` and is exempt from the remote
   permission ceiling unless the Host policy `applyCeilingToPairedDevices`
   is enabled.
6. Full R2 remains one acceptance milestone; the experimental MVP above is a
   narrower usable slice, not a claim that terminal and relay have shipped.

Exit criteria:

1. E2E-231 passes: a turn started from the desktop reads, writes, and runs
   commands on the remote machine only, approvals appear in the desktop card,
   and the remote host-core binds loopback only.
2. Dropping and restoring the SSH session mid-turn resumes by cursor without
   duplicating the turn.
3. Mode, model, and thinking-level changes on a remote session behave as
   locally, idle-only.
4. The remote tool catalog contains no desktop plugin tool.
5. A `agent-host-cli` at another version is rejected and the update path is offered.
6. A desktop-configured MCP tool advertised for relay executes on the desktop
   during a remote turn, a workspace-requiring plugin tool is absent from the
   remote catalog, and closing the desktop mid-call fails the tool without
   interrupting the turn.
7. A terminal opened on a remote session runs on the remote machine inside
   the session root and its output resumes from the replay ring after an SSH
   drop.
8. The bootstrap download verifies the published checksum and refuses a
   tampered bundle.

### R3 — Outbound messaging integration

Deliver the integration adapter beside the Host (issue #100): a further
caller of the module inside the Host process, with no transport and no
inbound listener.

- It subscribes to host-scope and session events and relays redacted
  summaries of `turn.completed`, `turn.failed`, `approval.requested`, and
  `input.requested` to outbound channels: webhook first, then Telegram and
  Slack through their outbound polling or socket modes; channels that require
  an inbound callback are deferred.
- It maps a fixed command vocabulary from a linked chat to `turn/start`,
  `turn/stop`, `turn/interrupt`, and `approval/respond`, executed under the
  linked principal's roles and the same Host policy as any client; unlinked
  chats are ignored and audited.
- It never blocks a turn: delivery failures are logged and retried with a
  bound, and the Host runs the same whether the adapter is configured or not.

Exit criteria: E2E-232 passes; payloads contain summaries and ids only;
commands from an unlinked chat have no effect; the Host has no new listener.

### R4 — Self-hosted Gateway and Host link (D665)

Deliver `apps/remote-gateway`, the self-hosted Node service (ADR 0331), and
the `agent-host-cli` outbound enrollment and link:

- the Gateway modules: configuration with the bind-address validations, the
  `--data-dir` file store, the local CA with enrollment and revocation, the
  wss + mTLS Host link listener that replaces a same-`hostId` connection only
  after identity checks, the `RACP-HTTP` + SSE client API with the cookie and
  header profiles plus Origin, CORS, and CSRF controls, the pairing relay,
  the HTTP-to-logical-connection router, per-device and per-IP rate limits,
  the redacted audit log, and the `serve` / `enroll-code` / `hosts list` /
  `hosts revoke` / `devices list` / `devices revoke` CLI;
- `agent-host-cli enroll` (local key pair, CSR plus one-time code, Gateway CA
  pinned with `--gateway-ca`), the opt-in `--gateway <wss-url>` outbound link
  with 1s–60s jittered exponential backoff, and `remote-pair` over the
  existing admin socket; the loopback `RACP-WS` listener, `--pair`, and SSH
  bootstrap are unchanged;
- the Host link contract of protocol §11.4 with the `credential` field, and
  the device-origin rules of security §3.7: gateway pairing grants
  `viewer` / `controller` / `approver`, never `owner`, sets
  `pairedDevice: false`, and a gateway token authenticates only on the Host
  link while the Host re-authenticates every relayed logical connection;
- a standalone packaged Gateway artifact (single directory plus Node entry)
  and a deployment README with a systemd example, an Nginx reverse-proxy
  example that passes SSE through unbuffered (`proxy_buffering off`,
  `X-Accel-Buffering: no`), and the enrollment and revocation steps; and
- `RACP-HTTP` joins `RACP_SHIPPED_BINDINGS` after its conformance tests
  pass.

The Gateway holds no transcript, no provider secret, and no durable turn
command; while the Host is offline it does not queue non-idempotent
commands. The Host link listener binds only to a configured private or
overlay address (RFC1918, `100.64.0.0/10`, or an explicitly configured CIDR)
and refuses to start on `0.0.0.0`, `::`, or a public address; the client API
binds loopback behind a TLS-terminating reverse proxy, or elsewhere only
with TLS configured.

Exit criteria:

1. E2E-227 passes against the packaged Gateway and a real `agent-host-cli`:
   no inbound Host port, a relayed approval answered exactly once,
   resumable cursors across a link drop, and a revoked credential cannot
   re-enroll. Attachment relay is deferred: `RacpServer` currently declares
   `attachments: false`, so E2E-227's step 5 does not run in R4 and its
   Status records the deferral; it is enabled when the RACP attachment
   capability ships.
2. The bind rules hold: a wildcard or public Host link bind and a
   non-loopback client-API bind without TLS refuse to start (security gates
   22–23).
3. Tokens never appear in URLs, query strings, SSE URLs, or event payloads;
   browser requests pass the Origin allowlist (§5.2, gate 14) and every
   mutation carries a CSRF token (gate 24).
4. A gateway-paired device cannot execute owner-only operations, stays under
   the remote permission ceiling, cannot obtain `allow-session`, and its
   token is rejected on the loopback `RACP-WS` binding (gate 25).
5. Revocation on either the Gateway or the Host rejects new connections and
   closes existing logical connections within 5 seconds (gate 26).
6. The Gateway can be wiped and re-enrolled without losing Host session
   data, and the audit log contains no tokens or content.

### R5 — Desktop as a connected Host (D665)

Deliver the desktop's outbound gateway link (ADR 0331):

- an Electron-Main `RacpServer` transport over the Host link host running on
  the existing in-process Agent Host: no new AgentHost, no new execution
  path, and no listener;
- the optional `remoteGateway` AppSettings field (`enabled`, `url`;
  device-local, never synced, absent means off) and the Experimental
  settings page: switch, gateway URL, enrollment code, link status, a
  pairing code shown as copyable text with a 10-minute countdown, and the
  paired-device list with revoke;
- main-process device-credential storage encrypted through `EncryptionPort`,
  never in SQLite and never in host-core's schema; the mTLS key and
  certificate are stored separately from settings;
- the `minih-agent-desktop/remoteGateway/*` IPC channels, all added to the
  MCP control block list; and
- lifecycle cleanup: disabling the setting, app quit, and `before-quit`
  close the link and cancel pending server requests without touching local
  turns; a renderer reload leaves the main-owned link running and only drops
  that renderer's status subscription.

Exit criteria:

1. With the setting off, behavior is identical to the current desktop: no
   connection is attempted and no listener opens (regression tests; security
   gate 27).
2. Enabling the setting opens exactly one outbound link; disabling and
   quitting close it and cancel pending server requests, while a renderer
   reload leaves it running and the settings page re-subscribes to its status.
3. A gateway-routed principal stays under the remote permission ceiling,
   cannot change a local session's permission mode, and cannot use
   `allow-session`; `DESKTOP_PRINCIPAL` is unchanged.
4. Revoking the desktop's device closes the link.
5. The mTLS key and certificate are stored encrypted outside settings and
   outside SQLite.

### R6 — Browser and mobile clients (D665)

Deliver `apps/remote-web` (ADR 0331):

- the React + TypeScript client on the Node-free `@minih-agent/racp/browser`
  entry and the shared typebox contracts, with no dependency on
  `apps/desktop` sources;
- the pages: pairing (paste the `mpt1:<hostId>:<pairingToken>` ticket, device
  label), the Host list with online state, the session list with running /
  waiting-for-approval badges, and the live timeline with message rows,
  tool-call summaries, collapsible tool details, approval and input cards
  carrying the local decision vocabulary except `allow-session`, and a composer
  to start, stop, or interrupt a turn;
- snapshot-plus-cursor state with resume from the last cursor on
  `visibilitychange`, idempotency keys on mutations, and submit-disabled
  buttons;
- mobile adaptation: `env(safe-area-inset-*)`, touch targets of at least
  44px, dark mode, and a PWA manifest with icons;
- the pairing ticket: `packages/shared` owns the `mpt1:<hostId>:<pairingToken>`
  codec, the Host prints it beside the pairing code (the desktop settings page
  and `agent-host-cli remote-pair`), and the browser pairs with it because the
  Host-scoped cookie path never exposes `GET /v1/hosts`;
- the browser cookie profile fixes: a finite `Max-Age` on both pairing cookies
  so a pairing survives a browser restart, and a same-origin `GET`/`HEAD`
  accepted without `Origin` (security §5.2) so H5 reads and event streams work
  while every other cookie request still proves its Origin;
- the Capacitor iOS and Android packaging with native credentials in the
  Keychain / Keystore through a `CredentialPort`, and optional redacted push
  carrying ids and fixed summary kinds only.

Exit criteria:

1. E2E-228 passes with `RACP-HTTP` beside `RACP-WS`: identical semantic
   results, the cookie profile with Origin and CSRF checks, and URL tokens
   rejected.
2. E2E-266 passes: ticket-based pairing, timeline resume with `Last-Event-ID`,
   approval, and stop on two mobile viewports driven through Electron's
   Chromium device emulation behind a same-origin proxy, with screenshot
   artifacts kept out of the repository.
3. The browser build never stores the token in script-readable storage;
   native builds keep it only in the iOS Keychain (device-only, no iCloud sync)
   or the Android Keystore, with `allowBackup="false"` so the wrapped ciphertext
   cannot be restored onto another device. Done in PR-5: the native
   `CredentialPort`, the static release-configuration test, and the
   `E2E-REMOTE-MOBILE-native-shell-credential-storage` scenario cover it; a real
   device acceptance stays with the user.
4. Push payloads contain ids and event types only, and push is off without
   operator credentials. Deferred to PR-6: PR-5 ships no push plugin, no
   Firebase/APNs file, and no background mode.
5. Pairing works from the ticket alone — the client learns the Host id from it,
   both pairing cookies carry a finite `Max-Age`, and a cookie request that is
   not a same-origin `GET`/`HEAD` still proves an allowlisted `Origin`.

### R7 — Router-account binding (D666)

Deliver the account mode of ADR `remote-control-router-account-binding` on top of
R4–R6 (D665). The self-hosted enrollment and per-Host pairing flow of R4 and R5
keeps working unchanged; account mode is selected when the Router answers a
`remoteGateway` object in the bootstrap. Work packages, one PR each:

| # | Repository | Work | Depends on |
|---|---|---|---|
| A | Desktop | this decision: the ADR, the spec updates, decision D666 (docs only) | — |
| B | Router | additive `remoteGateway {hostlinkUrl, publicOrigin, caPem}` in the bootstrap answer, its system setting, tests, and docs | A (contract) |
| C | Desktop | Gateway account directory: enroll-by-key, account login, account host list, trusted-proxy client IP, cross-account isolation tests | A |
| D | Desktop | device request / confirm relay: `device.request` / `device.grant` Host-link frames, Host-side confirm and grant verification, `agent-host-cli` support | C |
| E1 | Desktop | host-core: parse the Router's `remote_gateway` object and install the second overlay forward in No-TUN mode | B |
| E2 | Desktop | Electron main auto-enrollment and Host-link wiring from that endpoint, the desktop confirm dialog, strict mode, and i18n | D, E1 |
| F | Desktop | clients: AccessKey login and the host switcher in `apps/remote-web` | C, D |
| G | Desktop | push on top of accounts | F |
| D-1 | ops | deploy next to the Router; needs the domain and user authorization | C–F |

B and C can run in parallel after A.

Scope notes:

- the Gateway stays a separate process with its own release and `--data-dir`,
  and does not join the Router's single-instance smooth-upgrade flow;
- it needs the Router to list its loopback peer in `TRUSTED_PROXIES` and to set
  `CLIENT_IP_HEADER` to the header it sends, a Host-link listener on the mesh
  address allowed with `--hostlink-allow-cidr` (the mesh range is neither
  RFC1918 nor `100.64.0.0/10`), and a domain or path prefix for the H5 client —
  all deployment decisions;
- E1 installs the second No-TUN forward to the Host-link address on the overlay
  (provider-config §3); TUN mode needs none;
- the new frames reach only Hosts that advertise support, and the advertisement
  is defined by package D;
- the device request / confirm relay moved from package C to package D: relaying
  a request and accepting a signed grant depends on the `device.request` /
  `device.grant` frames and the capability advertisement that D defines, so C
  owns only the account directory and D owns everything the relay is built on.

Exit criteria:

1. E2E-REMOTE-ACCOUNT-cross-account-isolation passes: a key of one account
   cannot list, enroll against, or route to another account's Hosts.
2. E2E-REMOTE-ACCOUNT-confirm-once-roams-all-hosts passes: one approval on one
   Host yields a device token the account's other Hosts accept, including a Host
   that was offline at grant time.
3. E2E-REMOTE-ACCOUNT-strict-mode-requires-per-host-confirm passes: a Host in
   strict mode refuses a sibling grant and asks its own user.
4. E2E-REMOTE-ACCOUNT-key-rotation-keeps-account passes: a rotated key resolves
   to the same account and enrolled Hosts stay enrolled.
5. E2E-REMOTE-ACCOUNT-disabled-key-blocks-login passes: a disabled or deleted
   key is refused for login and enrollment, while already approved device
   tokens and Host certificates stay valid until revoked; with per-key mesh
   credentials, a Host's link ends no later than its credential's expiry
   (ADR decision 8).
6. Security gates 29–33 are signed off; in particular the Gateway never
   persists a raw AccessKey, never forwards a client's key to a Host, and a
   client does not retain it after the exchange (gate 30).
7. A desktop where account mode is unavailable (no `remoteGateway` object, or a
   `404` from the bootstrap) keeps the self-hosted flow of R4 and R5, reports no
   error, and hides the account-mode affordances.

### Reserved — gRPC binding

`RACP-GRPC` is delivered only when a named native service consumer or
Gateway implementation needs it. Generate the `.proto` and clients from the
typebox source; do not maintain an independent hand-written gRPC contract.
It is not a release gate for remote control.

## 3. Implementation rules

### 3.1 Preserve the local path

The RACP server calls the headless Agent Host module, which calls the same
host and sidecar paths the renderer uses. It does not call the renderer,
`host.proxy`, or Rust host-core from a network listener. The `agent-host-cli` bundle
runs the module and supervision on another machine without changing RACP.

### 3.2 Keep the Agent independent of clients

The Host owns active turns, the turn queue, and event cursors. Client
lifetime, browser tab lifetime, Electron window visibility, and SSH session
lifetime do not control Agent execution. A client must explicitly call
`turn/stop` or `turn/interrupt` to end a turn.

### 3.3 Keep the queue in the Host

Queued prompts are Host state. No client, including the local renderer,
keeps a private queue once the module ships; a queued turn is visible to
every attached client and can be canceled by any controller.

### 3.4 Keep the renderer transport-agnostic

The renderer reaches every backend through `lib/api.ts`. The desktop RACP
client adapter implements that surface for a remote Host; features the
remote-host profile does not cover are hidden by capability negotiation, not
stubbed. The renderer never learns whether a session is local or remote
beyond a display badge.

### 3.5 Make replay a first-class test surface

Every event-producing test records:

- the initial snapshot revision and cursor;
- the exact command and idempotency key;
- every durable event sequence applied;
- the disconnect point;
- the replay request; and
- the final snapshot hash.

The test fails if a duplicate, gap, out-of-order durable event, or
unannounced state change appears. Ephemeral events are excluded from ordering
assertions and must be reconstructible from the snapshot's active items.

### 3.6 Keep bindings semantically equal

The conformance fixture is the source of truth for behavior. Each shipped
binding may choose its native status and serialization, but it must preserve:

- operation acceptance and rejection;
- authorization scope and the remote permission ceiling;
- idempotency result;
- durable event order and cursor;
- queue order;
- approval lifecycle and decision vocabulary;
- attachment hash and size checks; and
- terminal turn state.

## 4. Validation plan

### 4.1 Unit and contract validation

- generated schema validation for every request, response, and event;
- state-machine transition tests for Session, Turn, turn queue, Approval,
  Input, and Attachment;
- idempotency tests with lost response and retry;
- cursor replay, epoch change, expiry, gap, and snapshot tests;
- authorization matrix tests for every role and operation, including the
  permission ceiling, its SSH-paired exemption, and `allow-session` policy;
- redaction tests for prompts, tool data, credentials, pending-request reads,
  integration payloads, and attachments; and
- generated binding round-trip tests.

### 4.2 Integration validation

- the headless module inside Electron Main with the real sidecar and
  host-core supervision;
- a `agent-host-cli` bundle on a Linux test machine reached through an SSH port
  forward, including bootstrap, pairing, version mismatch, and re-pairing;
- the desktop adapter rendering a remote session through the unchanged
  renderer;
- SSH session drop and restore while a remote turn is running;
- host restart while a turn is running and turns are queued, verifying that
  the persisted queue is restored and held;
- relayed tool execution and terminal streaming across an SSH drop;
- bootstrap download with a valid and a tampered checksum;
- the integration adapter against a webhook sink and a long-polling bot
  fixture; and
- when scheduled: Gateway routing across two Hosts, browser reconnect on the
  cookie profile, and the Host link relay through a NAT harness.

### 4.3 Security validation

- invalid, expired, revoked, and wrong-Host device tokens;
- non-loopback peers and non-loopback binds without TLS on a `agent-host-cli`;
- pairing token reuse, pairing over a non-SSH channel, and, from D665, the
  cross-channel redemption of pairing codes: an ssh-origin code through the
  Gateway, and a gateway-origin code on the loopback `RACP-WS` binding
  (security §3.7, gates 17 and 28);
- wrong role, wrong Session, wrong Host, and stale revision;
- SSRF and arbitrary file/path attempts, including `workspace/read` outside
  the session root;
- oversized and hash-mismatched uploads;
- prompt-injected requests attempting to select secrets or permissions;
- integration commands from unlinked chats and replayed commands;
- slow-reader and connection-exhaustion tests;
- audit-log redaction and retention checks; and
- when scheduled: Origin, CORS, CSRF, cookie, and Gateway relay checks.

### 4.4 Operational validation

Record at minimum:

- turn admission latency and queue depth;
- event delivery latency and sequence lag over the SSH forward;
- replay, resync, and epoch-change counts;
- approval wait time and expiry count;
- Host connection health, bootstrap duration, and version mismatches;
- authentication and authorization failures;
- integration delivery latency and retry counts;
- event queue drops, ephemeral and durable separately; and
- active Host/Session/client counts.

The first production target is a bounded, observable remote control service,
not an unbounded real-time stream. Load tests must demonstrate that a slow or
disconnected client does not affect Agent execution on either machine.

## 5. Rollout and rollback

1. Ship the typebox contract, generated fixtures, and disabled code paths
   first.
2. Enable R1 only in development profiles.
3. Enable the SSH-tunnel topology behind a feature flag for allowlisted test
   users, then generally.
4. Enable the integration adapter as an opt-in setting with no channel
   configured by default.
5. Ship R4–R6 as separately enabled surfaces (D665): the Gateway is a
   standalone service the user starts; the desktop link and the mobile
   clients are off-by-default opt-in settings. The reserved gRPC milestone
   is scheduled only by a later recorded product decision.
   R7 (D666) is enabled per Router: account mode turns on only when the Router
   answers a `remoteGateway` object, and removing that object rolls it back;
   desktops then keep the self-hosted flow.
6. Keep a kill switch that rejects new remote connections and cancels queued
   turns submitted by remote principals while preserving already-running
   local desktop sessions.

Rollback MUST:

- stop accepting new remote connections and stop the integration adapter;
- leave a remote `agent-host-cli` process running or stopped according to the
  user's choice, never deleting its transcripts;
- leave local stdio, renderer, and MCP paths usable;
- preserve completed local transcript data; and
- never replay a turn merely because a remote feature flag changed.

## 6. Release acceptance

The scheduled feature set is not production-ready until:

1. remote scenarios E2E-221 through E2E-226, E2E-229, E2E-230, and E2E-231
   are green in the approved remote harness, and E2E-232 for the integration
   adapter;
2. the security acceptance gates in
   `05-security/02-remote-control-security.md` that apply to the scheduled
   milestones are signed off;
3. a failure-injection run proves no duplicate execution after reconnect,
   including an SSH session drop;
4. `agent-host-cli` bundles are published to GitHub Releases with checksums for
   every Linux platform the desktop's release pipeline publishes, and the
   version-mismatch and tampered-download paths are tested;
5. the Host operational metrics are available; and
6. a new release/rollback runbook names the feature flag, pairing revocation
   path, data retention on the remote machine, and incident owner.

Binding parity and E2E-227 / E2E-228 become gates when their milestones are
scheduled.

R4–R6 admission (D665): E2E-227, E2E-228, E2E-265, and E2E-266 are green
against the packaged Gateway, the connected desktop Host, and the mobile
client; the security gates 22–27 of
`05-security/02-remote-control-security.md` are signed off, including the
desktop-off regression; and the deployment README's Nginx example is
verified to pass SSE through unbuffered.

R7 admission (D666): the five `E2E-REMOTE-ACCOUNT-*` scenarios are green against
a local Router test instance and the packaged Gateway, and security gates 29–33
of `05-security/02-remote-control-security.md` are signed off.

## 7. Implementation status

Recorded on the `feat/remote-agent-host` branch, 2026-09-10:

- R0 shipped: the RACP contract as typebox schemas in `packages/shared`
  (`racp.ts`), the generated JSON Schema fixture, the local-to-RACP event
  mapping, the remote permission ceiling, and the shared error codes.
- R1 shipped: host-core `permissions.pending`; the headless
  `packages/agent-host` module with the epoch event log, bounded fan-out,
  the approval broker, the turn queue, and the snapshot builder; the
  Electron bridge that hosts the module over the existing IPC handlers and
  feeds every agent event through it; and schema v15 with the persisted
  `turn_queue` and its RPC methods (D386 / ADR 0213).
- R1 shipped: the renderer's in-memory prompt queue is retired; the
  composer pushes through `agent/queue/push`, mirrors
  `agent/event/queueChanged`, and "send now" is `turn/prioritize` plus a
  graceful stop.
- R1 partial (2026-09-18): the runtime-level per-turn permission ceiling is
  plumbed end-to-end (`AgentPromptRequest.permissionMode` → agent-ipc →
  `RuntimeService.startTurn` → sidecar `agent.prompt`), and the bridge no
  longer fails closed on every session/effective-mode mismatch. A widening
  request (effective more permissive than session) is still refused as
  defence-in-depth; a narrower ceiling is forwarded and recorded by the
  sidecar as a documented stub. Turn-scoped enforcement in host-core
  (`session.beginTurn` accepting an override) is the remaining piece, so a
  narrower ceiling on a local turn does not yet clamp tool decisions.
- R2 started (2026-09-18, D447 / ADR 0284): `packages/host-runtime` holds the
  Electron-independent runtime layer — the host-core and sidecar stdio
  transports, the restart supervisor, `RuntimeService` (the module's
  `RuntimePort` with the durable turn lifecycle), transcript persistence, a
  headless launch resolver, and approved Plan/Goal dispatch — and Electron
  main runs on it through thin adapters.
- R2 (2026-09-18, D448 / ADR 0285): `packages/racp` holds the `RACP-WS`
  server and client cores, the `ws` binding on loopback, and device-token
  pairing; handshake, authorization, idempotency, queue order, approvals,
  cursor replay, eviction, epoch change, slow clients, and reconnect without
  duplicate execution are package tests. The `agent-host-cli` bundle, the desktop
  adapter, and the SSH bootstrap have since started: the R2a desktop kernel
  (D449 / ADR 0286) brought the adapter and the bundle, and the SSH bootstrap
  followed in D453 / ADR 0292.
- R2b partial (2026-09-19, D453 / ADR 0292): the desktop installs and pairs
  a `agent-host-cli` over the user's own `ssh` client with `BatchMode=yes`, so the
  user's configuration, agent, and jump hosts apply and no SSH secret reaches
  the app. `remote/agent-host-cli-release.ts` holds the pure release coordinates
  (remote platform, desktop version, published SHA-256, refusal of unpublished
  targets) and `remote/agent-host-cli-bootstrap-script.ts` generates the single
  `umask 077` script that downloads, verifies, installs under the remote
  `$HOME`, restarts the host on loopback with `--pair`, and echoes
  `AGENT_HOST_CLI_READY` / `AGENT_HOST_CLI_PAIRING_TOKEN`; `remote/ssh-transport.ts` is the
  injectable transport port and `remote/ssh-tunnel.ts` owns one durable
  `ssh -N -L` forward per host, re-established on every launch and adopted
  from the bootstrap so pairing opens exactly one tunnel. Records carry
  `metadata.transport = "ssh"` plus an SSH descriptor instead of a URL, and
  `minih-agent-desktop/remoteHost/bootstrap` joins `list` / `pair` / `remove`. The
  terminal work-panel client, the reverse tool relay, and provider-configuration
  propagation over the SSH channel are not in this slice.
- R4 delivered in PR-2 (`feat/remote-gateway`): `apps/remote-gateway` runs the
  self-hosted Gateway — bind-address validation (gates 22–23), the `--data-dir`
  file store with `0700`/`0600` and atomic renames, the local CA with
  enrollment and revocation, the `wss` + mutual-TLS Host link listener that
  replaces a same-`hostId` link only after identity checks, the `RACP-HTTP` +
  SSE client API with the header and cookie profiles plus Origin, CORS, and
  CSRF controls, the pairing relay, the HTTP-to-logical-connection router with
  one command connection per `(device, host)` and at most four streams per
  device, per-device and per-IP token buckets, the closed-shape audit log, and
  the `serve` / `enroll-code` / `hosts list|revoke` / `devices list|revoke` CLI
  over an owner-only admin socket. `agent-host-cli` gained `enroll` (local key
  pair, CSR, pinned Gateway CA, `gateway-link.json` at `0600`), the opt-in
  `--gateway` outbound link with 1 s–60 s jittered backoff, `remote-pair` over
  the existing admin socket, and `RacpServer.closeConnectionsForSubject` wiring
  for revocation; the loopback listener, `--pair`, and the SSH bootstrap are
  unchanged. `RACP-SHIPPED_BINDINGS` now lists `RACP-HTTP` — the conformance
  test runs the same deterministic commands over `RACP-WS` and through the
  Gateway and compares results, error codes, and session state.
  `scripts/e2e-remote-gateway.mjs` (`pnpm test:e2e:remote-gateway`) covers
  E2E-227 against the packaged Gateway and a packaged `agent-host-cli` with the
  real host-core: enrollment and the outbound link, header and cookie pairing,
  a relayed approval answered once across an SSE resume, a Gateway restart with
  Host reconnect and cursor resume, revocation on either side within five
  seconds, and refusal of a Gateway-issued token on the loopback binding.
  Attachment relay stays deferred (`RacpServer` declares `attachments: false`),
  so E2E-227 step 5 does not run in R4.
- R5 delivered in PR-3 and PR-3b (`feat/desktop-gateway-link`): Electron Main
  serves its existing Agent Host over one outbound Host link, created only when
  the device-local `remoteGateway` setting is on and an enrollment exists — a
  disabled desktop writes no credential file, builds no `RacpServer`, and opens
  no socket, and the desktop never listens. `racp-gateway-link-port.ts` injects
  PR-2's `enrollHostLink` / `startHostLink`, translating `HostLinkError.code`
  into the `errorCode` the IPC layer reports so the settings page can name a
  wrong CA, a spent code, or a revoked desktop instead of a generic failure.
  Revoking a device through the settings page or `session/revoke` closes that
  device's open logical connections immediately. `scripts/e2e-desktop-gateway-link.mjs`
  (`pnpm test:e2e:desktop-gateway-link`) covers E2E-265 against the packaged
  Gateway: the off state registers nothing and opens no listener, enrollment
  and the link, pairing with viewer/controller/approver roles, a relayed
  approval answered once with the local card closed, refusal of
  `allow-session`, session configuration, workspace reads, and terminals,
  revocation on either side within five seconds, the switch closing and
  restoring the link, `dispose()` leaving no timer or socket, and logs free of
  credentials.

- R7 package C delivered (2026-10-18, D666 / ADR
  `remote-control-router-account-binding`): the Gateway account directory —
  trusted-proxy client address resolution, the Router AccessKey verifier,
  enroll-by-key with the account binding in the issued certificate, account
  login and account host list with a hashed, bounded session credential,
  per-IP credential rate limits, and cross-account isolation tests against a
  stubbed Router. Protocol §11.5, security §3.8, and the Gateway README carry
  the routes, error codes, session shape, certificate binding, and client-IP
  rule this package settles. Still missing: the `device.request` /
  `device.grant` frames and the capability advertisement (package D), the
  Electron main auto-enrollment and Host-link wiring, the confirm dialog, and
  strict mode (package E2), the client login and host switcher (package F), and
  the deployment beside the Router (D-1). The `E2E-REMOTE-ACCOUNT-*` scenarios stay Draft: only their
  cross-account isolation steps 1–4 and 6 are covered so far, by the Gateway's
  own integration tests.

- R7 package E1 delivered (2026-10-18, D666 / ADR
  `remote-control-router-account-binding`): the host-core half of package E. The
  bootstrap answer's optional `remote_gateway { hostlink_url, public_origin,
  ca_pem }` object is parsed leniently — both wire spellings, and a malformed
  object never fails the mesh, which keeps its network identity and reports
  account mode as unavailable with a reason. The Host-link target is derived from
  the advertised endpoint, using the answer's `gatewayVirtualIpv4` when the
  endpoint names a domain instead of an IP, and No-TUN mode installs a second
  loopback forward to it on a port that never collides with the Router forward;
  TUN mode installs none. `EasyTierStatus.remoteGateway` reports `available`, the
  advertised endpoint and CA, the dial address, the certificate service name,
  the forward port, and why account mode is unavailable. provider-config §3
  carries the field rules, the destination and port rules, and the status shape.

- R7 package E2 delivered (2026-10-18, D666 / ADR
  `remote-control-router-account-binding`): the desktop side of account mode.
  Settings ▸ Remote gateway reads `EasyTierStatus.remoteGateway` and enrolls with
  the account AccessKey when the Router advertises a usable endpoint and the
  user's remote-control switch is on — the key is read through host-core from the
  saved `minih-router` row, used for that one request, and never reaches a
  renderer payload, a log, or the credential file. The desktop now dials the
  Gateway through the No-TUN forward under the advertised service name
  (`tlsServerName`, security §5.1) instead of the loopback address. The
  registration identity is the advertised endpoint — `hostlinkUrl`, its CA and
  that name — so a forward port host-core re-allocates on the next overlay start
  neither re-enrolls the desktop nor strands the link: the address is resolved
  per connection and per reconnect, and the certificate already held keeps
  working even after the Router key is gone (ADR decision 8). Its confirmation
  dialog asks the user in the desktop window — label, client, remaining time,
  focus on Deny, Escape denies, `expiresAt` closes it — and a renderer that
  reports it is going away refuses what was waiting at once, while a request no
  window can show waits out `expiresAt` and is refused then. Strict mode is a
  device-local switch, off by default, that takes effect by rebuilding the link
  so the capability list stops announcing `device.accept-sibling-grant`. Every
  mint, adoption, and revocation shows a notice (ADR decision 6), and a
  revocation from the settings page travels as the signed frame, queued while the
  link is down. The route through `device.request` is covered by a main-process
  test suite, an Electron-rendered page and dialog test, and the existing
  remote-host and remote-gateway E2E suites. Still missing: the client login and
  host switcher (package F), push on top of accounts (package G), and the
  deployment beside the Router (D-1). The `E2E-REMOTE-ACCOUNT-*` scenarios
  advance to Partial: their cross-account isolation and confirm-once steps now
  run against a real desktop Host, while routing through a live Router remains
  the deployment gate.

- R7 package D delivered (2026-10-18, D666 / ADR
  `remote-control-router-account-binding`): the account-mode device relay. New
  Host-link frames `host.capabilities`, `device.request`, `device.grant`, and
  `device.revoke`; capability advertisement on every link; Host-signed device
  grants that a sibling Host verifies against the pinned Gateway CA and the
  signer's `OU=account:` binding, with the raw token confined to the approving
  Host to Gateway leg; one token for every Host of the account; the
  account-scoped client routes `POST /v1/account/devices` and
  `GET /v1/account/devices/{requestId}`; Gateway fan-out to advertising Hosts
  only, with the Hosts that cannot confirm reported to the client up front;
  durable deferred grants for Hosts that were offline, re-delivered idempotently
  when the Host announces its capabilities on a new link; a revocation
  propagated to the account's other Hosts by a signed frame, queued on the Host
  while its link is down and re-offered when it returns; account-scoped,
  session-scoped request records whose token is handed over once inside a short
  pickup window; `agent-host-cli` device confirmation over its admin socket
  (`devices pending` / `approve` / `deny` / `revoke`) behind `--confirm-devices`
  and `--strict-devices`, plus enrollment by AccessKey, which the CLI reads from
  a 0600 file, stdin, or the environment and never from argv. Protocol §11.4
  and §11.5, security §3.8 with gates 32–33, the Gateway README, and the `agent-host-cli` README carry the
  shapes, rules, routes, and error codes this package settles, and
  `E2E-REMOTE-ACCOUNT-confirm-once-roams-all-hosts` has a task-candidate E2E
  (`pnpm test:e2e:remote-account-device`). Still missing: the Electron main
  auto-enrollment and Host-link wiring, the desktop confirm dialog, strict-mode
  UI, and i18n (package E2), the client login and host switcher (package F), and
  the deployment beside the Router (D-1). The desktop Host declares no device capability yet,
  so account-mode confirmation is `agent-host-cli`-only for now, and the
  `E2E-REMOTE-ACCOUNT-*` scenarios stay Draft because their desktop and webview
  steps need packages E2 and F.

## 8. Amendment history

D374 (2026-09-10) replaced the Electron facade milestone with the headless
Agent Host module, added the Host queue and `permissions.pending` changes,
made `RACP-WS` the only normative v1 binding with a browser profile and a
reserved gRPC binding, added the Host link relay and identity-source
decision, and made tenant isolation tests conditional on a multi-tenant
harness.

D375 (2026-09-10) re-sequenced the milestones around recorded demand: R2 is
the SSH-tunnel remote Host with the desktop as client, R3 is the outbound
messaging integration, and the Gateway, browser, and gRPC milestones are
unscheduled. It added the `agent-host-cli` bundle, the desktop adapter rule, and
E2E-231 / E2E-232 as the acceptance targets. Its design-gate answers,
recorded the same day, put the reverse tool relay and the terminal in R2 as
one milestone, download `agent-host-cli` from GitHub Releases, persist the turn
queue in host-core, default the remote approval lifetime to 30 minutes, make
the paired-device exemption a Host policy, and fix the Gateway identity
source to the PI account service.

D385 (2026-09-10) withdrew the identity-source clause: remote control is
user-local by construction, and any Gateway is self-hosted and admits clients
with Host-issued device credentials.

D665 (2026-10-17, ADR 0331) scheduled the Gateway and browser milestones as
R4–R6 after the maintainer asked to follow and steer turns from a phone
against both the always-on `agent-host-cli` machine and a running desktop. It
names `apps/remote-gateway` and `apps/remote-web`; the `credential` field on
`client.open` with Host-side re-authentication on the Host link; the
device-origin rules that keep gateway-paired principals under the remote
permission ceiling and off the owner role; the Gateway storage, pairing, and
enrollment design; the desktop's off-by-default connected-Host setting; and
the Capacitor mobile packaging with optional redacted push. The gRPC binding
remains reserved and unscheduled.

D666 (2026-10-18, ADR `remote-control-router-account-binding`) adds R7 to this
rollout as the account mode on top of R4–R6: the schedule order in §1, work
packages A–G plus the deployment next to the Router, the exit criteria that
bind the five `E2E-REMOTE-ACCOUNT-*` scenarios and security gates 29–33, the
per-Router enablement in §5, the R7 admission line in §6, and the rule that the
self-hosted flow of R4 and R5 is unchanged and remains the fallback whenever the
Router answers no `remoteGateway` object. The gRPC binding remains reserved and
unscheduled.
