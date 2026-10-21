# ADR 0336: Global-only configuration sync and an explicit project archive

- Status: Accepted (2026-10-21)
- Supersedes: the project-scoped half of ADR 0301's portable domain set
- Related: `docs/spec/03-runtime/22-config-sync.md`, `docs/spec/03-runtime/23-project-archive.md`

## Context

Configuration sync transported global configuration **and** project-scoped
records: a project's MCP servers, skills, `AGENTS.md`, pinned memory, learned
notes, and the automations bound to a folder. A receiving device had to map a
logical project identity onto one of its own folders, and only then could it
apply those records. Three problems followed:

1. **The mapping was unavailable in practice.** A new device has no folder for
   another machine's project, so the entities arrived as pending approvals that
   could never be approved, or that the user dismissed one by one. The Settings
   page kept a folder-mapping list that existed only to feed this path.
2. **"Project settings are per-machine" was not true.** A mapped device silently
   overwrote the other machine's project MCP server, skill, instruction file,
   memory, and automation enablement.
3. **There was no way to move a project.** Nothing carried the folder itself, so
   sharing a project between two machines meant recreating it by hand.

A separate defect lived in the same area: an approved plugin installation intent
was retained in the Host's sync configuration, but uninstalling the plugin only
removed it from the plugin manager. The next capture re-advertised the plugin
from the retained intent, so uninstall never propagated and the plugin could
reinstall itself on another device.

## Decision

**1. Sync carries global configuration only.** Capture, remote decode, the stored
baseline, a staged pending bundle, and a restore target all pass through one
predicate in `crates/host-core/src/config_sync/domains.rs` that classifies an
entity from its own markers (`mappingRequired`, and the project/group logical-id
payload fields). Project- and group-scoped records are dropped, and the
revision's resource references are recomputed from what remains. Dropped records
never become tombstones, because a tombstone is only derived from a baseline
entity this build still transports. Old revisions and cloud objects are kept;
pruning cloud history is not part of sync.

The retired folder-mapping RPC (`configSync.mapProject`) and its stored mappings
stay accepted, so an older renderer or an in-flight upgrade does not fail, but
no new record is produced for them to map and the Settings UI no longer offers
the entry point.

**2. A successful plugin uninstall clears its retained installation intent.** The
next ordinary sync then publishes a deletion tombstone from the existing
baseline. Disabling a plugin is not an uninstall and never clears the intent.

**3. A project moves through an explicit archive.** One logical project or
project group is exported to a versioned ZIP and imported on the destination
machine, once. It contains every regular file under each ordered root
(including hidden files and `.git`), project and group memory, the group's
instruction text, bound automations, and sanitized project MCP definitions.
Project skills, subagents and capability files travel as the files they are,
inside `<project>/.agents/`. It excludes chat history, global settings and the
account, API keys, OAuth state, plugin binaries and grants, and MCP `env`/
`headers` **values** — the app-managed MCP definition files are excluded from
the tree copy precisely because they contain those values. Symbolic links are
skipped and counted, on export and on import alike, so an archive can neither
follow a link out of the source project nor create one at the destination.

Electron Main owns the native save/open pickers and passes only the chosen
paths. Host-core validates, stages outside the destination, publishes, and
rolls back. The import refuses an existing non-empty destination folder, a
symbolic link at a destination root, and two entries or root names that collide
on a case-insensitive volume, and it leaves no half-imported project on failure.
Imported automations are created disabled; imported content is never executed
and never granted a permission.

## Consequences

- A device keeps its own project settings. Nothing about a project arrives
  through the account, and a pending approval can no longer be blocked by an
  unmappable project record.
- Moving a project is a manual, one-time action. There is no continuous
  relationship: later edits stay on the machine that made them.
- The archive copies the whole folder, so it can contain files the user does not
  want to share. The export UI says so before the destination is picked.
- **Upgrade order matters.** An older device keeps uploading project records,
  which this build ignores. It also keeps working on its own project settings,
  because a newer device publishes nothing for them. Operators should upgrade
  every device of a vault before relying on the new boundary; no protocol
  version changed.
- Import and export are bounded (32 roots, 200,000 entries, 8 GiB expanded,
  2 GiB per entry, 8 MiB manifest). A larger project fails with a limit error
  rather than exhausting memory or disk.
- Symbolic links are not preserved. A project depending on links inside its own
  tree loses them in a copy; the export reports the count.

## Alternatives considered

- **Keep project sync and improve mapping.** Still overwrites one machine's
  project settings with another's, and still requires a folder that a new device
  does not have.
- **Sync the project folder through the same vault.** Turns a large,
  continuously changing binary tree into revision objects, and conflicts on
  every concurrent edit. Rejected.
- **Reuse the in-memory plugin-package ZIP helpers for the archive.** They build
  the whole archive in memory and apply plugin package bounds; a real project
  tree does not fit either.
- **Copy the folder without sanitizing `.agents/servers`.** Copies MCP secret
  values into an archive the user is about to share.
- **Preserve symbolic links as archive entries.** Makes extraction able to
  escape the destination and depends on platform support. Rejected in favor of
  skipping and reporting them.
