# Remote Agent Control Security Specification

- Status: Target specification; post-MVP
- Decision: D373 / ADR 0205, amended by D374 and D375
- Applies to: RACP-WS over the SSH tunnel and any later binding: RACP-HTTP,
  the reserved RACP-GRPC, and the Host link
- Does not weaken: local MCP, host-core, plugin, or provider-secret boundaries

## 1. Security goals

Remote control MUST provide:

1. authenticated user and device identity;
2. authorization scoped to tenant, Host, project, Session, operation, and role;
3. confidentiality and integrity in transit;
4. no direct network access to Rust host-core;
5. host-owned permission and workspace enforcement;
6. revocation and auditability;
7. bounded resource use and safe disconnect behavior;
8. no replay of a completed or previously admitted mutation; and
9. a remote permission ceiling, so a remote controller cannot turn a session
   into unattended execution.

The security design assumes that an Agent can be prompt-injected. A prompt,
tool result, attachment, or model output is untrusted data and MUST NOT grant
an authority that the authenticated principal does not already have.

## 2. Trust zones

```text
┌──────────────────────┐       HTTPS/WSS        ┌─────────────────────┐
│ Remote Client        │ ──────────────────────▶ │ Remote Gateway      │
│ browser/native/CLI   │                         │ identity + routing  │
└──────────────────────┘                         └──────────┬──────────┘
                                                           │ outbound mTLS
                                                           │ Host link
                                                           ▼
                                               ┌─────────────────────────┐
                                               │ Agent Host               │
                                               │ session + policy owner   │
                                               ├──────────┬──────────────┤
                                               │ pi       │ Rust host    │
                                               │ sidecar  │ core         │
                                               └──────────┴──────────────┘
```

| Zone | Trust assumption | Required boundary |
|---|---|---|
| Remote Client | Authenticated but UI and prompt data are untrusted | Scoped session or bearer credential; no secret authority by default |
| Gateway | User-hosted relay, routable and exposed | Authn, authz, rate limits, audit, transient buffers only, no raw host RPC |
| Agent Host | Trusted local authority beside the workspace | mTLS/device identity, signed route context, host policy, remote permission ceiling |
| Node sidecar | Agent runtime, not policy owner | Main/Host proxy allowlist |
| Rust host-core | Workspace, storage, tool, permission, and secret authority | stdio only; no public listener |

## 3. Identity and enrollment

### 3.1 Client to Gateway

The production Gateway MUST validate an established identity before routing.
D385 makes remote control user-local by construction. No project-operated
identity or account service is in the path: the only credential a client ever
holds is a device token issued by the user's own Host at pairing (§3.4). A
Gateway, if a user runs one, is self-hosted on the user's infrastructure and
admits clients with those same Host-issued device credentials; it validates
the token's Host id, expiry, and revocation state before routing. OIDC
federation and the pi-backend account service are out of scope for remote
control, and refresh tokens do not exist in this model.

Because a browser cannot set request headers on the `WebSocket` and
`EventSource` APIs, the Gateway offers two authentication profiles:

- **Header profile** for non-browser clients: the access token is sent in the
  `Authorization` header of every request and of the WebSocket upgrade.
- **Cookie profile** for browser clients: after device pairing the self-hosted Gateway or the Host issues an
- **Cookie profile** for browser clients: after device pairing the self-hosted
  Gateway or the Host issues an `HttpOnly`, `Secure`, `SameSite=Strict` session
  cookie scoped to the paired Host with a finite `Max-Age` (400 days at most),
  so the pairing survives a browser restart; the WebSocket upgrade and the SSE
  request are authorized by that cookie plus the Origin rule of §5.2, and every
  mutation carries a CSRF token issued with the session. A browser client MAY
  instead stream events through `fetch` with the header profile.

In both profiles access tokens MUST NOT be placed in query strings, WebSocket
URLs, SSE URLs, attachment names, or event payloads. Bearer-only APIs still
validate Origin for browser requests.

The Gateway and the cookie profile ship with the Gateway and browser
milestones (R4–R6, D665). The first remote topology uses the header profile
with a device token obtained through the SSH bootstrap pairing in §3.4.

For the first trusted-device prototype, a one-time pairing code MAY bootstrap
the identity link. It MUST be short-lived, single-use, displayed out of band,
and exchanged over TLS. A pairing code MUST NOT become a long-lived API token.

**Native client storage (PR-5).** An iOS or Android build of the client keeps
the device token only in platform secure storage, never in webview storage:

- iOS: a Keychain item with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  (or stricter) and iCloud Keychain sync off, so the token never migrates to
  another device through a backup or sync.
- Android: a Keystore-backed store (the key lives in the AndroidKeyStore), with
  `android:allowBackup="false"` and no data-extraction rule that would copy the
  wrapped ciphertext, so a restore onto another device cannot yield a usable
  token.
- The app writes the token to secure storage before it records the Host, and
  deletes an orphan item (secure storage survives an app reinstall while
  webview storage does not) at startup.
- The header profile is used for every request: the native client sends no
  ambient cookie, and pairing for `client: "ios"` / `"android"` returns the
  token in the response body with no `Set-Cookie`.

### 3.2 Agent Host to Gateway

The Agent Host MUST open the production connection outbound. The Host link
uses mutual TLS with a per-host identity certificate or an equivalent signed
device credential.

- Enrollment credentials are one-time and expire after the enrollment window.
- Host credentials are scoped to one tenant and Host identity.
- The Gateway rejects a certificate or device credential after revocation.
- Credentials rotate without exposing provider secrets to the Gateway.
- The Host rejects a Gateway connection whose server identity is not pinned to
  the configured product trust roots.
- The Host never accepts an unauthenticated inbound control socket.
- The Host link authenticates the Gateway only. User authority on a relayed
  connection comes solely from the per-connection route context in §3.3.

Direct LAN or development connections still use TLS and an expiring device
token. Plain `ws://`, plain HTTP, and static shared tokens in URLs are not
supported.

Enrollment is a one-time exchange (D665, ADR 0331): an administrator prints a
15-minute single-use enrollment code on the Gateway, the Host generates its
key pair locally and sends the CSR and the code to a dedicated enrollment
endpoint on the Host link port that authenticates by server TLS only, the
Host pins the Gateway identity with `--gateway-ca` and refuses a fingerprint
mismatch, and the Gateway issues a one-year client certificate with the
`hostId` as CN. The Host link ships with R4.

### 3.3 Host capability context

After the Gateway authenticates a user, it issues a short-lived signed route
context for each logical client connection:

```ts
type HostRouteContext = {
  tenantId: string
  hostId: string
  subject: string
  clientConnectionId: string
  sessionScopes: string[]
  roles: string[]
  issuedAt: string
  expiresAt: string
  tokenId: string
}
```

The Agent Host verifies the signature, audience, Host id, expiry, and session
scope before executing any mutation. The Gateway's transport connection is not
itself authorization for a session, and a route context for one
`clientConnectionId` cannot be replayed on another.

In the self-hosted, user-local Gateway scenario (D665, ADR 0331) the
integrity of the route context is guaranteed by the authenticated Host link:
only an enrolled Gateway holding the matching client certificate can send
Host link frames, so the Host does not verify a second signature on the
context. The Host still validates that `hostId` equals its own id, that the
context has not expired, and that the same `clientConnectionId` is not reused
on one link. The final authentication authority remains the Host's own
credential store: every relayed logical connection is re-authenticated with
the `credential` of the `client.open` frame (§3.7), and the Gateway's cached
token hash is only a pre-routing fast reject and a rate-limit key. The
`credential` never appears in logs or audit records.

### 3.4 SSH bootstrap pairing (first remote topology)

The desktop bootstraps a `agent-host-cli` on a remote machine over the user's own
SSH session (`02-architecture/05-remote-agent-control.md` §5.2). The trust
argument is that an SSH login already proves shell access to that machine;
pairing only binds a desktop device to the Host it started.

- The pairing token is generated by the Host at start, is single-use, expires
  within the bootstrap window, and travels only over the SSH channel; it is
  never written to a world-readable file or a URL.
- The desktop exchanges it once, over the forwarded loopback port, for a
  device token that it stores in its secure storage; the Host records the
  device as `owner` of that Host.
- The Host binds loopback only and accepts a device token only from a
  loopback peer; a non-loopback bind requires TLS and the same device token.
- Resolve the same-version published target and trusted release SHA-256 over
  HTTPS. Prefer remote download; only `download-failed` permits one bounded
  Desktop download, local verification and SSH upload of the same artifact.
  Authentication, integrity and version failures MUST NOT authorize fallback.
  Remote verification precedes extraction/install on either path. This limited
  executable-upload exception amends the original prohibition under
  [ADR 0326](../../adr/0326-verified-ssh-host-installation.md); it does not permit
  arbitrary executable uploads or bypass SSH host-key checks. SHA-256 is relative
  to the trusted release, not an independent signature-verification scheme.
- New bundles include native Node >=22 and `SHA256SUMS`. Stage privately, reject
  unsafe manifest entries and special files, verify installed files, and switch
  content-addressed `current` atomically under deployment/install locks. Reuse
  requires an external receipt matching version, archive digest and manifest
  digest plus read-only file verification; version equality alone is insufficient.
  System Node and remote GitHub access are not required for new bundles, but
  supported Linux ABI, POSIX/hash/archive tools and Linux `flock` still are.
- Daily readiness MUST NOT reinstall, re-pair or reset credentials — unless the
  running Host cannot serve this desktop release at all, which triggers the
  version realignment below. Validate loopback readiness/version and saved Host
  ID before forwarding, then validate the RACP identity. A legacy descriptor
  without Host ID remains readable.
- One version realignment per desktop release per host MAY re-run that same
  verified bootstrap from the stored SSH descriptor and the encrypted login
  password ([ADR 0327](../../adr/0327-remote-host-version-realignment.md)). The
  secret is read only from the encrypted record, is never returned to the
  renderer and never logged, a password host whose stored secret is gone is never
  replayed, a failed attempt waits out a cooldown before the next automatic try,
  and an explicit user reconnect may retry immediately. The artifact trust path
  is unchanged: same release, same published SHA-256, same remote verification.
- Revoking the device token on the Host, or removing the Host from the
  desktop, ends the pairing; a new pairing needs a new SSH bootstrap.
- Provider configuration is copied only after explicit selection and consent,
  over SSH stdin as Host-local configuration; it never crosses RACP.

**SSH credential handling (ADR 0293).** The desktop MAY hold the SSH login
password for a host the user paired that way, under these rules:

- The password is supplied by the user in Settings, is passed to the system
  `ssh` client through OpenSSH's askpass helper, and is never an `ssh`
  argument, an environment variable value, or part of a URL.
- Credential material exists on disk only inside a `0700` directory as a `0600`
  file, only while an `ssh` child can still prompt for it, and is removed on
  every path including a failed forward and `dispose`.
- It is persisted at rest only through the same OS-keychain encryption the
  device token uses, and a password that cannot be decrypted costs the secret
  rather than the paired host.
- The renderer never receives it: `RemoteHostSummary` and
  `RemoteHostSshMetadata` carry no secret field.
- A password containing a line break cannot survive the askpass round trip and
  is rejected before any remote command runs. Windows OpenSSH cannot execute
  the helper and is refused with a remedy instead.
- Password mode is exclusive: `PubkeyAuthentication=no` and
  `NumberOfPasswordPrompts=1`. Default identities are not tried, because an
  encrypted local key would consume the single askpass answer as a passphrase.
  A user with both a key and a password picks key mode.

### 3.5 Explicit provider import for the experimental MVP

- Only SSH-managed hosts offer copy. The renderer sends provider IDs and an
  explicit default-model choice, never credentials. Selection and consent start
  empty; changing selection invalidates consent.
- Main and Host validate the versioned payload, at most 32 providers and 1 MiB.
  OAuth, plugin-owned, CLI/local providers, local-only endpoint URLs, and reserved
  credential headers are excluded. Only selected eligible secrets are read.
- `agent-host-cli provider-import` reads stdin and connects to the running Host's private
  `agent-host-cli/admin.sock` (0600 inside owner-only 0700 directories). It never opens
  SQLite or starts a second host-core. An ownership lock also guards stale-socket
  recovery; connections, response sizes, import concurrency, and deadlines are bounded.
- The socket exposes one operation, not arbitrary host-core RPC. Import failures
  return sanitized codes; payloads, credentials and remote stderr are not logged or
  echoed. Model/header overrides, including zero values, retain their meaning.
- Import is additive: identical copies reuse the created ID, changed input creates
  a new row, and remotely modified/deleted rows are not overwritten. A private
  bounded receipt journal stores digests, not raw settings or keys. Uncertain
  creation returns `import_incomplete` on retry instead of risking a duplicate.
- Provider state remains owned by Rust host-core and uses existing provider and
  secret storage. No database schema or RACP credential surface is added.

### 3.6 Local-Agent remote workspace tools

For locally owned remote projects, all provider configuration and model requests
remain on Desktop. Provider import is a legacy remote-Agent operation and is not
used by this project workflow. The owner-only workspace tool service accepts no
provider or credential fields and has no provider, project or session mutation
endpoint. Local host-core first applies its existing permissions and admission;
Main then sends the admitted tool request to the selected paired Host. The Host
canonicalizes the root and reuses its pure tool runner with external paths denied.
A disconnected or unsupported Host cannot redirect execution onto Desktop.

Device/session namespace isolation prevents cross-device cancellation and tool
identity collisions. Connection disposal aborts active calls; invalid or late
responses remain errors. There is no automatic mutation retry or reconnect replay.
Remote paths never reach local attachment hydration, local instruction filesystem
resolution or mutation realpath probes. Trusted extensions still register local
model providers. Their implicit workspace `pi.exec` is rejected for a remote root;
local provider helpers must explicitly supply a local working directory.

Root repository instructions are returned by owner-only `workspace/files`
`operation: "instructions"`, bounded to 32 KiB of UTF-8 file content plus an
explicit truncation notice. Selection is root-only in recognized-name precedence,
and a symlink escaping the root is skipped. Desktop validates the response and
merges it after local global defaults; remote HOME defaults and nested directory
traversal are excluded. Instruction text is untrusted repository data, not a grant
of tool, filesystem or credential authority.

Loss of a Write/Edit/Bash transport reply yields the Desktop-side
`REMOTE_MUTATION_OUTCOME_UNKNOWN` error with `retriable: false`, not an automatic
retry or a rollback claim. Readiness for browse/files does not replay tools.
Remote picker and Settings errors use allowlisted localized categories rather
than raw SSH stderr, tokens, password/private-key paths or forwarded URLs.

### 3.7 Gateway-paired devices

Device records gain an optional `origin` field with values `"ssh"` or
`"gateway"` (D665, ADR 0331). Records persisted before D665 have no `origin`
and read as `"ssh"`, so old credential stores need no migration. Every
authentication input also carries the connection origin: the loopback
`RACP-WS` binding is `"ssh"` and a Host link logical connection is
`"gateway"`.

- `connection/pair` on an `"ssh"` connection keeps its current behavior: it
  grants `["owner"]` and records `origin: "ssh"`. On a `"gateway"`
  connection it grants `["viewer", "controller", "approver"]` and records
  `origin: "gateway"`. The Host decides these roles; roles sent by the
  client are ignored.
- Pairing tokens carry the same origin as the devices they mint (ADR 0331):
  `PairingRecord` gains an optional `origin` field, and a record
  without the field reads as `"ssh"`. A code issued by `--pair` (SSH
  bootstrap) can be redeemed only on the loopback `RACP-WS` binding; a code
  issued by `remote-pair` or the desktop settings page can be redeemed only
  over the Host link. Redeeming a pairing token on the other channel fails,
  so an SSH-bootstrap pairing code cannot be consumed through the Gateway.
- Device-token authentication sets `pairedDevice` to
  `device.origin !== "gateway"`. A gateway-paired device is therefore never
  an SSH-paired owner: it is not exempt from the remote permission ceiling
  (§4.3), and `allow-session` is never offered to it.
- For gateway-origin principals these restrictions hold regardless of Host
  policy and MUST be locked by tests, not left to defaults (ADR 0331):
  `allowRemoteSessionGrants: true` does not make `allow-session`
  available to them; they never carry `approverOverride`; and they stay under
  the remote permission ceiling no matter how `applyCeilingToPairedDevices`
  is configured.
- **D666 amendment (2026-10-19, rollout A2): what a gateway device may change.**
  The maintainer decided a phone signed into the user's own account may do what
  the person at the computer does for three things: start a session
  (`session/create`, already `controller`), register one of this computer's
  folders as a project (`project/register`), and walk the folders to pick one
  (`project/browse`). Those two project operations required `owner` before this
  amendment and now require `controller`; nothing else in the role table moved.
  `owner` is still never granted to a gateway or account device, so the
  operations that restructure or expose the machine — `workspace/toolExecute`,
  `workspace/toolShell`, `workspace/files`, `session/delete`, `session/archive`,
  `session/revoke`, `tools/advertise` — stay out of reach.
  Both operations are confined to one root, the user's home directory: the Host
  canonicalizes the path with `realpath` first, then refuses anything that is not
  inside that root, so `..`, a relative path, and a symlink pointing outside are
  all `REMOTE_PATH_FORBIDDEN`, and a missing path is `REMOTE_PATH_NOT_FOUND`
  rather than being created. A registration answers the picker's own canonical
  path; a browse answer lists only directories, bounded to 500 entries, with the
  parent omitted at the root.
  Every state-changing call reports what happened — which device, and the session
  id or the registered path — on the same notice channel the settings page
  already renders for device mint/adopt/revoke, and into the Host log, so the
  person at the machine learns a phone started a conversation or added a folder.
  **Where a path can end up in a log.** A registration carries its path in the
  request body (`POST /v1/projects`), so it does not appear in a reverse proxy's
  access log; a browse carries it in the query string
  (`GET /v1/projects:browse?path=…`), so the absolute path — including the user
  name in the home directory — does appear there. GET is still the right verb
  (the call reads a directory and changes nothing), and the path is the user's
  own, sent by their own device over the same TLS connection the Gateway already
  terminates; what an operator must know is that the browse path is visible in
  the access log while the registered path is not, so log retention and access
  apply to it.
  Rejected alternative: granting gateway devices `owner`. It is one word in a
  role list, but it would also hand a phone the workspace tool surface, shell
  access, and session deletion, which the user did not ask for and which the
  remote permission ceiling was never designed to mediate.
- A gateway-origin token is accepted only on the Host link; an ssh-origin
  token is accepted only on the loopback `RACP-WS` binding. Either token on
  the other channel is rejected, so a stolen gateway token cannot escalate
  through an SSH tunnel and an SSH-paired owner token cannot be replayed
  through the Gateway.

- **Planned (R8, ADR `remote-control-router-account-binding` amendment 3):
  desktop-class devices are owners.** A device admitted through account mode
  with a proof **the target Host itself verifies** (a `desktop` device request
  carrying the request's nonce, a signature over
  `{requestId, nonce, applicantHostId, accountId, expiresAt}` by the private
  key of a certificate this Gateway issued to a computer of the same account,
  and that certificate itself) is treated like an SSH-paired desktop device: it
  holds `owner` and is exempt from the remote permission ceiling. This is the
  only way a gateway-origin principal may hold `owner`; the proof is the
  condition, not the client class. The proof carries the certificate because
  the target Host has no other way to obtain it — only the Gateway saw it at
  enrollment — and presenting it is the same shape as TLS client
  authentication: what makes it trustworthy is the chain verifying to the CA
  this Host already pins plus the account and `hostId` in the certificate
  matching the request, not the Gateway's honesty. The Gateway does hold that
  CA's private key, so a compromised Gateway can mint a certificate for a
  computer that does not exist; that is the "compromised Gateway CA" risk D666
  records, unchanged, and it is bounded by the same mitigations. The Gateway
  may pre-check and fast-reject, but it is never the authorization — a Host
  must not grant `owner` on a frame whose proof it has not verified itself,
  because the Gateway never decides an approval (ADR 0331). A proof whose nonce
  was already used or whose deadline passed is refused. The device record keeps
  the class it was admitted under and the `applicantHostId` whose proof admitted
  it, both optional and absent on every older record, so a store written before
  this exists reads and behaves exactly as before. `owner` follows the
  applicant's certificate: revoking that Host certificate removes the `owner`
  standing of the devices it admitted. Because only the Gateway observes that
  revocation, it tells the account's other computers (`host.revoked`, only to a
  Host that advertises `device.desktop-auto`, stored and re-offered to one that
  was offline), and each of them revokes the desktop devices whose applicant is
  that computer. That frame needs no Host signature and is safe to trust
  because it only ever removes authority: the worst a forged one achieves is
  revoking a device that would otherwise keep working, never widening access. A
  device without proof keeps the phone rules of this section unchanged, and the
  desktop Host still decides per operation which desktop operations it opens.
  **One request, one device.** Every computer of the account is asked the same
  request with the same proof, so several of them can admit it at once and each
  mints its own token. The Gateway keeps the first grant and the client receives
  only that token, so a computer that also admitted the request revokes the
  device it minted and adopts the surviving grant — the alternative leaves a
  device nobody can use and makes the first approver the one machine where the
  account's token fails. The proof's nonce stays single-use per request, not per
  Host: a proof presented for a request that computer never admitted is still
  refused as a replay.
  **Replay memory is per process.** The nonce table and the own-admission table
  are in-memory: a Host restart forgets the nonces it spent. A proof replayed
  after a restart is still bounded by the request's five-minute lifetime, and
  only a Gateway that can already forge certificates could present one, so this
  does not widen the accepted risk (ADR `remote-control-router-account-binding`,
  Accepted risk); it is stated so the in-memory scope is not mistaken for durable
  replay protection. Both tables are bounded and pruned by their deadlines.
- Revocation on either the Gateway or the Host denies new connections and
  closes existing relayed logical connections within 5 seconds.

### 3.8 Account mode: Router key as discovery and enrollment (D666)

Account mode (ADR `remote-control-router-account-binding`, protocol §11.5) lets a
Minih-Router AccessKey discover and enroll Hosts and bootstrap a device that is
usable on every Host of the account. It is additive: §3.1–§3.7 keep their
meaning, and a user without a Router key uses the self-hosted flow. The Gateway
account directory — key verification, enrollment by key, account login, the
account host list, and the device request / confirm / grant relay — is
implemented (rollout R7 packages C and D), and every clause below is
implemented as written.

- **AccessKey handling.** A client's AccessKey is presented only to the Gateway,
  which verifies it against Router `GET /api/auth/session` over loopback, never
  persists the raw key, and never forwards it to a Host. A Host holds its own
  account key only while it enrolls: `agent-host-cli enroll` presents it once on
  `POST /v1/enroll` and stores only the issued certificate and key, and a
  desktop presents the D661 provider row the same way. The CLI reads the key
  from `--access-key-file <path>` (mode 0600, owned by the caller),
  `--access-key-stdin`, or `MINIH_ROUTER_ACCESS_KEY`, and refuses one typed on
  the command line: argv is world-readable through `ps` and
  `/proc/<pid>/cmdline` and is copied into the shell history, which is the same
  leak as writing the key into a log. A client drops the key after the device
  exchange
  and keeps only the device token. The AccessKey MUST NOT appear in a Host
  device store, a log line, an audit record, a URL, or an error payload. The
  only durable state a login leaves is the SHA-256 hash of the session
  credential the Gateway mints from a verified key, with a bounded lifetime; a
  successful verification is never cached, so every login calls the Router
  again.
- **Client address.** The Gateway learns the caller address from a configured
  header only when the TCP peer is inside its configured trusted-proxy set, and
  otherwise from the peer itself. It forwards that address in the header named
  by the Router's `CLIENT_IP_HEADER`, and its loopback peer must be inside the
  Router's `TRUSTED_PROXIES`, so `allowed_peer_cidrs` binds to the real caller.
  Trusting the header from an untrusted peer would let any caller claim any
  address, so this setting is security-relevant configuration, not a
  convenience flag. The two settings are one: a header name without a trusted
  proxy, or a trusted proxy without a header name, refuses to start, so a
  deployment cannot silently fall back to the proxy's own address. The chain
  rule mirrors the Router's own resolver, so the forwarded value means the same
  thing at both ends: `X-Forwarded-For` is read right-to-left and the caller is
  the first entry outside the trusted-proxy set (or the leftmost entry when
  every entry is trusted), any other header carries exactly one address, and an
  entry that is not an IP address falls back to the peer. The resolved address
  keys the per-IP rate limits and the audit record. Without both settings the
  resolved address is the TCP peer, exactly as it was before account mode.
- **Key lifecycle.** A disabled or deleted key fails verification, so it starts
  no new login or enrollment. Key state revokes nothing by itself: approved
  devices and enrolled Hosts are revoked only through the existing revoke paths
  (§3.7, gate 26). A Host's link may still end when its per-key mesh credential
  expires, because a disabled key can no longer refresh the bootstrap; that is a
  network bound, not a revocation, and a disabled key is not a kill switch.
- **Multi-account deployment.** §1, §3.1, and §8 describe a user-local Gateway
  with one tenant and no project-operated account service in the path.
  Self-hosted deployments keep that reading unchanged. Account mode also allows
  a Gateway run by whoever operates the Router, which then serves many
  accounts, and it puts the Router's account service in the path for discovery
  and enrollment only; device credentials stay Host-issued. Each account is its
  own tenant for routing, listing, device records, grants, audit queries, and
  per-account limits. Choosing account mode trusts that operator to route the
  account's traffic and relay its grant requests, and accepts that the operator
  can deny service. It gives the operator no approval authority, because grants
  stay Host-signed, and §10 still keeps prompts and tool data — which relayed
  messages carry in transit — out of logs, audit records, and durable storage.
- **Trust model change, stated plainly.** The account directory — the Gateway CA
  plus Router key verification — now vouches that a sibling Host belongs to the
  same account. "Confirm once, use everywhere" therefore accepts that a
  compromised Gateway CA could enroll a forged Host into an account and use it
  to sign a grant that the account's other Hosts accept, obtaining a device on
  all of them. Required mitigations: grants are signed by a Host key and never
  by the Gateway; the device role set and the remote permission ceiling are
  unchanged; any Host of the account can revoke, and that revocation reaches the
  others as a signed frame; every Host shows a "new device" notice; every grant
  produces an audit record; and strict mode makes a Host refuse sibling grants.
  **D675 sharpens this for desktop-class devices.** A leaked AccessKey is
  enough to reach `owner` on every computer of the account that has automatic
  admission on: the key can enroll a new Host (decision 5 of the ADR), that
  enrollment returns a Gateway-CA certificate carrying the account binding, and
  the attacker can sign a valid proof with it. This is the accepted cost of
  "same-account computers join automatically, without a confirmation", recorded
  as such in ADR `remote-control-router-account-binding` amendment 3. The
  mitigations that address it: the proof is verified by each target Host and
  never by the Gateway alone; **every new Host enrollment notifies the
  account's other computers and writes an audit record**, so the attacker's
  first step is visible before any device is admitted; the operator can revoke
  the enrolled Host on the Gateway (`hosts revoke`) and any computer can revoke
  the admitted device; the per-computer switch, and strict mode, turn automatic
  admission back into a confirmation; and a proof whose nonce was reused or
  whose deadline passed is refused.
  The raw device token is a separate matter from the CA: it travels only on the
  approving Host to Gateway leg, the Gateway strips it before relaying the grant
  and never logs, audits, or persists it, and the siblings adopt the device by
  the token's hash alone. The token is handed to the client that asked, once,
  with a thirty-second pickup window for a retried HTTP request; after that the
  Gateway drops it, so a token that was never picked up cannot be collected
  later by whoever learns the request id. The request id is not a credential
  either: a read of another account, or of another session of the same account,
  answers the same `NOT_FOUND` an unknown id produces.
- **Cross-account isolation is a hard rule.** Reachability on the shared
  EasyTier mesh is not authorization: every Router user's terminals are on one
  mesh, and in the classic shared-secret mode every caller holds the same
  network secret. No route, Host listing, device record, pending grant, or audit
  query may cross accounts, and a Host accepts a grant only from a signer
  enrolled in its own account under the Gateway CA, for a device that is not
  revoked. The Gateway's per-IP rate limit (ADR decision 10) applies across
  accounts by nature; per-account limits stay independent (§8), and no
  rate-limit response discloses another account's data (§9). Account login and
  enrollment by key share one tight credential bucket keyed on the resolved
  caller address, so a caller cannot spend the command budget guessing a key.
  The error of a cross-account attempt is `HOST_ACCOUNT_MISMATCH` (403) on
  enrollment, where the caller already holds a valid key of another account and
  the Host must learn that its `hostId` is taken; it names no account, so it
  reveals only that the `hostId` is enrolled. Every account-scoped route answers
  the uniform `UNAUTHORIZED` of protocol §13 instead — the same answer a
  nonexistent Host produces — so a listing or a routing attempt never discloses
  another account's Hosts. A `hostId` registered through the self-hosted flow is
  not an account asset either: an AccessKey enrollment may take it over only by
  certifying the key its current certificate certifies, so learning a `hostId`
  never lets a key move another user's Host into its own account.
- **Strict mode.** A Host in strict mode refuses sibling grants and confirms
  every device with its own user; it announces `device.confirm` alone, so the
  Gateway never offers it a grant it would refuse, and the client does not count
  it as one that will accept. It keeps the per-device approval of ADR 0331 for
  an operator who does not want roaming. Because no refresh can ever change that
  answer, a client that holds an account device must tell the user to ask for a
  device again and approve it on that computer — the new grant is signed by that
  Host itself and the account's other Hosts adopt it as usual — instead of
  offering a retry that cannot succeed. The setting is per Host and off by
  default: `--strict-devices` on `agent-host-cli`, and the desktop's own
  "require confirmation on every terminal" switch (package E2), which is stored
  device-locally beside the remote-control switch and takes effect by rebuilding
  the Host link, because the capability list is part of what the Host announces.
- **Desktop Host: the key stays in the main process.** The desktop reads the
  account AccessKey from the saved `minih-router` provider row through host-core,
  uses it for the one enrollment request, and drops it (gate 30). It is not in a
  renderer payload, an IPC event, a status projection, a log line, an audit
  record, or the credential file — that file holds the Host certificate and key,
  which is exactly what the self-hosted flow stores. Nothing is enrolled and
  nothing listens while the user's own remote-control switch is off, and an
  unavailable account-mode advertisement leaves the registration-code flow
  untouched. Reading *whether* account mode could work is not enrolling: the
  status carries that answer — advertised endpoint plus a configured key — so
  the page can offer the switch, and turning it on is the only thing that
  enrolls anything (gate 27 still holds: nothing opens, dials, or listens before
  that).
- **Desktop Host: confirmation is a window, and no window is a refusal.** The
  desktop's confirmer is a modal in its own window: the request, the device
  label, the client, and the requester's deadline; focus starts on Deny, Escape
  denies, and the dialog closes when `expiresAt` passes. Every way of not
  answering denies: a closed window, a reloaded renderer, or a stopped link
  denies at once, and a request no window can show is denied when it expires.
  A denial sends no frame (protocol §11.5), so the client keeps waiting until
  its own deadline unless another Host of the account approves; what tells it
  up front which Hosts can answer at all is the roster (gate 33). Every mint,
  adoption, and revocation produces a notice the settings page lists (ADR
  decision 6 mitigation), and a
  device revoked there travels as the signed revocation frame, queued while the
  link is down, so a lost device stops working on every Host of the account.
- **Redacted push (R5 PR-6).** A push may tell a user that an approval or an
  input request is waiting, or that a turn finished or failed; it may not carry
  prompt, tool, transcript, path, or session-title content (ADR 0331 decision 7).
  The Gateway builds the payload from ids alone — a fixed kind, two localization
  keys, and the ids needed to open the right screen — and the Host frame it comes
  from is schema-closed, so a Host cannot add a field even if a later version
  wanted to. Push is off unless the operator configured a provider: the
  registration route then answers `enabled: false` and stores nothing. Provider
  credentials are files read at startup under the same rules as the Router
  AccessKey (regular file, caller-owned, mode 0600), they are never logged,
  echoed, audited, or written into a data file, and the audit records only the
  event kind, the Host, and the device. A registration is per device and its
  audience is derived from the credential (gate 29), so a §11.4 device is pushed
  about its own Host and an account device only about its own account's Hosts; a
  revoked device has no registration, because revoking it deletes one, and a
  provider that reports *this* token as gone (`410`, `Unregistered`,
  `UNREGISTERED`) deletes it too. Per-Host and per-device
  budgets bound a Host that reports in a loop, so a noisy Host cannot turn into a
  notification storm on someone's phone. Three properties of this path are
  tested rather than assumed: every id in the frame is restricted to
  `[A-Za-z0-9._:-]`, so a Host cannot put text in `sessionId` and have the
  Gateway deliver it; a registration write re-checks the device inside the write,
  so a request in flight when the device was revoked cannot recreate its
  registration; and only a per-token answer deletes anything, because a wrong
  topic or a bare `404` affects every token the Gateway holds. A provider that
  accepts a connection and never answers is ended by a hard deadline, so a wedged
  provider cannot stall the Gateway's other work.
- **Unsupported Hosts.** A Host announces what it supports with
  `host.capabilities` on every link, and the new frames go only to a Host that
  announced the matching capability, because a Host that predates them ignores
  an unknown frame type silently (`packages/racp/src/hostlink.ts`). A client
  MUST be told which Hosts of its account cannot confirm instead of waiting for
  an answer that never arrives; the fallback is the per-Host pairing ticket
  (§3.7, protocol §11.4). The advertisement is a Host's own claim: a Host with no
  confirmer advertises nothing rather than promising an answer no one can give.

- **Desktop-class devices and automatic admission (planned, R8).** A computer of
  the account may join its siblings automatically, without a human answer, but
  only with proof, and only after **the target Host verifies it**: the request
  carries a `desktop` client class, the request's nonce, and a signature over
  `{requestId, nonce, applicantHostId, accountId, expiresAt}` by the private key
  of a Host certificate the Gateway issued to a computer of the same account.
  The Host checks the chain against its own pinned Gateway CA, the certificate's
  account binding, the signature, and the freshness (an unused, unexpired
  nonce); the Gateway's own pre-check is a fast reject, never the authorization.
  Automatic admission is a per-computer switch ("allow same-account computers
  to join automatically", default on, device-local, never synced); with it off,
  or in strict mode, the request falls back to the per-device confirmation above
  and the device is not adopted as desktop-class. A sibling grant for such a
  device is re-verified by every receiving Host together with its own switch.
  Every automatic admission produces the same "new device" notice and audit
  record a confirmed one does, and any Host of the account can revoke it; a new
  Host enrollment notifies the account's other computers and is audited, and the
  operator can revoke the enrolled Host on the Gateway. A computer that has not
  announced `device.desktop-auto` is never sent the new frames and is reported
  to the requesting desktop as needing an update. The desktop's account-mode
  to the requesting desktop as needing an update. The desktop's account-mode
  remote-control switch defaults **on** once the Router advertises a Gateway and
  an account key resolves; a user who turned it off keeps it off, and the
  self-hosted flow still starts off. **A stored decision is a decision**: the
  default applies only when there is no `remoteGateway` object at all, or one
  with no `enabled` field. A record that carries `enabled: false` counts as an
  explicit off even when it predates the `decided` marker, because every build
  that wrote such a row could only write it from the switch's own state — so an
  upgrade never re-enables a switch a user had turned off. This amends gate 27.

## 4. Authorization model

### 4.1 Role matrix

| Operation | Viewer | Controller | Approver | Owner |
|---|---:|---:|---:|---:|
| List/get visible hosts, projects, and sessions | yes | yes | yes | yes |
| Subscribe to session or host events | yes | yes | yes | yes |
| Read session history | yes | yes | yes | yes |
| Create/attach as viewer | yes | yes | yes | yes |
| Start or queue a turn | no | yes | optional | yes |
| Stop, interrupt, or cancel a session turn | no | yes | optional | yes |
| Resolve tool approval (`allow-once`, `deny`) | no | no by default | yes | yes |
| Resolve tool approval with `allow-session` | no | no | policy | yes |
| Resolve Plan/Goal approval with permission mode | no | no by default | explicit policy | yes |
| Answer an input request | no | yes | optional | yes |
| Upload an attachment | no | yes | optional | yes |
| Revoke membership | no | no | no | yes |
| Archive a session | no | no | no | yes |
| Open or use a session terminal | no | policy | policy | yes |
| Advertise relayed tools | no | no | no | yes |

Role checks are necessary but not sufficient. The Host MUST additionally check:

- the Session belongs to the requested tenant and Host;
- the principal is allowed to use the Session's project;
- the operation is legal in the Session state;
- the durable permission/mode policy allows the proposed action;
- the remote permission ceiling has been applied to the turn; and
- the request's expected revision and idempotency key are valid.

### 4.2 No privilege escalation through protocol fields

The following client fields are advisory only or forbidden:

- `permissionMode` cannot upgrade a durable Session policy; the only accepted
  permission-mode field is the explicit selection on a Plan/Goal `approve`,
  and it is validated against `allowedPermissionModes`;
- `admission: "queue"` cannot bypass single-turn execution; it only places a
  bounded, cancelable entry in the Host queue;
- `workspaceRoot` cannot replace a Host-owned project binding;
- `toolName` cannot select a tool outside the Host catalog;
- `confirm` cannot replace an approval request or create an approval result;
- `providerApiKey`, secret values, and secret references cannot be supplied in
  a turn payload; and
- a client cannot claim another `principal`, `agentName`, `connectionId`, or
  `clientConnectionId`.

For legacy remote-Agent sessions, the Host chooses the effective model/provider
configuration from its own session and provider state. Locally owned remote
projects instead execute their model transport on Desktop (§3.6). Neither path
turns RACP into a credential relay.

### 4.3 Remote permission ceiling

A turn started by a remote principal runs under the lower of the Session's
durable permission mode and the Host's configured `remoteMaxPermissionMode`,
ordered `ask` < `accept-edits` < `auto`. The default ceiling is `ask`. The
Host operator may raise it; a principal may exceed it only when the principal
holds `approver` and Host policy allows approvers to use the session's own
mode. The applied value is reported as `effectivePermissionMode` and never
changes the durable session mode.

The ceiling applies to Gateway-routed principals. A desktop device paired
through the SSH bootstrap (§3.4) holds `owner` on that Host and is exempt:
an SSH login already grants shell access to the machine, so a ceiling would
withhold nothing. Its turns report the session's own mode as
`effectivePermissionMode`. The Host policy `applyCeilingToPairedDevices`
(default off) re-applies the ceiling to paired devices for an operator who
wants every remote turn to start at `ask`.

`allow-session` is offered to a remote approver only when Host policy allows
remote session grants; otherwise the request's `allowedDecisions` omit it. A
session grant made remotely is the same by-tool-name grant as a local one
(frozen decision 18) and ends with the Session.

## 5. Network and transport protections

### 5.1 TLS

- Public HTTP, SSE, and WebSocket endpoints MUST use TLS 1.2 or newer; TLS
  1.3 is preferred. A reserved gRPC binding inherits the same rule.
- A `agent-host-cli` bound to loopback and reached through an SSH port forward MAY
  accept plain `ws://` when both the bind address and the peer address are
  loopback and a valid device token is presented; the SSH channel provides
  confidentiality, matching the loopback rule of ADR 0203. Any non-loopback
  bind requires TLS.
- The production Host link MUST use mutual TLS or an equivalent device-bound
  authenticated channel.
- Certificate validation MUST include hostname or service identity validation;
  disabling verification is not a development shortcut supported by the
  product.
- WebSocket upgrade credentials, header or cookie, are validated before
  accepting the connection.

### 5.2 Origin and cross-site controls

- The Gateway maintains an explicit browser Origin allowlist per tenant and
  checks it on every WebSocket upgrade and SSE request from a browser. A
  cookie-authenticated request MUST carry an allowlisted `Origin`, with one
  exception: a browser omits `Origin` on a same-origin `GET`/`HEAD`, which is
  the shape of every H5 read and `fetch`-based event stream, so that request is
  accepted when `Sec-Fetch-Site: same-origin` is present. An `Origin` that is
  present but not allowlisted is always rejected, a mutation is never exempt
  (it also needs the CSRF token), and a missing `Sec-Fetch-Site` keeps the
  mandatory-Origin rule. Revocation stays server-side: a revoked token answers
  `401` regardless of the cookie's remaining lifetime.
- Local-only endpoints bind loopback and validate loopback Origin as required
  by ADR 0203.
- Cookie-profile sessions use `SameSite` protection and a CSRF token on every
  mutation, including mutations sent over an already-open WebSocket.
- A bearer token in a URL is always rejected.
- CORS exposes only the required methods, headers, and response types. The
  allowed request headers are the ones the RACP client actually sends
  (`authorization`, `content-type`, `x-minih-racp-client`, `x-csrf-token`,
  `last-event-id`), taken from one shared list so the two sides cannot drift;
  `x-trace-id` is exposed on both successful and failed responses, because the
  client reports it with errors. Only allowlisted origins get either header, and
  `*` is never used.
- A packaged native client (PR-5) is a cross-origin caller too, so its webview
  origin needs its own allowlist entry: `capacitor://localhost` for an iOS
  build and `https://localhost` for an Android build. Both are the only values
  such a webview can have. Allowing them is safe because the header profile
  still requires the bearer token, while the cookie profile additionally needs
  a `SameSite=Strict` cookie that a cross-site `localhost` page never sends.
  `capacitor://localhost` is the only custom scheme the allowlist accepts;
  a wildcard, a port, or any other custom scheme is refused.

### 5.3 Request binding and replay protection

Every mutation carries a principal-bound idempotency key. The Host stores the
key and result for at least the active turn lifetime and rejects reuse with
different payload bytes. A Gateway retry MUST preserve the key and trace
context.

Requests with an expired route context, stale session revision, or revoked
connection fail before they reach the Agent runtime.

## 6. Workspace, file, and attachment security

1. Legacy remote-Agent requests identify a Session. The owner-only local-Agent
   workspace service identifies an owner-selected root and revalidates it (§3.6).
2. The Host resolves every tool path against that Session's durable project or
   scratch root.
3. Remote clients send attachment bytes or opaque attachment ids, never local
   absolute paths or `file://` URLs.
4. The Host validates declared size, actual size, MIME policy, SHA-256, and
   expiration before a turn can reference an attachment.
5. Attachment storage is private to the owning tenant, Host, and Session.
6. Uploads are not executable and are not automatically added to a tool root.
7. Gateway URL fetches are not accepted as an attachment source, preventing
   SSRF through a remote-control request.
8. Workspace reads and writes continue to use the current host sandbox,
   ignore rules, path checks, and permission policy.
9. Behind a Gateway the upload target is served by the Gateway. The Gateway
   enforces only the size bound, relays the bytes to the Host in bounded
   chunks, deletes its copy when `attachment/complete` succeeds or the upload
   expires, and never inspects, persists, or serves those bytes elsewhere.

## 7. Tool and approval security

Remote control MUST use the existing host-owned tool execution path. It MUST
NOT expose:

- raw `host.proxy` calls;
- raw Rust host-core methods;
- generic Electron IPC invocation;
- provider secret get/set/delete methods;
- arbitrary process spawning; or
- a remote equivalent of a disabled permission mode.

Approval requests contain a bounded, redacted summary. The client submits a
decision for a live request; it does not submit a tool invocation to be
executed after approval. The decision vocabulary is the local one:
`allow-once`, `allow-session`, and `deny` for tools; `approve` with an
explicit permission mode, or `reject`, for Plan and Goal contracts. The Host
verifies request id, Session id, turn id, principal role, expiry, allowed
decision, permission-mode selection, and current state in one operation.

Pending requests are Host state. Rust host-core keeps the pending permission
table; the Agent Host reads it through `permissions.pending`
so a late-attaching client receives open requests. That read is redacted the
same way as the request event and never returns tool arguments beyond the
bounded preview.

Approval lifetime is Host policy. Local desktop permission requests have no
automatic deadline and remain pending until a decision, cancellation, or
shutdown. While a remote subscriber is attached, the remote approval record
defaults to 30 minutes (D375); the operator may shorten or lengthen that
bounded remote lifetime, and a client disconnect never extends it.

An approval response that arrives after disconnect, expiry, abort, crash, or
turn completion is a no-op or a structured stale/expired error. It never
restarts the turn. The first valid decision wins across local and remote
clients; later valid responses receive the stored result.

A remote session's catalog contains the remote Host's tools plus the tools
the paired desktop advertised for relay: its user-configured MCP servers and
plugin tools that do not require the session workspace. A relayed tool
executes on the desktop under the desktop's own plugin permissions and
confirmation rules, never on the Host and never against the remote workspace;
the Host's permission decision precedes the relay request, the Host sends only
the Agent's arguments and never a secret, and a lost relay connection fails
the tool without interrupting the turn. Provider secrets never cross RACP in
either direction; the remote Host's providers are configured over the SSH
bootstrap channel (§3.4).

A session terminal is a shell on the Host machine running as the `agent-host-cli`
user with the session root as its working directory. Only the SSH-paired
owner device or a principal holding the explicit `terminal` scope may open
one; Gateway-routed principals need that scope from policy. Terminal output
is ephemeral and recoverable only from the terminal's bounded replay ring.

## 8. Gateway and tenant isolation

The Gateway ships with R4 (D665). These rules bind from R4 onward.

- Every route is keyed by `(tenantId, hostId, sessionId)`.
- A user-local deployment has exactly one tenant, the Host itself; PI never
  operates a shared Gateway (D385).
- The first deployment is single-tenant. Routes already carry `tenantId` so a
  second tenant is an operational change, not a protocol change; cross-tenant
  isolation tests run once a multi-tenant harness exists.
- Account mode (§3.8, D666, planned) adds a multi-account deployment beside the
  Router: each account is a tenant, and gate 29 is its cross-account isolation
  test. The Gateway's per-IP rate limit is the one limit that accounts share,
  because it keys on the caller address rather than the account (§3.8).
- A client cannot enumerate Host or Session ids outside its signed scope.
- Gateway caches contain opaque ids and routing metadata, not provider secrets.
- A Host reconnect replaces the old connection only after identity and tenant
  match; stale links are closed.
- A tenant's rate limits and event queues are independent of other tenants.
- Logs and metrics carry tenant/host/session identifiers only where the
  retention policy permits; prompt and tool content is excluded by default.

## 9. Abuse controls and resource bounds

The Gateway and Host enforce the lower of their configured limits:

| Resource | Initial target |
|---|---:|
| Control requests per principal | 120/minute |
| Turn starts per Session | 20/minute |
| Queued turns per Session | 8 |
| Concurrent clients per Host | 16 |
| Concurrent subscriptions per connection | 8 |
| Request/event frame | 1 MiB |
| Prompt payload | 256 KiB |
| Attachment | 50 MiB |
| In-flight attachment uploads per principal | 4 |
| Event send queue | 4 MiB or 1,000 durable events |
| Open terminals per Session | 2 |

Rate-limit responses include a retry hint but never disclose another tenant's
quota. Slow clients lose ephemeral events first and are disconnected with a
resumable cursor before a durable event is lost. The Host never blocks the
Agent turn indefinitely on a remote client that stopped reading.

## 10. Audit and observability

Every remote control mutation produces a structured audit record containing:

- `traceId`, `connectionId`, `clientConnectionId`, `principal`, `tenantId`,
  `hostId`;
- Session and turn ids;
- operation and outcome, including the admission mode and
  `effectivePermissionMode` of a started turn;
- authorization decision and role;
- idempotency key hash, not the raw key;
- event epoch and sequence range, when applicable; and
- error code, or approval decision with the selected permission mode.

Audit records MUST NOT contain provider credentials, raw prompt text, raw tool
arguments, raw tool output, attachment bytes, or approval secrets by default.
The runtime logger may record bounded redacted summaries under the existing
redaction policy.

Metrics SHOULD cover connection count, reconnects, authentication failures,
authorization failures, event lag, replay/resync counts, epoch changes, queue
depth, turn admission latency, approval latency, queue drops, and Host
availability.

Trace propagation uses W3C `traceparent` where the selected transport supports
it. A Gateway MUST preserve the trace id across the Host link.

## 11. Revocation and incident response

The Gateway MUST be able to revoke:

- a user session;
- a Host device;
- a client connection;
- a Session membership; and
- a pending attachment or upload target.

Revocation closes active connections, prevents new mutations, cancels queued
turns the revoked principal submitted, and leaves the Agent Host's local turn
policy unchanged. A running turn is interrupted only when the revoked scope or
incident policy explicitly requires it; revocation must not silently replay or
roll back a completed turn.

Provider credential rotation remains an Agent Host operation. Remote clients
cannot use the control protocol to export, test, or replace a secret unless a
separate, explicitly specified credential-management capability is added.

## 12. Security acceptance gates

1. Plain HTTP and `ws://` are rejected outside an explicitly isolated local
   test harness.
2. Rust host-core has no public listener and cannot be addressed by a remote
   client.
3. A viewer cannot start a turn or resolve an approval.
4. A controller cannot select an unauthorized Session, workspace, tool, model,
   permission mode, or provider secret.
5. A prompt-injected tool result cannot change the authenticated principal or
   role.
6. Duplicate mutation keys cannot create duplicate turns or approvals.
7. An expired/revoked credential cannot resume a connection or upload bytes.
8. Cross-tenant Host, Session, event, attachment, and audit access is denied
   once a multi-tenant harness exists.
9. Event replay never crosses a Session or principal scope.
10. Gateway and Host logs contain no provider secrets or unredacted tool data.
11. Slow clients cannot exhaust Host memory or stall an Agent turn.
12. Host crash, Gateway reconnect, and client reconnect do not replay an
    already-admitted execution.
13. A remote-initiated turn never reports an `effectivePermissionMode` above
    the configured ceiling, and `allow-session` is absent unless policy
    allows it.
14. Browser WebSocket and SSE connections succeed only on the cookie profile
    with Origin and CSRF checks, or on the header profile through `fetch`;
    URL tokens fail in both. Applies when the browser milestone is scheduled.
15. A relayed server-initiated approval request is answered exactly once, and
    the answer reaches only the Host that raised it. Applies when the Gateway
    milestone is scheduled.
16. A `agent-host-cli` bound to loopback accepts only loopback peers with a valid
    device token; a non-loopback bind without TLS fails to start.
17. An ssh-origin pairing token is single-use, arrives only over the SSH
    channel, and cannot be exchanged twice or from a non-loopback peer;
    a pairing token of either origin fails when redeemed on the other
    channel (§3.7).
18. A remote session exposes only the remote Host's tool catalog; desktop
    plugin tools and desktop MCP servers never execute against a remote
    workspace, and provider secrets never cross RACP.
19. A relayed tool never executes on the Host and never receives a Host
    secret; the Host's approval precedes the relay request; a lost relay
    connection fails the tool without interrupting the turn.
20. A session terminal opens only for the SSH-paired owner or a principal
    with the `terminal` scope, with its working directory inside the session
    root.
    root.
21. An SSH login password is supplied only by the user, reaches `ssh` only
    through the askpass helper, is stored only encrypted, and never appears in
    a process argument list, the renderer, or a log line.
22. The Host link listener refuses to start on `0.0.0.0`, `::`, or a public
    address; it binds only to a private or overlay address the configuration
    explicitly lists (RFC1918, `100.64.0.0/10`, or a configured CIDR).
    Applies from R4 (D665).
23. The Gateway's client API binds loopback by default; a non-loopback bind
    without configured TLS refuses to start. Applies from R4 (D665).
24. Tokens never appear in URLs, query strings, SSE URLs, or event payloads;
    browser sessions use the `HttpOnly; Secure; SameSite=Strict` cookie with a
    finite `Max-Age` plus a CSRF token on every mutation, and native clients
    use the header profile. A cookie-authenticated request proves its Origin
    per §5.2: only a same-origin `GET`/`HEAD` marked `Sec-Fetch-Site:
    same-origin` may omit it. Applies from R4 (D665).
25. A gateway-paired device is never an SSH-paired owner: it holds
    `pairedDevice: false`, never the `owner` role, stays under the remote
    permission ceiling, is never offered `allow-session`, and its token is
    rejected on the loopback `RACP-WS` binding just as an ssh token is
    rejected on the Host link. Applies from R4 (D665).
26. Revocation on either the Gateway or the Host denies new connections and
    closes existing logical connections within 5 seconds. Applies from R4
    (D665).
27. The desktop attempts no connection and opens no listener while its
    remote-control switch is off, and an explicitly disabled switch is never
    re-enabled by an account-mode default. With account mode available (the
    Router advertises a `remoteGateway` object and an account key resolves) the
    switch starts on for a user who has never chosen, and only then: a stored
    `remoteGateway` object that carries an `enabled` field is a decision, so
    `enabled: false` stays off whether or not the row also carries the
    `decided` marker — a row written by an earlier build counts, which is what
    keeps an upgrade from re-enabling a switch a user had turned off. With the
    switch off, no enrollment, no link, and no listener, proven by regression
    tests including the upgrade rows. Applies from R5 (D665); the account-mode
    default is R8 (ADR `remote-control-router-account-binding` amendment 3).
28. A gateway-origin pairing token (issued by `remote-pair` or the desktop
    settings page) is redeemed only over the Host link and never on the
    loopback `RACP-WS` binding, and an ssh-origin pairing token is never
    redeemed through the Gateway; a device minted through the Gateway always
    carries the gateway origin and never `owner`. Applies from R4 (D665).
29. Account mode isolates accounts end to end: a key of one account cannot
    list, enroll against, route to, or obtain a grant for a Host of another
    account, even though every Router user's terminals share one overlay mesh.
    Applies from R7 (D666).
30. The Gateway never persists a raw Router AccessKey and never forwards a
    client's key to a Host, and a client does not retain the key after the
    device exchange; the key appears in no Host device store, log line, audit
    record, URL, or error payload. Applies from R7 (D666).
31. The Gateway takes the client address from its configured header only when
    the TCP peer is inside its trusted-proxy set, and forwards the caller's
    address to Router `/api/auth/session` in the header named by the Router's
    `CLIENT_IP_HEADER`, from a peer inside the Router's `TRUSTED_PROXIES`, so a
    key's `allowed_peer_cidrs` rejects a caller outside its policy.
    Applies from R7 (D666).
32. A confirm-once grant is accepted by a sibling Host only when the signer is
    enrolled in the same account under the Gateway CA and the device is not
    revoked; a Host in strict mode accepts no sibling grant. The minted device
    keeps `pairedDevice: false`, the remote permission ceiling, and no
    `allow-session`, so gate 25 applies unchanged. A revocation a Host makes
    while its link is down is queued and reaches the account's other Hosts when
    the link returns, so a lost device stops working everywhere rather than on
    one Host. Applies from R7 (D666).
33. `device.request` and `device.grant` reach only Hosts that advertise support,
    and a client is told which Hosts of its account cannot confirm instead of
    waiting for an answer. Applies from R7 (D666).
34. A push carries a fixed event kind, two localization keys, and ids, and no
    prompt, tool, transcript, or session-title content; it is off with no
    operator credentials; it reaches only devices that may open the named Host;
    a revoked device and a provider-reported dead token have no registration;
    and no provider credential appears in a log, an audit record, or an error
    message. Applies from R5 PR-6.
35. Automatic admission of a same-account computer happens only for a `desktop`
    request whose proof **the target Host verifies itself** — the chain to its
    own pinned Gateway CA, the account binding, the signature over the request
    payload, and an unused, unexpired nonce — and only while that Host's own
    automatic-admission switch is on; the Gateway's pre-check is never the
    authorization. The proof carries the applicant's certificate, and a Host
    that cannot chain it to its pinned CA, or whose certificate names another
    account or another `hostId`, refuses it: presenting the certificate is what
    lets a target Host verify a computer it has never talked to, and its
    integrity rests on that chain and binding rather than on the Gateway. A
    request without a valid proof, a proof whose nonce was
    already used or whose deadline passed, a phone or browser device, a Host in
    strict mode, and a target computer that has not announced
    `device.desktop-auto` are all refused or fall back to the per-device
    confirmation, never admitted silently. Every new Host enrollment notifies
    the account's other computers and is audited, and every automatic admission
    produces a device notice and an audit record. A sibling Host re-verifies the
    grant's proof itself and judges its freshness as of the grant, not as of the
    moment it reads the frame, so a computer that was offline while the request
    lived still adopts the device; a grant past its own delivery window, or one
    whose `issuedAt` is after its request's `expiresAt`, is refused. A revoked
    Host cascades: the account's other computers revoke the desktop devices that
    computer's proof admitted, and a `host.revoked` frame only ever removes
    authority. A phone or browser device still never holds `owner` and never
    leaves the remote permission ceiling. Applies from R8 (D675, ADR
    `remote-control-router-account-binding` amendment 3).

## 13. Amendment history

D374 (2026-09-10) added the browser cookie/header authentication profiles,
the two accepted identity sources, the remote permission ceiling, the local
decision vocabulary, the remote approval lifetime policy, the Host link and
Gateway attachment relay rules, the single-tenant-first clause, and gates
13–15.

D375 (2026-09-10) added the SSH bootstrap pairing (§3.4), the loopback rule
for `agent-host-cli` behind an SSH port forward, the ceiling exemption for
SSH-paired owner devices, the remote tool-catalog and provider-configuration
rules, gates 16–18, and marked the Gateway and cookie-profile clauses as
belonging to unscheduled milestones.

The D375 design-gate answers, recorded the same day, fixed the identity
source to the PI account service, the GitHub Releases download for
`agent-host-cli`, the relay and terminal rules with gates 19–20, the 30-minute
remote approval lifetime, and the `applyCeilingToPairedDevices` policy.

D385 (2026-09-10) withdrew the first-party identity source: remote control
is user-local by construction, every credential is issued by the user's own
Host, and any Gateway is self-hosted and admits clients with those device
credentials.

D454 (2026-09-19) added SSH password authentication for the bootstrap (§3.4,
ADR 0293): the credential-handling rules above and gate 21. It relaxes
`BatchMode=yes` for a password target only, with `NumberOfPasswordPrompts=1`
and `PubkeyAuthentication=no`, and keeps a key or agent as the default path.

D665 (2026-10-17, ADR 0331) scheduled the Gateway and browser milestones
(R4–R6): §3.1 and §3.2 lose their unscheduled status and §3.2 records the
enrollment exchange; §3.3 records that the route context's integrity is
guaranteed by the authenticated Host link in the self-hosted scenario, with
the Host's own credential store as the final authentication authority; §3.7
adds gateway-paired devices (additive `origin` field, gateway pairing never
grants `owner` or `pairedDevice`, cross-channel tokens rejected); §8 binds
from R4; and gates 22–27 cover the bind-address rules, the token and cookie
profile, gateway-paired principal restrictions, 5-second revocation
propagation, and the desktop-off regression. The D665 review adds the
pairing-token origin (§3.7, gate 17 narrowed to ssh-origin codes, new gate
28) and locks the policy-immune restrictions of gateway-origin principals
(no `allow-session` under `allowRemoteSessionGrants`, no `approverOverride`,
ceiling regardless of `applyCeilingToPairedDevices`) as test-locked rules.

D666 (2026-10-18, ADR `remote-control-router-account-binding`) adds the planned
account mode of §3.8 and gates 29–33: the Minih-Router AccessKey as account
identity that is resolved on the desktop by the D661 rule and verified by the
Gateway against Router `/api/auth/session` over loopback with the caller address
forwarded from a trusted peer only; the key-lifecycle rule (a disabled or
deleted key starts no new login or enrollment but revokes nothing by itself);
enrollment by AccessKey plus CSR from the additive `remoteGateway` bootstrap
object; account-scoped login, host listing, and device request / confirm /
grant relayed over the new `device.request` and `device.grant` Host-link
frames; the multi-account deployment, with a pointer from §8; the stated
accepted risk that the account directory now vouches for sibling Hosts, with
its required mitigations; and strict mode. §3.1–§3.7, the gateway-origin
restrictions of D665, and the self-hosted enrollment and pairing paths are
unchanged.

D675 (2026-10-21, ADR `remote-control-router-account-binding` amendment 3) adds
the desktop-class device: §3.7 records that a device admitted with a verified
Host-certificate proof holds `owner` and is exempt from the remote permission
ceiling, as the only way a gateway-origin principal may hold `owner`; that the
proof carries the applicant's certificate and the target Host chains it to its
own pinned Gateway CA; that the device record keeps the class and the
`applicantHostId` as optional fields; and that a revoked Host cascades to the
desktop devices its proof admitted, through a `host.revoked` frame that only
removes authority. §3.8 records automatic admission of a same-account computer
with its per-computer switch, the `device.desktop-auto` capability gate, and the
account-mode default of the remote-control switch; gate 27 is restated for
"never chosen" versus "explicitly disabled", and gate 35 covers the proof, the
certificate chain and binding, the freshness at grant time that lets an offline
sibling adopt a device, and the refusals. Phones, browsers, the self-hosted
flow, and gates 25, 26, and 28 are unchanged.
