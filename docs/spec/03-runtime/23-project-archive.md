# Project archive: explicit export and import

Status: implemented Host-owned project archive (version 1).

A project archive is one logical project or project group packaged as a single
ZIP file. It exists because cloud configuration sync carries global
configuration only ([22-config-sync.md](22-config-sync.md)): a project's files,
skills, MCP servers, instructions, memory and automations belong to the machine
that owns the folder, so moving that project to another machine is one explicit
export and one explicit import.

The archive is a migration, not a relationship. After an import the two copies
are independent; later edits on either machine stay there until another
explicit export and import.

## 1. Ownership and boundaries

```text
Renderer → Preload IPC → Electron Main → host-core (project_archive) → filesystem
```

- Electron Main owns only the native pickers: a save dialog for the export
  target, and an open-file plus open-directory pair for the import. It passes
  the chosen absolute paths and nothing else.
- Host-core is authoritative. It reads the registered project, resolves its
  project group and ordered roots, validates the archive, stages and publishes
  the copy, and writes the app-managed records.
- The Renderer shows progress, the outcome, and Host error messages; it never
  reads or writes the archive itself.

## 2. Contents

Included:

- Every regular file under each ordered root, including hidden files and
  `.git`, with directory structure and root order preserved.
- Project and group memory (`projects`/`project-group` memory records).
- The group's instruction text.
- Automations bound to the project (`workspacePath` = that project).
- Project skills, subagents and plugin-provided capability files: they are
  app-managed files inside `<project>/.agents/`, so they ride with the root
  files and are re-scanned by the receiving Host.
- Project MCP definitions, as a sanitized manifest record (see exclusions).

Excluded, deliberately:

- Chat sessions, transcripts, attachments and any other runtime or device
  state.
- Global settings, the account, provider API keys, OAuth state, plugin
  binaries, plugin permission grants.
- MCP `env` and `headers` **values**. `<project>/.agents/servers/*.json` stores
  project MCP definitions together with their secret values, so those files are
  never copied. The manifest carries the definition (id, label, description,
  transport, command, args, url, timeout, enabled, and the *names* of the
  configured environment variables and headers) and the import recreates it
  disabled, with no values; the user re-enters secrets on the destination
  machine. Neither side trusts the other: the export skips that subtree
  (comparing the folder names without regard to ASCII case, so a volume that
  spells it `.AGENTS/Servers` is still recognised), and the import **refuses**
  an archive that carries an entry for it, so a hand-edited ZIP cannot write a
  secret-bearing definition back into a project. A manifest definition is read
  through an allowlist of portable fields and its `env`/`headers` maps are
  cleared, whatever the file claims.
- Symbolic links. A link is skipped and counted in the result; the file behind
  it is not read, so an export can never follow a link out of the project. The
  receiving side therefore never creates a link and cannot be made to escape
  the destination.

The archive contains the whole project folder, which may itself hold files the
user does not want to share (`.env`, credentials files, build output). The
export UI states this before the user picks the destination.

## 3. Manifest

`manifest.json` at the archive root is the only trusted index. Version 1:

```json
{
  "format": "minih-agent-desktop-project-archive",
  "version": 1,
  "createdAt": "2026-01-01T00:00:00+00:00",
  "name": "Workspace",
  "roots": [
    {
      "index": 0,
      "name": "frontend",
      "fileCount": 128,
      "totalBytes": 4096,
      "skippedSymlinks": 0,
      "skippedSecretFiles": 1
    }
  ],
  "group": { "instructions": "…", "memory": { "content": "…", "entries": [] } },
  "projects": [
    {
      "root": 0,
      "memory": { "content": "…", "entries": [] },
      "mcp": [{ "id": "server", "label": "…", "envKeys": ["TOKEN"], "enabled": false }],
      "automations": [{ "id": "…", "prompt": "…", "cadence": "daily" }]
    }
  ]
}
```

The manifest carries relative identities only — the ordered root position and
the folder's own name. No source-machine absolute path is written anywhere in
the archive. File entries live under `roots/<index>/<relative path>`, and every
entry name is validated against that layout on import.

`fileCount` and `totalBytes` are the archive's integrity statement: the export
fills them from the same walk that writes the entries and fails if a folder
changes while it runs, and the import compares the extracted count and size of
each root against them. A truncated, padded, or hand-edited archive is refused
instead of imported.

**Portability of names.** An archive crosses platforms, so names are compared by
their identity on a case-insensitive, normalization-insensitive volume: Unicode
NFC followed by lowercase. Two entries — or two root folder names — that collide
under that key are refused on import even where the local volume happens to keep
them apart, because on macOS or Windows the second would silently replace the
first and a file would be lost. The export applies the same rule, so it never
writes an archive this build would reject.

## 4. Export

1. Host resolves `projectPath` from the registered project list and its stored
   group, and refuses a path that is not a registered project.
2. It counts each root (files, bytes, skipped links, skipped app-managed secret
   files) and gathers the app-managed records under the state lock, then
   releases the lock.
3. It streams the ZIP to a temporary file beside the target and renames it onto
   the chosen path. Renaming replaces a file that already exists there — the
   native save dialog is what asks the user to confirm that overwrite — and no
   other file is touched. A failed or interrupted export removes the temporary
   file and leaves any existing archive exactly as it was.
4. The result reports the target path, logical name, root count, file count,
   total bytes, and the skipped-link count.

The target must not be inside one of the project's own roots.

## 5. Import

1. Main passes the archive path and a destination parent folder.
2. Host reads and validates the manifest first: format, version, root count and
   order, root names (one safe path segment, unique), the project-to-root
   references, the entry layout (`manifest.json` plus `roots/<index>/…` only),
   symbolic-link entries, app-managed MCP definition entries, per-entry declared
   size, and the total expanded size. Duplicate detection compares the
   *normalized* path, so `a//b` cannot alias `a/b`. Nothing is extracted before
   every name is acceptable.
3. It extracts into a staging folder under the Host data directory — outside the
   destination — enforcing the declared size per entry while streaming and then
   checking each root's extracted file count and byte total against the
   manifest.
4. Only then does it check the destinations: each root is recreated as
   `<destination parent>/<root name>`. The check reads the path itself rather
   than following it: an existing symbolic link, a path that is not a directory,
   or a directory that is not empty is a conflict, and the import stops before
   touching it. The directory is re-checked right after it is created, so a link
   swapped in between cannot receive the extracted tree. A link placed under the
   chosen parent is a real attack surface — `exists()` follows it, and every
   subsequent write would land at its target, possibly outside the destination.
5. It creates the folders, moves the staged files into place (copying across
   volumes only when a rename cannot work), registers the projects, writes the
   app-managed records, and creates the project group when the archive holds
   more than one root or group configuration.
6. On any failure it removes the folders it created, deletes the project records
   it registered, and removes the staged copy — no half-imported project
   remains. On success the staged copy is removed as well.

Imported automations are created disabled; the user enables them on the
destination machine. Imported MCP definitions are created disabled and without
secret values. Imported content is never executed and never granted a plugin
permission.

## 6. Limits

| Bound | Value |
| --- | --- |
| Roots per archive | 32 |
| ZIP entries per import | 200,000 |
| Expanded bytes per import | 8 GiB |
| Expanded bytes per entry | 2 GiB |
| Manifest bytes | 8 MiB |
| Root name | one path segment, at most 128 characters |

Export and import share these bounds: the export refuses a project it could not
import again (a single file, a project, or an entry count beyond the limits)
before it writes anything, and both sides fail with
`PROJECT_ARCHIVE_LIMIT_EXCEEDED` and a clear message naming the bound.

## 7. Errors and IPC

| Prefix | Renderer code | Meaning |
| --- | --- | --- |
| `PROJECT_ARCHIVE_INVALID` | `INVALID_PARAMS` | The request or the archive itself is not acceptable |
| `PROJECT_ARCHIVE_CONFLICT` | `CONFLICT` | A destination folder already holds files |
| `PROJECT_ARCHIVE_LIMIT_EXCEEDED` | `LIMIT_EXCEEDED` | The archive exceeds a bound |
| `PROJECT_ARCHIVE_IO` | `INTERNAL` | A filesystem step failed; the message names the path |

Channels: `projectArchive/export` and `projectArchive/import` (invoke), plus
`projectArchive/event/progress` for `{ phase, done, total }` reports while a
request runs. Both requests are Host-owned and have no wall-clock budget, so a
large project can finish after the renderer navigates away.

Contracts live in `packages/shared/src/types/project-archive.ts`, the Host
implementation in `crates/host-core/src/project_archive.rs`, and the main-process
pickers in `apps/desktop/electron/main/ipc/workspace-ipc.ts`.

## 8. Verification

- Host unit tests cover a single project round trip (files, hidden files,
  `.git`, memory, MCP without values, skills, disabled automations), a group
  round trip with group instructions and memory, a single-root group without
  group text, refusal to overwrite a non-empty folder, a destination root that
  is a symbolic link or a regular file, path-escape/unknown-root/
  normalized-duplicate/case-and-normalization-collision/symlink/
  app-managed-secret rejection, injected manifest secrets, a rollback that also
  removes imported automations, manifest-count mismatch, the source-symlink
  skip, an export target that reaches a root through a symbolic link, an
  over-limit project, a project whose files collide by case, and an unsupported
  archive version.
- The multi-device E2E journey exports on one device and imports on another,
  then asserts the restored files and settings.
