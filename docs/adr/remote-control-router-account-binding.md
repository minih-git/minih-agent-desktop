# ADR: Router-account binding for remote control

- Status: Accepted for implementation (post-MVP; D666); amends ADR 0331
- Date: 2026-10-18
- Decision: D666
- Related: ADR 0331 (D665),
  [Router-account hosted configuration backup](router-account-configuration-backup.md)
  (D661), `02-architecture/05-remote-agent-control.md` §5.3 and §6,
  `03-runtime/19-remote-agent-control-protocol.md` §11.5,
  `05-security/02-remote-control-security.md` §3.8 and gates 29–33,
  `03-runtime/12-provider-config-schema.md` §3 (Minih Router preset),
  `06-delivery/07-remote-control-rollout.md` R7

## Context

ADR 0331 shipped remote control as a user-local capability: a user-operated
Gateway (`apps/remote-gateway`), an outbound `racp-hostlink.v1` Host link over
WSS with mutual TLS, `RACP-HTTP` + SSE for clients, and `apps/remote-web` as the
H5 and Capacitor client. Its trust model is deliberately narrow: the Gateway
stores only token hashes and never decides an approval, and the Host
re-authenticates every relayed logical connection with the client's own
credential (ADR 0331, "Credential forwarding on the Host link").

That model reaches one Host at a time, and the operating cost is real:

- every Host needs a one-time enrollment code printed on the Gateway, plus a
  hand-pasted Gateway URL and CA PEM
  (`apps/desktop/electron/main/remote/gateway-link/gateway-link-service.ts`
  L321-335: `enroll()` requires a Gateway URL, a CA PEM, and a registration
  code);
- every phone pairs separately per Host with an
  `mpt1:<hostId>:<pairingToken>` ticket, so a user with three machines pairs
  three times and switches Hosts by remembering which ticket belongs where;
- a device trusted on one machine has no standing on the next.

The maintainer's Minih-Router deployment already answers the identity question
for the same user, on the same overlay network. Facts this decision stands on,
checked against the code on 2026-10-18:

- **The Router key is already an account identity.** With
  `Authorization: Bearer <AccessKey>`, `GET /api/auth/session` answers
  `access_key_id`, `key_name`, `status`, `expires_at_ms`, and
  `allowed_peer_cidrs` (`internal/control/auth.go` L47-58; the key-scoped
  control-plane routes are listed at L60-70). There is no user or owner entity
  above a key: one AccessKey is one account, and two keys are two accounts.
- **Key lifecycle keeps the account.** Rotation rewrites `key_hash` in place and
  keeps the id (`internal/control/access_key_rotation.go` L66-73). Status is
  `active` or `disabled` (a check constraint in
  `internal/storage/models/access_key.go`). Delete is a hard delete: the model
  has no soft-delete column (`DeleteAccessKey`, `internal/control/access_keys.go`
  L767-782). Ids are never reused (SQLite `AUTOINCREMENT`; migration
  `internal/storage/migrations/0011_custom_access_keys.go` maintains
  `sqlite_sequence`). Only active keys are indexed for authentication
  (`internal/state/snapshot.go` L370-374), so a disabled or deleted key fails
  `GET /api/auth/session`. A rotated key therefore proves itself to be the same
  account, and a disabled or deleted key proves nothing.
- **The Router decides a caller's address the way a reverse proxy does.** It
  reads the caller IP from the header named by `CLIENT_IP_HEADER` only when the
  TCP peer is inside `TRUSTED_PROXIES` (`internal/platform/config/config.go`
  L141-143; `internal/platform/utils/client_ip.go`,
  `(*ClientIPResolver).resolve`), and then enforces `allowed_peer_cidrs`
  (`internal/control/auth.go` L226-229).
- **The overlay is not an authorization boundary.** `GET /api/easytier/bootstrap`
  is key-scoped, but every key joins ONE shared network
  (`internal/easytier/manager.go` `Bootstrap`, L206-252). A key receives its own
  credential (`minih-ak-%08x`) with a limited lifetime (default 86 400 s,
  `internal/easytier/types.go` L15). In the classic shared-secret mode every
  caller receives the same network secret instead (`manager.go` L231-245), and
  the desktop then joins with it (`crates/host-core/src/easytier_net/bootstrap.rs`
  L211-217). Every Router user's terminals share the mesh, so reaching a port on
  it proves nothing; mutual TLS plus an AccessKey-verified enrollment are what
  authorize a Host.
- **The desktop already joins that mesh from the key.** Rust host-core embeds an
  EasyTier node that joins `minih-router` from the AccessKey bootstrap and, in
  the default No-TUN mode, installs exactly ONE loopback forward, derived from
  `routerLanUrl` (`crates/host-core/src/easytier_net/config.rs` L430-470;
  defaults L63-65, `11.12.0.0/24` for the `minih` brand). Reaching a Host-link
  listener elsewhere on the mesh needs a second forward or TUN mode.
- **The precedent exists.** ADR `router-account-configuration-backup` (D661)
  already treats the AccessKey as the account identity, resolves it as "the
  first enabled `minih-router` provider row with a token", and keeps that row
  device-local and never synced.

Two further facts constrain the answer:

- a phone cannot join the overlay: an iOS client would need a NetworkExtension
  VPN entitlement, and ADR 0331 already rejected "phone joins the overlay";
- the Gateway takes the client IP from the TCP peer
  (`apps/remote-gateway/src/client-http.ts` L118-120,
  `request.socket.remoteAddress`), so behind a TLS-terminating reverse proxy
  every caller looks like `127.0.0.1` and the per-IP rate limit degrades to a
  global one. Account mode needs the real address for its own limits and for
  the key's peer policy.

## Decision

Account mode is **additive**. It binds the Router key to Hosts and devices; the
self-hosted enrollment-code and per-Host-ticket flow of ADR 0331 stays for every
user without a Router key.

1. **The goal.** One Minih-Router token binds all of the user's terminals
   automatically, and a phone switches between them without re-pairing.
2. **Network split.** Hosts reach the Gateway over the Router's EasyTier mesh;
   phones reach it over public HTTPS. Phones never join the overlay.
3. **Placement.** The Gateway runs on the Router's machine as a SEPARATE
   process under the same brand, sharing the domain, the TLS termination, and
   the overlay node, without touching the Router's single-instance
   smooth-upgrade release flow. It is not merged into the Router: different
   stack, RACP is Desktop-specific, and remote command approval must not share a
   process with billing and AccessKey handling.
4. **Account identity.** The account is the Router `access_key_id`, resolved on
   the desktop by the D661 rule. The Gateway verifies a key by calling Router
   `GET /api/auth/session` over loopback, forwarding the original caller
   address in the Router's configured client-IP header; the Gateway's loopback
   peer must therefore be a Router trusted proxy, so that `allowed_peer_cidrs`
   applies to the real caller. The Gateway never persists the raw AccessKey.
5. **Host enrollment by key.** Router's bootstrap answer gains an optional
   additive `remoteGateway { hostlinkUrl, publicOrigin, caPem }` object. The
   desktop enrolls with `Bearer <AccessKey>` and a CSR; the Gateway verifies the
   key with the Router and records the Host under that account; the Host
   certificate binds `hostId` to the account. An absent field or `404` means
   account mode is unavailable (old Router) and the self-hosted flow applies.
6. **AccessKey trust is discovery and enrollment only.** A phone logs in with
   the key, sees only that account's Hosts, and requests a device. Every online
   Host of the account is asked "Approve \<device\>?"; the FIRST approval on any
   Host signs a device grant with that Host's key, and sibling Hosts of the same
   account accept the signed grant (signer enrolled in the same account under
   the Gateway CA, device not revoked). The phone then holds ONE revocable
   device token that works on all of the account's Hosts and drops the
   AccessKey. Hosts that are offline at grant time receive pending grants when
   their link comes up. The Gateway relays requests and signed grants; it never
   decides an approval.
7. **Roles are unchanged.** Account-mode devices are gateway-origin principals:
   `viewer` / `controller` / `approver`, `pairedDevice: false`, the remote
   permission ceiling always applies, and `allow-session` is never offered.
8. **Key lifecycle.** Rotation keeps the account (same id). A disabled or
   deleted key blocks new logins and new enrollments. Key state revokes nothing
   by itself: already approved device tokens and already issued Host
   certificates stay valid until revoked through the existing revoke paths.
   Link continuity is a separate, network-level bound: when the mesh issues
   per-key credentials, a Host whose key is disabled or deleted cannot refresh
   its bootstrap and keeps its Host link only until that credential expires.
9. **Strict mode.** A desktop setting "require confirmation on every terminal"
   makes that Host refuse sibling grants, so it always asks its own user.
10. **Client IP.** The Gateway gains an explicit trusted-proxy setting and reads
    the client address from a configured header only from trusted peers. This
    is what makes per-IP rate limits and decision 4 meaningful behind Nginx.
11. **Brand order.** The `minih` line first (`11.12.0.0/24` mesh); the
    `hungraim` line (`11.123.0.0/24`, its own mesh) follows later by explicit
    commit range per the dual-brand rule.

### Accepted risk

"Confirm once, use everywhere" moves trust into the account directory. The
Gateway CA plus Router key verification now vouch that a sibling Host belongs
to the account, so a compromised Gateway CA could enroll a forged Host into an
account and use it to sign a grant that the account's other Hosts accept,
obtaining a device on all of them. This is the unavoidable cost of the
decision, and it is accepted with mitigations that are all required:

- grants are signed by a Host key, never by the Gateway;
- the device ceiling and role set are unchanged;
- any Host of the account can revoke the device;
- every Host shows a "new device" notice;
- every grant produces an audit record;
- strict mode makes one Host refuse sibling grants entirely.

## Consequences

### Positive

- One token binds every terminal, and one approval binds a phone to all of the
  account's machines; the user stops carrying per-Host tickets.
- The enrollment code and the hand-pasted URL and CA disappear for Router users;
  the Host discovers its Gateway from the bootstrap it already fetches.
- The device token is still Host-issued, still revocable, and still weaker than
  an SSH-paired owner: the ceiling, the role set, and the `allow-session`
  prohibition are unchanged (security §3.7).
- The Gateway keeps its minimal role: it verifies keys with the Router, routes,
  rate-limits, audits, and relays signed grants. It still holds no transcript,
  no provider secret, and no approval decision.

### Negative

- A new trust dependency on the account directory (see the accepted risk).
- The Gateway becomes a multi-account surface on a machine that also runs
  billing and AccessKey handling. It is a separate process for that reason, but
  it is a second thing to patch and monitor on the same host. Running it beside
  the Router also amends the user-local, single-tenant reading of security §1,
  §3.1, and §8 for that deployment: choosing account mode trusts that operator
  to route the account's traffic and relay its grant requests, and accepts that
  the operator can deny service. Grants stay Host-signed, so the operator gains
  no approval authority.
- Hosts of one account are mutually reachable on a shared mesh; isolation is
  enforced by the Gateway and by Host-side grant verification, never by
  reachability.
- Disabling a key does not cut off its devices, and it cannot guarantee that the
  key's Hosts stay linked: with per-key mesh credentials the links end when the
  credentials expire, while with the classic shared secret they continue. Users
  must revoke devices explicitly; a disabled key is not a kill switch.
- A new Host-link frame family, a new client login route, an account directory,
  a trusted-proxy setting, a second local forward on the desktop, and a
  confirmation dialog in the desktop UI are all new code and new failure modes.
- A user with several keys has several accounts and sees one at a time; the
  phone does not merge accounts.

### Operational

- The Gateway is a separate process with its own release, its own
  `--data-dir`, and its own service unit; the Router's smooth-upgrade flow must
  not cover it.
- Deploying account mode requires the Router to list the Gateway's loopback
  peer in `TRUSTED_PROXIES` and to set `CLIENT_IP_HEADER` to the header the
  Gateway sends; without both, the Router evaluates `allowed_peer_cidrs`
  against `127.0.0.1`.
- The Host-link listener on the mesh address must be allowed explicitly with
  `--hostlink-allow-cidr`, because `11.12.0.0/24` is neither RFC1918 nor
  `100.64.0.0/10` (`apps/remote-gateway/src/config.ts` L108-146).
- The H5 client needs a domain or path prefix. That and the two settings above
  are deployment decisions, not protocol decisions.
- The Gateway's account directory (Host-to-account bindings, signed grants) is
  durable state that must be backed up and can be rebuilt by re-enrolling.

## Compatibility

- **Self-hosted mode is unchanged.** Enrollment codes, the `mpt1` ticket,
  per-Host pairing, `client.open` with a `credential`, and the D665 security
  gates 22–28 keep working with no migration. Account mode is selected by the
  Router answering a `remoteGateway` object.
- **The bootstrap field is additive.** `remoteGateway` is optional in the
  existing `GET <root>/api/easytier/bootstrap` answer; a Router that does not
  ship it (or answers `404`) is a supported configuration, not a failure, and
  the desktop keeps the self-hosted flow. The object follows the existing
  bootstrap cache rules of the provider-config spec and is never cached longer.
- **New Host-link frame types are ignored by today's peers**, but only because
  of how the two sides handle an unknown `type`, and the difference matters:
  - the Host side (`HostLinkHost.handleFrame`, `packages/racp/src/hostlink.ts`
    L103-172) closes the whole link only for a frame that is not a
    `racp-hostlink.v1` frame, for `host.message` / `host.close` (a protocol
    violation on the Host side), and for `attachment.chunk`; its `switch` has no
    default branch, so an unknown `type` such as `device.request` falls through
    and is ignored;
  - the Gateway mux (`HostLinkGatewayMux.handleFrame`,
    `packages/racp/src/hostlink.ts` L519-548) drops malformed JSON and any frame
    whose `link` is not `racp-hostlink.v1` without closing the link, and acts
    only on `host.message` and `host.close`.
- **That silence is a trap, not a feature.** An old Host would silently drop
  `device.request` / `device.grant` while the phone waited forever. The Gateway
  MUST therefore send those frames only to Hosts that advertise support, and
  MUST tell the phone which Hosts of the account cannot confirm. No capability
  advertisement exists on the Host link today: the frame union of protocol
  §11.4 has seven frame shapes (eight `type` values) and no hello or
  capabilities frame. The advertisement is defined by the implementing PR;
  until a Host advertises it, the phone is told that Host cannot confirm and
  the user falls back to the per-Host ticket.
- **Existing gateway-origin restrictions still bind.** Account-mode devices are
  gateway-origin principals, so gates 25 and 28, the `pairedDevice: false`
  rule, the ceiling, and the cross-channel token rejection apply unchanged.

## Alternatives rejected

1. **Phone joins the overlay and talks to each Host directly.** No Gateway at
   all, but iOS needs a NetworkExtension VPN entitlement, a browser can never
   join, and ADR 0331 already rejected the shape.
2. **Treat the AccessKey as full trust with no confirmation.** Cheapest, but a
   key alone would then approve a new device on every machine; the point of the
   confirmation is that a human on an already-trusted terminal sees the new
   device.
3. **Merge the Gateway into the Router binary.** One process, one release, one
   data directory — and remote command approval would share a process with
   billing, AccessKey verification, and the single-instance smooth-upgrade flow.
   RACP is also Desktop-specific.
4. **Always require per-Host confirmation.** The safe default, kept as the
   opt-in strict mode, but as the only mode it defeats the "switch terminals on
   my phone" goal.
5. **Gateway-signed device grants.** Simpler than sibling verification, but it
   makes the Gateway the approver, contradicting ADR 0331's rule that the
   Gateway never decides an approval. A Host signature also names the approving
   Host in every audit record; a Gateway signature would leave no Host-side
   record of which terminal a human approved on.

## Amendment 1 — a phone may start the work, not just steer it (2026-10-19)

Status: accepted. Scope: this decision's account-mode device surface.

### Context

On-device acceptance of account mode showed the phone could follow and steer
turns but could not begin one: `session/create` was refused by the desktop Host,
and both project operations it needs were `owner`-only, a role no account or
gateway device ever receives. The user's decision, verbatim: "完全放开（含注册
项目、浏览文件夹）".

### Decision

A device holding `controller` may now do the three things a person at the
computer does to start work on it:

1. `session/create` — unchanged (`controller`).
2. `project/register` — role lowered from `owner` to `controller`.
3. `project/browse` — role lowered from `owner` to `controller`.

Nothing else in the role table moved. `owner` is still never granted to a
gateway or account device, so `workspace/toolExecute`, `workspace/toolShell`,
`workspace/files`, `session/delete`, `session/archive`, `session/revoke`, and
`tools/advertise` remain out of reach. The two project operations are also
confined to the Host's browse root (the user's home directory): the path is
canonicalized with `realpath` and anything outside the root — including `..` and
a symlink pointing out — is refused, while a missing directory is reported as
missing rather than created. The desktop Host implements all three over the same
shared `host-runtime` catalogs as the headless Host, and reports each
state-changing call — device, session id or path — on the existing device-notice
channel and the Host log.

Two HTTP routes were added for the project operations (`POST /v1/projects`,
`GET /v1/projects:browse?path=…`), derived from the same shared route table the
Gateway uses to build its host-scoped forwarding.

### Rejected alternatives

- **Grant gateway devices `owner`.** One word in a role list, but it would also
  hand the phone the workspace tool surface, shell access, and session deletion.
  The user asked for three operations, not for a remote shell, and the remote
  permission ceiling was never designed to arbitrate those.
- **Leave the desktop Host refusing `session/create`.** The phone could then
  start work only on an always-on headless Host and not on the computer it was
  looking at, which is the case the acceptance run exercised.
- **Let the phone pass an absolute path outside the root.** Registration would
  become an arbitrary-directory grant; the root check is what keeps this
  amendment from widening into filesystem access.

### Consequences

- Security §3.7 carries the role change, the root rule, and the rejected
  alternative; protocol §6 and §11.2 carry the role and route tables.
- The change is additive for clients and Hosts that do not use it. A Gateway
  without these routes keeps answering `NOT_FOUND`, and a Host that refuses the
  operations keeps answering `FORBIDDEN`, which the phone shows as itself.
- The desktop application must ship a release containing the Host change before
  a phone can use the three operations against a desktop; a headless
  `agent-host-cli` Host gets them from the same shared implementation.
- **The headless Host's registration is now bounded too.** `project/register`
  used to canonicalize a path without any root check; `project/browse` was the
  only bounded operation. Sharing one implementation makes both bounded by
  `--browse-root` (the user's home directory by default) **for every caller,
  including the local owner over the loopback binding**. This is a published
  behavior change: a script that registered a directory outside the home
  directory must now pass a `--browse-root` that contains it. It is recorded in
  `apps/agent-host-cli/README.md` and in `docs/project/unreleased.md`.

## Amendment 2 — the phone may choose what a session runs on (2026-10-21)

Status: accepted. Scope: this decision's device surface, and the RACP operation
catalog it is validated against.

### Context

Amendment 1 let a phone start work, but not choose what that work runs on:
`session/create` accepts `providerId`, `modelId`, and `thinkingLevel`, and no
operation let a client learn the valid values. A session could therefore only
start on whatever the computer happened to default to, and a phone could not
even name the model of a session it was watching. R7-1 of
`docs/spec/04-ux/13-remote-mobile-client.md` §15.10 records the owner's
decision, verbatim: the phone may choose a model when starting a session **and**
change an existing session's model, the latter only while idle.

### Decision

One new read operation, `model/list`, role `viewer`, `GET /v1/models`:

- It returns `RacpModelSummary[]`: `providerId`, `providerLabel`, `modelId`,
  `label`, `thinkingLevels`, an optional `defaultThinkingLevel`,
  `supportsImages`, and `isDefault`. **Metadata only** — no credential, API key,
  base URL, proxy, header, or price. The projection lives in one place
  (`packages/host-runtime/src/host-catalog-reads.ts`), so a field that must not
  cross the boundary has one function to be removed from rather than two.
- `RacpSession` gains optional `providerId`, `modelId`, `modelLabel`, and
  `thinkingLevel`. Optional and additive: a Host that sends none still produces
  a valid session, and a client hides the row.
- Changing an existing session's model stays `session/configure` with
  `providerId` + `modelId` (+ `thinkingLevel`), `controller` role. The Host
  refuses it while a turn is running (`AGENT_BUSY`), the same rule the desktop
  applies; the phone shows that reason instead of a control that would be
  rejected.
- Both Hosts implement the catalog — the desktop Host link and
  `agent-host-cli` — over the same shared read. The Gateway needed no new code
  because it validates against `RACP_OPERATIONS` and the shared route table, and
  a test now proves `GET /v1/models` is forwarded like every other declared
  route.

Why `viewer` rather than `controller`: a read-only device already sees which
model a session runs on, and a model list is not a capability. Choosing one
still requires `controller`, because it creates work.

### Rejected alternatives

- **Return the raw `providers.list` rows.** They carry `baseUrl`, `headers`, and
  `hasSecret`, i.e. exactly the machine's provider configuration. A projection is
  the point, not an optimization.
- **A phone-side model list.** It would drift from the Host's own catalog within
  one provider release and offer models the Host cannot launch.
- **Let the client pass a model key without a provider id.** Two providers can
  advertise the same model id, and the Host resolves a launch by the pair.

### Consequences

A Host older than this amendment answers `CAPABILITY_UNAVAILABLE`, which the
client treats as "no choice available" and creates the session on the Host's
default: no version negotiation is needed and no client upgrade is required
first.

## Amendment 3 — a sibling desktop joins as itself (2026-10-21)

Status: accepted for implementation. Scope: this decision's account-mode device
surface, the Host link frames of protocol §11.4/§11.5, and the desktop's
account-mode defaults. Nothing here is implemented yet: this amendment records
the target design, and rollout R8 delivers it.

### Context

Account mode binds the user's phone to every Host of the account, but the
user's *computers* still reach each other only over SSH: the desktop as a
Remote Client supports `transport: "direct" | "ssh"`
(`packages/shared/src/types/remote-host.ts`), so using a second computer means
entering a host, a user, a key or password, and installing `agent-host-cli`
there. Even when that works, a computer paired this way is a phone-grade
device: `desktop-host-operations.ts` refuses session rename/delete/configure,
workspace reads, and terminals to a remote device, and
`packages/racp/src/operations.ts` never grants `owner` to a gateway origin, so
the full desktop experience is unreachable from another computer.

The same account already answers "is this computer mine?" — the sibling Host
certificate proves it. This amendment lets a computer say so, and join.

### Decision

1. **A `desktop` device class.** `device.request` gains
   `client: "desktop"` beside `web` / `ios` / `android`
   (`packages/shared/src/racp-hostlink.ts`,
   `racp-account-devices.ts`). The class names a computer of the account that
   is asking to reach its siblings, not a phone.
2. **Proof, not just a key.** A desktop request carries `hostProof`: the
   applicant's `hostId` plus a signature over the request id and a nonce, made
   with the private key of the Host certificate the Gateway itself issued to
   that computer. The Gateway verifies the certificate chains to its own CA
   and carries `OU=account:<accountId>` for the account of the presented
   AccessKey, and verifies the signature before it treats the request as a
   desktop request at all. An AccessKey alone proves an account, never a
   computer.
3. **Automatic admission, per computer, on by default.** A desktop request
   with valid proof is granted without a human answer, provided the target
   computer has "allow same-account computers to join automatically" on
   (default on, stored device-locally beside the remote-control switch). With
   the switch off, the same request falls back to the ordinary per-device
   confirmation of decision 6, and the user answers it.
4. **`owner`, with the ceiling exemption.** A desktop-class device holds the
   same role set an SSH-paired desktop device holds: `owner`, exempt from the
   remote permission ceiling, because the proof is a certificate the account's
   own Gateway issued to that machine. A phone or browser device is unchanged:
   `viewer` / `controller` / `approver`, `pairedDevice: false`, always under
   the ceiling, never offered `allow-session`. Which operations a desktop-class
   device may actually call is rollout R8 package C, not this amendment: the
   desktop Host must open them explicitly and keep refusing them to a phone.
5. **Account mode defaults the remote switch on.** When the Router advertises
   a `remoteGateway` object and the account key resolves, the desktop's
   remote-control switch starts on for a user who has never chosen; a user who
   turned it off keeps it off. This amends security §3.8 and gate 27, whose
   "off by default" reading was written for the self-hosted flow.
6. **A capability, so an old Host is visible.** The new frames go only to a
   Host that advertises `device.desktop-auto` on its `host.capabilities` frame
   (protocol §11.4 rule 6). A computer running an older build never receives
   them, and the requesting desktop shows "this computer needs an update"
   instead of waiting for a frame that will never come — the silent-drop trap
   the Compatibility section below already names.
7. **The Agent runs on the computer that owns the project.** Selecting a
   project of computer B runs the turn on B, with B's own provider
   configuration and B's own Router account for model calls; A is a remote
   view. Credentials never cross machines. This is not a change of model for
   SSH hosts: an SSH-paired host keeps the existing "local Agent, remote
   workspace tools" shape of ADR `local-agent-remote-workspace-tools`, which
   stays for users who prefer it and for Hosts that cannot enroll.
8. **The client transport.** A desktop reaches a sibling through the Gateway
   over `RACP-WS` (`GET /v1/hosts/{hostId}/ws`), not `RACP-HTTP` + SSE: the
   desktop already speaks `RacpClient` and `wsClientTransport`, and one
   long-lived connection carries commands, events, and server requests without
   a request per command. `RemoteHostTransport` gains `"account"` and the
   record's `url` names that route. The phone keeps `RACP-HTTP` + SSE
   unchanged.

### Rejected alternatives

- **Keep per-computer manual confirmation for desktops.** It is the safe
  default and it stays as the switch-off behavior, but as the only behavior it
  makes "my computers just work together" a setup ritual, which is the
  complaint this amendment answers.
- **Trust an AccessKey alone, for every client class.** One key would then
  auto-approve a new device on every machine, including a phone that only
  holds a key. The proof is what keeps automatic admission scoped to a
  computer the account has already enrolled.
- **Give every gateway device `owner`.** It would hand a phone the workspace
  tool surface, shell access, and session deletion, which the remote
  permission ceiling was never designed to mediate (amendment 1's rejected
  alternative, unchanged).
- **Have the desktop client reuse `RACP-HTTP` + SSE.** Every command would be
  a new HTTP request through a reverse proxy, so each one pays the proxy hop
  and a fresh round trip (the P0 measurement measures the two segments on a
  local loopback, where they are 0–1 ms of Gateway queue and 3–18 ms of host
  round trip, and cannot measure the proxy or the Gateway host's own RTT), and
  server-initiated approvals would need a second channel. A WebSocket route is
  one connection and the protocol the desktop already implements.
- **Require SSH between computers forever.** It is the only path today, but it
  needs credentials and an install on the other machine and it deliberately
  withholds the desktop surface; it stays as an option, not as the answer.

### Accepted risk

Automatic admission widens what a leaked AccessKey can reach: a key alone
cannot join as a desktop (the proof needs an already-enrolled Host
certificate), but an attacker who also holds a computer's Host certificate
private key could admit that computer to its own account's siblings. That is
the same key that machine uses to serve its own Host link, so the compromise is
already the machine's, not the account's. Required mitigations, all of them:

- admission requires a Gateway-CA certificate with the account binding and a
  signature over the request, never a bare key;
- every automatic admission produces a "new device" notice on every computer of
  the account and an audit record, so a silent join is not possible;
- the per-computer switch turns automatic admission off, after which the
  ordinary confirmation is required;
- any computer of the account can revoke the device, and the revocation reaches
  the others as the signed frame of §11.5;
- `owner` follows the proof, and a device without proof is still a phone-grade
  `viewer` / `controller` / `approver` under the ceiling.

### Consequences

- A new client class, a new capability string, a new device-proof payload, a
  per-computer switch, and a WebSocket client route are all new code and new
  failure modes (rollout R8).
- The remote-control switch default changes for account-mode users. A user who
  never touched the switch starts with a link; a user who turned it off is not
  re-enabled.
- Security §3.7 gains the desktop-class role rule and §3.8 the default, and
  gate 27 is restated for the two cases.
- A computer that predates this amendment is reported as needing an update
  rather than silently unreachable.
- SSH-paired hosts keep their behavior; the two shapes coexist, and the
  desktop shows which one a host uses.
