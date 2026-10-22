# ADR 0331: Self-hosted Gateway, connected desktop Host, and mobile client

- Status: Accepted for implementation (post-MVP)
- Amended by: [Router-account binding for remote control](remote-control-router-account-binding.md) (D666), including its amendment 3 (D675), which excepts a *proven* desktop-class device from the gateway-origin restrictions below
- Date: 2026-10-17
- Decision: D665
- Related: ADR 0205 (D373 / D374 / D375), ADR 0285 (D448), ADR 0286 (D449),
  ADR 0292 (D453), D385,
  `02-architecture/05-remote-agent-control.md` §5.3, §5.4,
  `03-runtime/19-remote-agent-control-protocol.md` §11.2, §11.4,
  `05-security/02-remote-control-security.md` §3.1, §3.2, §3.3, §3.7, §8,
  `06-delivery/07-remote-control-rollout.md` R4–R6

## Context

D375 shipped remote control in the order of recorded demand: the desktop as
the client of a headless `agent-host-cli` over an SSH tunnel (R2), then an
outbound messaging integration (R3). The self-hosted Gateway, the Host link
relay, and the browser profile stayed fully specified but unscheduled because
no recorded request asked for a browser or phone client.

That request now exists: the maintainer needs to follow running turns, answer
approvals and input requests, and start, stop, or interrupt turns from a
phone, against both an always-on `agent-host-cli` machine and the sessions of a
running desktop. The machines involved sit on a user-operated overlay network
(EasyTier in the first deployment) with one publicly reachable node.

Three existing constraints shape the answer:

- the desktop opens no network listener (security §7) and Rust host-core
  stays stdio-only;
- remote control is user-local by construction: no project-operated service,
  and every client credential is issued by the user's own Host (D385);
- a browser cannot join an overlay network, cannot set headers on
  `WebSocket` / `EventSource`, and cannot reach a loopback-bound Host.

Alternatives considered:

1. **Phone joins the overlay network and talks to each Host directly.** No
   Gateway, but no browser client, no push, a VPN profile on every phone,
   and every Host would need a non-loopback TLS listener and certificate.
2. **A stateful relay server in the style of Agents Anywhere** (database,
   cache, a server-side transcript copy). Works everywhere, but makes a
   second source of truth for transcripts and contradicts the Host-owned
   state model of ADR 0205.
3. **Desktop opens an inbound listener on the overlay address.** Smallest
   change, but breaks the no-listener rule and still leaves the browser
   unsolved.
4. **Three native clients (Swift, Kotlin, web).** Best platform fidelity,
   but triples UI and contract maintenance for a single-maintainer feature.

## Decision

1. **Schedule the Gateway and browser milestones** as R4–R6 of
   `06-delivery/07-remote-control-rollout.md`. Their existing protocol and
   security clauses become binding; the clauses below refine them.
2. **R4 — `apps/remote-gateway`.** A self-hosted Node service the user runs on
   their own infrastructure. It holds no transcript, no provider secret, and
   no durable turn command. It owns only:
   - Host enrollment: a gateway-local certificate authority issues one
     client certificate per Host in exchange for a single-use, short-lived
     enrollment code; certificates can be revoked;
   - the Host link listener (`racp-hostlink.v1`, WSS with mutual TLS). It
     binds only to a configured private or overlay address and refuses to
     start on a public or wildcard address;
   - the client API: `RACP-HTTP` with SSE (protocol §11.2). It binds loopback
     behind a TLS-terminating reverse proxy, or binds elsewhere only with TLS
     configured; the cookie profile serves browsers and the header profile
     serves native clients;
   - routing, rate limits, an append-only redacted audit log, and a cache of
     device-token hashes with expiry and revocation for pre-routing checks.
3. **Pairing stays Host-issued.** A Host prints or displays a single-use
   remote pairing code out of band. The client submits it to the Gateway; the
   Gateway relays it over the Host link; the Host exchanges it for a device
   token exactly as in the pairing clause below and returns it to the client.
   The Gateway stores only the token hash. On every relayed connection the
   route context names the Host-issued device id, and the Host re-checks that
   device against its own credential store, so revocation on either side
   denies access.
4. **`agent-host-cli` connects out.** New opt-in flags enroll the Host and
   keep one outbound Host link with bounded exponential backoff. The existing
   loopback `RACP-WS` listener and SSH bootstrap are unchanged. Losing the
   link closes the relayed logical connections with a resumable cursor; local
   turns continue.
5. **R5 — the desktop as a connected Host.** Electron Main may serve its
   existing in-process Agent Host (the `agent-host-bridge.ts` module) over an
   outbound Host link. This is an opt-in Experimental setting, off by
   default, and it opens no listener. Relayed principals are never SSH-paired
   owners: the remote permission ceiling (security §4.3) always applies to
   them, and they cannot raise a local session's permission mode (see
   Amendment 4, which supersedes that last clause). Disabling
   the setting closes the link immediately; app quit and window reload clean
   it up.
6. **R6 — one client codebase.** `apps/remote-web` is a React + TypeScript
   client that uses a Node-free `@minih-agent/racp/browser` entry and the
   shared typebox contracts. It ships as a mobile web app and is packaged
   with Capacitor for iOS and Android. Native builds keep the device token in
   the iOS Keychain or the Android Keystore; the browser build relies on the
   Gateway's `HttpOnly` cookie and never stores the token in script-readable
   storage. Because a packaged webview is a cross-origin caller, its origin has
   to join the Gateway's allowlist: `capacitor://localhost` for iOS (the only
   origin a WKWebView page can have) and `https://localhost` for Android. The
   cost is one explicit `--allowed-origin` per platform per deployment, and the
   benefit is that the CSP stays a fixed list instead of `connect-src *`; the
   native client still presents a bearer token, and the cookie profile gains
   nothing because a cross-site `localhost` page never receives a
   `SameSite=Strict` cookie.
7. **Push is optional and redacted.** When the operator configures APNs or
   FCM credentials on the Gateway, it may send notifications carrying ids and
   a fixed summary kind (`approval.requested`, `input.requested`,
   `turn.completed`, `turn.failed`). It never sends prompt, tool, or
   transcript content. Without credentials, push is off.
8. **The overlay network is a deployment choice, not a dependency.** The
   Gateway and Hosts speak TLS end to end, so the protocol does not rely on
   the overlay's encryption. Placing the Host link listener on the overlay
   only removes it from the public internet.

### Device origin (gateway-paired principals)

Device records gain an optional `origin` field with values `"ssh"` or
`"gateway"`. Records persisted before this decision have no `origin` and are
read as `"ssh"`, so old credential stores need no migration. Every
authentication input also carries the connection origin: the existing loopback
`RACP-WS` binding is `"ssh"`, and a Host link logical connection is
`"gateway"`.

- `connection/pair` keeps its current behavior for an `"ssh"` connection:
  it grants `["owner"]` and records `origin: "ssh"`. On a `"gateway"`
  connection it grants `["viewer", "controller", "approver"]` and records
  `origin: "gateway"`. The Host decides these roles; roles sent by the client
  are ignored.
- Device-token authentication sets `pairedDevice` to
  `device.origin !== "gateway"`. A gateway-paired device is therefore never
  an SSH-paired owner: the remote permission ceiling always applies to it,
  and it cannot obtain an `allow-session` grant.
- A gateway-origin token is accepted only on the Host link; an ssh-origin
  token is accepted only on the loopback `RACP-WS` binding. Either token
  presented on the other channel is rejected, so a stolen gateway token
  cannot reach the Host through an SSH tunnel to escalate, and an SSH-paired
  owner token cannot be replayed through the Gateway. Pairing tokens carry
  the same origin as the devices they mint: a code issued by `--pair` is
  redeemable only on the loopback binding, and a code issued by
  `remote-pair` or the desktop settings page only over the Host link.
- For gateway-origin principals these restrictions hold regardless of Host
  policy and are locked by tests: `allowRemoteSessionGrants: true` never
  makes `allow-session` available to them, they never carry
  `approverOverride`, and the remote permission ceiling applies no matter how
  `applyCeilingToPairedDevices` is configured.

**Amendment 3 of ADR `remote-control-router-account-binding` (D675) excepts one
case.** A `desktop`-class device admitted with a proof the target Host verifies
itself — a signature by the private key of a Host certificate the Gateway
issued to a computer of the same account — holds `owner` and is exempt from the
remote permission ceiling. Everything else in this section is unchanged, and
the rule is now: a gateway-origin principal *without a verified proof* is never
a paired device, never an owner, and always under the ceiling. The tests locked
for that rule keep their meaning for every unproven gateway device. `owner`
follows the applicant's certificate: when that Host certificate is revoked, the
desktop-class devices it admitted lose their `owner` standing with it, because
the proof can no longer be reproduced or re-verified.

**Amendment 4 (2026-10-21): a relayed principal may change a session's
persistent permission mode.** Decision 5 and the device-origin clause said a
relayed principal "cannot raise a local session's permission mode". The code
never had that check: `session/configure` carries `controller` in the
operation catalog, `packages/host-runtime`'s `configureSession` forwards
`permissionMode` as an ordinary patch, and the phone's session sheet has been
able to choose `ask` / `accept-edits` / `auto` since the mobile client shipped.
The rule as written was therefore not a protection the system provided but one
it appeared to promise; keeping the text would misstate the boundary the code
actually enforces. The maintainer's decision is to keep the behavior and fix
the documents, so:

- A relayed principal — a phone, a browser, or a desktop-class device — may
  change a session's **persistent** permission mode through `session/configure`,
  exactly as it may change the session's mode or model. Nothing else moves:
  `owner` is still never granted to an unproven gateway principal, and the
  operations that restructure the machine stay out of reach (§3.7 of the
  security spec).
- The remote permission ceiling still binds every turn the phone itself
  starts. The Host computes `effectivePermissionMode` per turn from the
  session's persistent mode and the principal's standing, a gateway-origin
  principal never carries `approverOverride`, and the ceiling applies no matter
  how `applyCeilingToPairedDevices` is configured. A phone that raises the
  persistent mode does not raise what its own turns may do.
- The accepted risk is that the changed persistent mode **does** govern turns
  started at that computer (an SSH-paired owner, above the ceiling) and turns
  started by a desktop-class device of the same account. This is accepted
  because the phone belongs to the same user's approved devices: the person
  who can already start conversations, register folders, and rename sessions
  on that machine is the same account holder, and the ceiling still mediates
  every remote-initiated turn regardless of the persistent value.
- Mitigations: any device of the account can revoke the device that made the
  change, and a revocation closes its relayed connections within 5 seconds
  (§3.7). The change is **reported**: a remote `session/configure` emits the
  `session.configured` device notice with the device id and the changed fields
  as `field: newValue` pairs — names and new values only, never a prompt or
  transcript — on the same notice channel the settings page renders, and the
  Host log line carries the device id (originally recorded here as a gap, now
  closed).

### Credential forwarding on the Host link

The `client.open` frame gains a `credential` field carrying the client's raw
bearer token (a device token or a pairing token). The Host validates every
relayed logical connection with its own `DeviceTokenAuthenticator` using that
credential and the connection origin `"gateway"`; the Gateway's cached token
hash is only a pre-routing fast reject and a rate-limit key. The Host remains
the final authentication authority for every relayed connection.

In the self-hosted, user-local Gateway scenario the integrity of the route
context is guaranteed by the authenticated Host link itself: only an enrolled
Gateway holding the matching client certificate can send these frames, so the
Host does not verify a second signature on `routeContext`. The context still
carries `hostId`, `clientConnectionId`, `issuedAt`, and `expiresAt`, and the
Host rejects a frame whose `hostId` is not its own, whose context has
expired, or whose `clientConnectionId` is already in use on the same link.
The `credential` field appears in `client.open` frames only and never in
logs, audit records, or error payloads.

### Pairing through the Gateway

1. The Host generates a one-time pairing code locally — `agent-host-cli
   remote-pair`, or the desktop settings page — by reusing the existing
   `issuePairingToken` with a 10-minute validity. The code is displayed only
   on the Host machine (stdout or UI) and never travels through the Gateway.
2. The client calls `POST /v1/hosts/{hostId}/pair` with
   `Authorization: Bearer <pairingToken>` and a body of
   `{ deviceLabel, client: "web" | "ios" | "android" }`.
3. The Gateway opens a logical connection to that `hostId` with the pairing
   token as the `credential`, then performs `connection/initialize` followed
   by `connection/pair` on it.
4. The Host issues a device token with `origin: "gateway"` and the roles of
   the device-origin clause.
5. The Gateway records `{ deviceId, hostId, sha256(token), label, createdAt }`
   and delivers the token:
   - browser: `Set-Cookie` with the token itself, `HttpOnly; Secure;
     SameSite=Strict; Path=/v1`, plus a CSRF token; or
   - native app: `{ deviceId, token }` in the response body, stored in the
     iOS Keychain or the Android Keystore.

The browser cookie holds the device token itself; the Gateway persists only
its SHA-256 hash, never the plaintext.

### Gateway storage

Storage lives under a `--data-dir` with directory mode `0700`, file mode
`0600`, and atomic writes through rename. No SQLite and no native dependency
is introduced.

| File | Content |
|---|---|
| `ca/` | Gateway CA private key and certificate, and the Gateway's own server certificate |
| `hosts.json` | `hostId`, certificate fingerprint, enrollment and revocation times |
| `enrollments.json` | Enrollment-code hashes, expiry, and used state |
| `devices.json` | `deviceId`, `hostId`, token hash, label, revocation time |
| `audit/YYYY-MM-DD.jsonl` | Time, operation, `deviceId` / `hostId`, result, client IP; no tokens and no content |

### Host enrollment

An administrator runs `remote-gateway enroll-code --label <name>` on the
Gateway, which prints a one-time enrollment code valid for 15 minutes. The
Host generates its key pair locally and sends the CSR and the code to a
dedicated enrollment endpoint on the Host link port:

- the enrollment endpoint authenticates the Gateway by server TLS only and
  requires no client certificate;
- the Host pins the Gateway identity with the `--gateway-ca` certificate and
  refuses to connect on a fingerprint mismatch;
- the Gateway issues the Host certificate with a one-year validity and the
  `hostId` as CN; the Host then uses it for the mutual-TLS Host link.

Certificate generation uses Node's built-in `crypto`
(`generateKeyPairSync`, `X509Certificate`). If the built-in API proves
insufficient for issuance, a pure-JavaScript library (for example
`@peculiar/x509` or `node-forge`) may be added to the new app only, with the
reason recorded in the delivery report.

## Consequences

### Positive

- A phone or a browser reaches every enrolled Host without a VPN, and no
  Host or desktop exposes an inbound port.
- The Host stays the only source of truth; the Gateway can be wiped and
  re-enrolled without losing session data.
- One client codebase reuses the typebox contracts, the conformance fixture,
  and the i18n catalog.
- Gateway-paired devices are structurally weaker than SSH-paired owners, so
  a Gateway compromise cannot escalate to owner authority.

### Negative

- The Gateway is a new public surface that the user must operate, patch, and
  monitor.
- The desktop gains a code path that accepts remote control of local
  sessions; it must stay off by default and fully covered by the existing
  ceiling and approval rules.
- Capacitor builds trade some native UX for shared code; push requires the
  operator's own Apple and Firebase accounts.
- Device records gain an `origin` field; old records read as `"ssh"`, which
  preserves behavior but adds a branch to every authentication path.

## Compatibility

No behavior changes for users who do not enable the new settings or run a
Gateway. The `RACP-WS` contract, the SSH-tunnel topology, the local MCP control
plane, and persisted data are unchanged. New contract types are additive and
join the existing conformance fixture. The `origin` field is additive and
backward-compatible: credential stores written before this decision read as
`"ssh"` with unchanged behavior.
