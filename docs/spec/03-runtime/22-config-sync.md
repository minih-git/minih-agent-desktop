# Portable configuration sync

Status: implemented router-account configuration backup and synchronization.

Portable configuration sync is a host-owned, encrypted workflow that stores
backups in the Minih Router backend under the signed-in account. It does not
synchronize conversation history, project source files, attachments, runtime
state, or model weights. The Renderer only receives redacted status, preview
counts, conflicts, and activation summaries.

## 1. Ownership and boundaries

The process path remains:

```text
Renderer → Preload IPC → Electron Main → host-core → Minih Router backend
```

Host-core owns the vault key, router transport, revision state, merge base,
pending approvals, local encrypted staging, and import application. Electron
Main only registers the IPC handlers and forwards `configSync.changed`.
Agent Runtime has no sync implementation.

The remote destination is the Minih Router gateway's per-account client-backup
object storage: the same AccessKey that signs chat traffic authenticates
backup reads and writes over the control plane, and every object is namespaced
to that key server-side. Host-core resolves the account row from its own
providers store; the token never reaches the renderer or Electron Main.

The export path is an explicit per-domain allowlist in
`crates/host-core/src/config_sync/domains.rs`. It never serializes the
database, the secrets directory, or an arbitrary filesystem tree. Local paths,
window state, readiness flags, OAuth sessions, plugin binaries, and device
approvals are local overlays or excluded data.
The same module exposes an adapter registry declaring schema version,
portable/secret fields, local overlays, identity and references, merge
granularity, activation, and recovery policy for every supported domain.

## 2. Portable domains

The current adapter set covers application preferences, user-owned providers,
MCP definitions, user skills, global subagents, app-managed global/project
instructions, plugin installation intent, scheduled automations,
and optional project memory. Credentials are opt-in. Provider API keys and MCP
environment variables/headers are included only when the credential category
is selected; OAuth access/refresh tokens and cookies are never exported.
The providers category includes a user-owned provider's name, vendor,
endpoint, non-secret account display label, headers, explicit provider
reasoning/limit overrides, and ordered model bindings. Model aliases, wire
protocol, limit provenance, thinking levels/default, attachment capabilities,
subagent availability, and hosted-search opt-in survive capture and restore.
Application preferences carry the default provider/model and image/speech model
bindings; provider dependencies remain staged until available. Live balances,
quota/usage responses, OAuth sessions, and readiness flags are not backed up.
Restoring an API token requires both the credential opt-in and local approval;
without it, a new secret-bearing provider remains disabled until configured.
The instruction adapter reads only the fixed global `~/.pi/agent/AGENTS.md`
and each registered project's root `AGENTS.md`; it does not scan nested
repositories or arbitrary files. Imported instruction files are written only
after their scope is explicitly selected, mapped where required, and approved.
Instruction files carry no instruction-specific byte cap; their content is
bounded only by the shared portable-entity payload bound Host checks when it
uploads a revision and when it validates a remote one.
Directory-shaped skills carry bounded sibling resources as authenticated
objects. Package paths, symlinks, collisions, file counts, and total size are
validated by Host before approved resources are written: at most 256 resources
per package, 2 MiB per resource, and 16 MiB per package, while the skill
document itself stays capped at 128 KiB because it can reach a prompt. Scripts
are stored as bytes and are never executed by import.

The connected Minih Router account row is device-local, like the project
lists. It is the sync transport's own identity — each device links its own
account — so it is never captured, applied, or tombstoned by sync or backup.
A second device joins the same backup by connecting the same account in
Settings → Accounts and entering the same vault password.

Project and project-group lists are device-local. Their names, pinning, root
lists, and ordering are not captured or applied by sync or backup, and there is
no projects category. Legacy `projects` entities in existing vault revisions
are ignored during sync and restore; this does not delete local projects or
remote revision history. Project-scoped MCP, skills, instructions, memory, and
automation bindings remain supported through local folder mappings. Receiving
devices register their own projects and groups when those features require a
local workspace.

Project and workspace bindings are represented by opaque logical identifiers.
Host-core assigns a persistent logical identity to each registered standalone
project; project-group roots derive identities from the group identity and
ordered root position. A device mapping overlays the received logical ID onto
its local folder, so different absolute paths do not create duplicate
entities.
Incoming project-scoped executable content stays staged until a local folder
mapping and approval exist. No local path is written into the encrypted
portable entity payload. Plugin data that has no supported adapter is reported
as unsupported rather than treated as synchronized. Approved plugin installation
intent is kept in a Host-owned local overlay; it never pulls plugin bytes or
permission grants.

## 3. Vault and router protocol

Each vault has a random data key. The backup password is processed with bounded
Argon2id parameters, and the data key is wrapped with AES-256-GCM. Every head,
revision manifest, and resource object is separately authenticated with a
purpose/vault-derived object key, domain-separated associated data, and a
fresh nonce. Resource object IDs are keyed content identifiers, so plaintext
global hashes are not required. The vault envelope version is independent from
the SQLite schema and is bumped when cryptographic derivation changes.

The remote layout uses one wrapped-key header, two mode-specific encrypted
heads, and immutable authenticated revision/resource objects, stored under the
account's server-side namespace:

```text
header
vault/<opaque-vault-id>/head
vault/<opaque-vault-id>/backup-head
vault/<opaque-vault-id>/revisions/<revision-id>
vault/<opaque-vault-id>/objects/<object-id>
```

The stored configuration format is `minih-agent-desktop-config-sync-router`,
version 1. Each head indexes at most 30 revisions, newest first. Sync and
backup have separate heads, history, and authentication purposes; neither mode
follows an unbounded parent graph. Immutable objects remain stored
indefinitely. This bounds history queries, **not storage usage**; the client
performs no physical garbage collection, and the backend enforces a per-account
quota instead.

Requests are authenticated with the account AccessKey as a Bearer token over
the gateway control plane. Object reads are `GET /api/client-backup/objects/…`,
writes are conditional `PUT`s, and both speak raw bytes with strong quoted
ETags. Initialization uses `If-None-Match: *`; head updates require the current
strong ETag and `If-Match`. A rejected precondition restarts reconciliation,
never a blind overwrite. The backend derives ETags from a per-object write
version, so every successful write yields a new strong ETag, and the
conditional check plus write are atomic in one database transaction.

Capability discovery is `POST /api/client-backup/probe`: the backend runs the
same create/duplicate/stale-etag sequence against a reserved probe name,
deletes it, and answers `{ conditionalWrites: true }`. Configure and connection
tests both require a successful probe. There is no client-visible fallback to
unconditional writes, no append-only mode, and no third-party object storage.

Only GET 404 means absent. 401/403 are authorization failures (a rotated or
disconnected account reappears here); 413 is the account storage quota.
Conditional PUT 409/412 means a lost publication race. Errors retain stable
`CONFIG_SYNC_*` codes without exposing the account token, URLs containing it,
or server response bodies.

The gateway address comes from the connected account row's base URL; when the
EasyTier LAN endpoint is reachable it is preferred, with the public address as
fallback — the same resolution the chat path uses. Redirects and public
plaintext HTTP are rejected; LAN HTTP is allowed only by the Host's relaxed
network policy. Connection timeout is 10 seconds, request timeout is 60
seconds, streamed objects are capped at 64 MiB, and the backend caps each
account at 1 GiB of backup storage. Object names use bounded safe ASCII
segments; traversal and weak ETags are rejected.

The destination identity is the SHA-256 fingerprint of the account token.
Rotating the key or switching accounts changes the destination, requires
setting the backup up again, and creates a fresh local state identity; pending
imports must be resolved first. Re-saving preserves an existing pause. Joining
an existing vault adopts the remote header when the same backup password
unlocks it; a different account that already holds another vault is refused
until disconnect.

## 4. Merge and activation

The encrypted baseline stores both the acknowledged shared revision and its
observed local projection. Credential opt-out and device-local overlays must
not manufacture local edits or block remote deletions. Unacknowledged local
edits are not absorbed when another entity is approved.

In `sync` mode, capture, remote read, three-way merge, immutable upload, CAS
publication, and local application are serialized per vault. Scalar settings
merge by declared entity unit; provider, MCP, skill, and automation records are
not merged as arbitrary arrays. Tombstones carry deletion state and refreshed
digests and remain in subsequent baselines. An unselected category is not a
deletion.

In `backup` mode, a run publishes a local snapshot to `backup-head`. It reads
head metadata for CAS/history but does not download or apply remote
configuration. Multiple devices keep independent snapshots in that history,
not merged configurations. Unchanged snapshots do not create new revisions.

Same edits converge and disjoint edits continue. Same-unit edits and
delete-versus-edit retain both candidates as conflicts. Imported MCP, skills,
subagents, plugins, and automations require local activation approval; an
approval is bound to the entity digest. A changed command, endpoint, script,
instruction, or credential destination therefore invalidates the old approval.
An applied conflict choice records both candidate digests. The next sync
folds that exact unchanged pair into the chosen canonical entity and publishes
it with CAS. Changed candidates still require a new explicit choice.
Missing provider references are retained as dependency approvals instead of
being written as unusable defaults; unrelated entities can continue applying.
The host never activates staged executable content merely because a UI flag is
set. Newly imported automation definitions are also disabled until this
device explicitly takes execution ownership; an existing local task keeps its
device-local enabled state.

The import path rechecks the captured local generation before applying each
entity. Changes made after capture are left in place and are reconciled on the
next run. A durable encrypted pending bundle records the captured local
manifest and an `applying` marker; restart recovery finishes the approved
steps or leaves the bundle visible for retry before the configuration is
considered converged. Existing direct local MCP creation behavior is
unchanged.

Receiving application preferences are filtered through the portable-field
allowlist. Credential opt-out also applies on import, including provider keys
and MCP environment/header fields. Approved skill resource replacement checks
expected content, paths and symlinks, retains unrelated files, and removes only
previously synchronized files omitted by the new package. Each file is replaced
atomically; an import journal is recovery bookkeeping, not a transaction over
the whole filesystem.

## 5. Settings workflow

The Settings → Cloud sync destination is available in development and
packaged builds and carries an Experimental badge on its rail row and page
title. Its visibility does not change the Host-owned sync behavior described
here.

Settings → Cloud sync shows the connected Minih Router account (endpoint and
connection test), a vault password, device label, `sync` (default) or `backup`
mode, automatic-run selection, categories, manual run, unlock, pause, folder
mapping, approval/rejection, history/restore, password rewrap, and disconnect.
Without a connected account the page explains that an account is required and
links to Settings → Accounts; setup controls stay disabled until one exists.
The renderer displays `notConfigured`, `locked`, `upToDate`,
`localChangesPending`, `syncing`, `offline`, `unsupportedServer`, `conflict`,
`awaitingActivation`, `paused`, and `error` as distinct states. Disconnect
keeps local data and does not delete remote data.

The page prioritizes status, last success, manual run, pause and inline unlock
above maintenance. Connection testing probes the account's backup storage;
setup needs the vault password and device label only. Saved configurations
reopen collapsed; unfinished drafts reopen for editing. Automatic runs use the
shared switch. Category choices are available before the first save inside
connection settings, with credentials and memory still opt-in. History,
preview, mappings and security/connection maintenance expand on demand;
errors, manual progress and pending approvals stay visible. Collapsing content
does not reset form values or issue a Host request.

Reopening the page paints cached redacted state/history and a validated,
non-sensitive draft, then refreshes in the background. The draft key is
`pi.desktop.configSyncRouterDraft.v1`; the legacy S3 draft key is removed on
the next save. Only mode, device label, automatic-run choice, and categories
are persisted. Passwords remain transient input memory and are cleared after a
successful save. Changing the account or mode invalidates history and
outstanding history reads. An unsaved mode selection does not change restore
behavior.

A manual run reports `capture`, `download`, `merge`, `upload`, and `apply` via
`configSync.progress`; there is no cleanup phase. `done`/`total` count objects
while transferring and entities otherwise. A total of 0 means unknown, and a
`bytesTotal` of 0 means the byte size is unknown, which is the normal case for a
download. Reports are throttled and phase changes are never dropped; the Host
state event and call return are terminal signals. Background polls report
nothing, while a manual Host-owned sync reports progress independent of the view.

`configSync.syncNow` has no aggregate RPC deadline. The Host owns the operation,
so navigating away from Settings does not cancel it. Returning to the page reads
the Host's `syncing` state, disables duplicate actions, and subscribes to the
remaining progress reports. Individual backend requests retain their own
timeouts; normal Host/process shutdown remains the lifecycle boundary.

Credentials and memory are unchecked by default. The setup preview reports
supported, excluded, secret-bearing, mapping-required, and pending-activation
counts. Raw exported secrets and vault keys are never returned to the
renderer; backup passwords cross IPC only as transient inputs, and the account
token never crosses IPC for sync at all.

The host owns an immediate startup check, a 30-second local-change debounce,
and a bounded five-minute remote poll when automatic sync is enabled. Failed
network attempts use bounded exponential retry with jitter; paused, locked,
incompatible, authentication, and wrong-password states do not spin retry
loops. The worker is cancelled with the host; there is no extra daemon after
the app exits.

## 6. Durability and compatibility

Configuration is stored at `configSyncRouter/config` in the Host `kv` store.
The vault key uses existing encrypted Host secret storage. That implementation
uses encrypted files and a `.machine-key` in the same data directory, not an
OS Keychain backend; copying the entire data directory is not a protected
cloud backup. The account token stays in the providers store where Accounts
manages it; sync keeps no second copy.

Local state lives under `config-sync/router/<state-id>/`. The encrypted
shared/observed baseline, pending bundle, and recovery points use temp-file
rename. A malformed or unauthenticated bundle is an error, not an empty state.
Only the router-account format is supported. Old S3 configuration and local
state are not detected, interpreted or migrated; they are left inert, and
existing cloud objects are not deleted. No SQLite migration is needed.

Restore first saves an encrypted local recovery point. Sync restore requires
`acknowledgePropagation: true` and immediately publishes a new shared revision;
sensitive local activation remains separately approved on each device. Backup
restore is local only and does not move either remote head. The latest backup
can also be restored. Neither mode silently overwrites a pending import.

A password change CAS-updates and authenticates the wrapped-key header without
changing the vault data key. Previously unlocked devices retain access; this
is rewrapping, not device revocation. A fresh device without trusted head
history cannot prove a malicious server returned the newest valid backup.
Availability and freshness against such a server are not guaranteed.

The protocol and connection contracts are intentionally router-account-only.
All devices sharing the vault must use this implementation against the same
account. The former WebDAV and S3 backends are removed, not emulated; their
cloud objects remain untouched.
See [the router-account decision](../../adr/router-account-configuration-backup.md).
