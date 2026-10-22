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
global MCP definitions, global user skills, global subagents, the global
instruction file, plugin installation intent, global scheduled automations, and
the user's own learned memory. Credentials are opt-in. Provider API keys and MCP
environment variables/headers are included only when the credential category is
selected; OAuth access/refresh tokens and cookies are never exported.

**Only global configuration travels.** Every project- and group-scoped record —
a project MCP server, a project skill and its resources, a project `AGENTS.md`,
a group instruction, pinned project or group memory, project learned notes, and
an automation bound to a folder — belongs to the machine that owns that folder
and is neither captured nor applied. Moving a project to another machine is an
explicit export and import of a project archive
([23-project-archive.md](23-project-archive.md)), which is a one-time migration
and not a sync relationship. The shared categories therefore describe global
content only, and the category list keeps the `memory` entry because it also
gates the learned-memory opt-in below.
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
Pinned project and group memory is device-local: it is neither captured nor
applied, and it moves between machines only inside a project archive.
The instruction adapter reads only the fixed global `~/.pi/agent/AGENTS.md`;
it does not scan nested repositories, project roots, group text, or arbitrary
files. An imported instruction file is written only after its category is
selected and the entity is approved. A project's root `AGENTS.md` is ordinary
project content: it travels inside that project's archive and never through the
cloud copy.
Instruction files carry no instruction-specific byte cap; their content is
bounded only by the shared portable-entity payload bound Host checks when it
uploads a revision and when it validates a remote one.
Directory-shaped skills carry bounded sibling resources as authenticated
objects. Package paths, symlinks, collisions, file counts, and total size are
validated by Host before approved resources are written: at most 256 resources
per package, 2 MiB per resource, and 16 MiB per package, while the skill
document itself stays capped at 128 KiB because it can reach a prompt. Git
metadata — `.git` at any depth — is repository state a skill directory happens
to contain, not a skill resource: the packager skips it while walking a package
and an import ignores it even when a revision still lists it, so a repository
kept beside a skill neither fails the capture nor travels to another device.
Scripts are stored as bytes and are never executed by import.

The connected Minih Router account row is device-local, like the project
lists. It is the sync transport's own identity — each device links its own
account — so it is never captured, applied, or tombstoned by sync or backup.
A second device joins the same backup by connecting the same account in
Settings → Accounts and entering the same vault password.

Project and project-group lists are device-local. Their names, pinning, root
lists, ordering, MCP servers, skills, instructions, memory, learned notes, and
folder-bound automations stay on the device that owns the folders; they are not
captured, applied, approved, or tombstoned by sync or backup, and there is no
projects category. Legacy `projects` entities and every project-scoped record in
an existing vault revision are ignored during sync and restore; this does not
delete local projects, remote revision history, or the local settings they
describe. A device registers its own projects and groups; a project moves
between machines only through an explicit archive export and import.

Learned memory is a separate domain (`learnedMemory`) gated by the same opt-in
memory category as pinned memory; it is not a category of its own. **Only the
user's own scope travels.** It is one entity that needs no folder mapping, and it
carries the `active` and `archived` notes plus the tombstones that make a delete
stick. A project's or a group's learned notes describe folders this machine
owns: they are never captured, never merged, and never applied through the cloud
copy, so no project-identity entity, folder mapping, or cross-device ordering
applies to them. They stay in the local database and travel only inside that
project's archive.

A note's identity inside the synced scope is the fingerprint of its kind and
content, and that is also the merge unit: two devices that wrote the same
sentence merge into one row instead of duplicating, and two devices that each
wrote their own note keep both, because the scope's payload is unioned by
fingerprint rather than offered as a whole-scope conflict. A note the same
fingerprint names on both sides is taken from the newer `updated_at`, and a
delete propagates as a tombstone that blocks both the same memory and the same
cited evidence from coming back. A delete wins over an edit of the same note —
an edit moves `updated_at` only — unless the note was created after the delete,
which is what "remember again" produces. Suggestions, the extraction cursor and
session state, the daily budget ledger, and the device-local usage counters never
travel: a merged `use_count` would turn every lookup into a sync edit, and
another device's numbers are not this device's usage. Provenance is not re-checked
against local messages on apply — the cited messages belong to the device that
wrote the note — while the structural, enum, bound, and credential checks run on
every entry, so a credential that reached one database is never written into
another.

Two limits follow from that design. Deletes and re-creations are ordered by the
timestamps the devices wrote, so a large clock difference between them can order
a delete and an edit the wrong way. And the scope contributes at most 500 notes
to a revision; more keeps the newest 500 and leaves the rest on the device that
holds them.

**Version requirement.** A device whose build does not know a domain cannot read
a revision that carries it: the manifest decode refuses an unknown domain
(`CONFIG_SYNC_UNSUPPORTED`) rather than skipping it, so its head read fails, and
with it every later sync and restore, until it is upgraded. Shipping a new
domain therefore requires every device of a vault to run a build that knows it.

### 2.1 The global boundary is enforced on every path

The scope test reads the entity itself — the `mappingRequired` marker and the
project/group logical-id payload fields — so it classifies a record the same way
whether this device captured it, an older build uploaded it, or it sits in the
acknowledged baseline:

- Capture produces global entities only; a project record never enters a new
  snapshot, and its resources do not either.
- A decoded remote revision is authenticated first, then filtered:
  `retain_portable_entities` in `crates/host-core/src/config_sync/domains.rs`
  drops unsupported domains and every project-scoped entity and recomputes the
  revision's resource references from what remains. An older revision that still
  carries project data therefore neither applies it nor fails the sync.
- The stored baseline and a staged pending bundle are filtered when they are
  loaded. Dropped records never become tombstones, because a tombstone is only
  produced from a baseline entity that this build still transports; an approval
  staged for a project record is discarded instead of blocking future runs.
- Restore targets come from the same filtered remote reader, so restoring an old
  revision leaves local project settings untouched.
- History listing reports the entities this build would process. Old revisions
  and objects are retained: pruning cloud history is not part of sync.

No local path is written into an encrypted portable entity payload. Plugin data
that has no supported adapter is reported as unsupported rather than treated as
synchronized. Approved plugin installation intent is kept in a Host-owned local
overlay; it never pulls plugin bytes or permission grants.

The former folder-mapping workflow is retired: the Host still accepts
`configSync.mapProject` and keeps stored mappings so an older renderer, an older
pending bundle, or an in-flight upgrade does not fail, but no new project entity
is produced for it to map, and the Settings UI no longer offers the entry point.

### 2.2 Plugin uninstall publishes a deletion

An approved plugin installation intent is the only thing that makes another
device install a plugin from the cloud copy. A successful uninstall clears the
intent in the Host's sync configuration, so the next ordinary sync derives a
deletion tombstone from the existing baseline and publishes it; the peer drops
its intent and repeated syncs do not restore it. Disabling a plugin is not an
uninstall and never clears the intent. No remote revision or object is deleted,
and plugin bytes, permissions, and unrelated data are untouched.

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
mode, automatic-run selection, global-scope categories, manual run, unlock,
pause, approval/rejection, history/restore, password rewrap, and disconnect. The
category block states that only global configuration travels and points at the
project archive for moving a project; the retired folder-mapping list is gone.
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
The learned-memory domain is the first that adds a portable domain to a vault
whose other devices may predate it: a device on an older build refuses a
revision carrying `learnedMemory` (see §2), so all devices must be updated
together. The global-only scope is a behavior change rather than a protocol
change: an older device still captures and uploads project records, and this
build ignores them, so every device should be upgraded before relying on the
new boundary. A device that stays on an older build keeps its own project
settings working, because the project data it receives from a newer device is
simply absent rather than deleted.
See [the router-account decision](../../adr/router-account-configuration-backup.md).
