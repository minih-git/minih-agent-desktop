# ADR plugin-learned-memory-read: Read-only learned-memory listing for plugins

- Status: Proposed (decision id assigned on acceptance)
- Date: 2026-10-24
- Amends: [ADR agent-long-term-memory](agent-long-term-memory.md) (D668) §8,
  for read access only
- Related: `usage.read` (spec `07-plugins/13-plugin-permissions-matrix.md`),
  ADR 0234, ADR 0249, plugin ADR `minih.personal-knowledge` 0001
  (`minih-agent-plugins`, `plugins/minih.personal-knowledge/docs/adr/`)

## Context

Learned memory (D668) is a host-core domain in SQLite. It holds typed notes
(`preference`, `feedback`, `fact`, `reference`) in a `project` scope or in the
`user` scope. Notes have a status (`suggested`, `active`, `archived`),
provenance, and tombstones. Only the host and the user write it. The agent
reads it through the session-start index and `MemorySearch`. D668 §8 lists "a
Plugin SDK surface for learned memory" as out of scope for v1.

The first-party plugin `minih.personal-knowledge` turns the user's Obsidian
vault into agent context. Its new Knowledge Universe view draws the vault as
a graph and should show the user's memory notes next to the project they
belong to. From there the user can promote a mature `fact` or `reference`
into a vault note. On the user's device on 2026-10-24 there are 21 active
notes, 35 suggestions, and 201 tombstones.

With no plugin surface, the only way is to read `pi.sqlite` from the plugin
process. A plugin `main.js` runs with raw Node built-ins, and the brokered
`pi.*` gate does not constrain that (spec `05-security/01-security.md` §6),
so this is possible. It would also:

- bypass host ownership of SQLite (AGENTS.md §4);
- ignore the user's "use learned memory" switch (`settings.learnedMemoryRead`);
- break whenever the schema changes, because no contract stands behind it;
- expose suggestions, archived notes, and provenance that the plugin has no
  use for.

`usage.read` already sets the pattern for a read-only, plugin-facing facts
domain: `pi.usage.listTurns` is gated in Electron main (`plugin-runtime.ts`
case `usage.listTurns`), routed through `plugin-services.ts`, and served by
the host RPC `plugin.usage.listTurns`. The response is a bounded projection
with no write path.

A manifest that names a permission the host does not know fails validation
(spec `07-plugins/02-plugin-manifest-schema.md`, "Unknown permission =
validation failure").

## Decision

### 1. Permission

Add `memory.read` to `PLUGIN_PERMISSIONS`.

| Permission | Risk | API | Grant | Boundary |
|---|---|---|---|---|
| `memory.read` | high | `pi.memory.list` | Confirm at install | Lists active learned-memory notes of the user scope and of any project path the plugin names; no suggestions, archived notes, tombstones, or provenance; no write path |

The risk is high, not medium like `usage.read`, because the response carries
text the user wrote about themselves and their projects. Labels: en "Read
learned memory", zh-CN "读取长期记忆". The install review states the boundary
above in both locales.

### 2. API

```ts
pi.memory.list(input: {
  scope: "user" | "project"
  path?: string      // required when scope is "project": an absolute folder path
  kind?: "preference" | "feedback" | "fact" | "reference"
  limit?: number     // 1..=200, default 50
  offset?: number    // >= 0, default 0
}): Promise<{
  readEnabled: boolean
  entries: Array<{
    id: string
    scope: "user" | "project"
    kind: "preference" | "feedback" | "fact" | "reference"
    content: string
    rationale: string | null
    origin: "explicit" | "user_ui" | "extracted"
    evidence: "user_stated" | "verified" | "inferred"
    createdAt: number  // epoch ms
    updatedAt: number  // epoch ms
  }>
  nextOffset: number | null
}>
```

Semantics:

- **Active notes only.** The host filters `status = 'active'`. The response
  never carries `suggested` or `archived` notes, tombstones,
  `superseded_by`, `source_session_id`, `source_message_ids`, `fingerprint`,
  `revision`, `use_count`, or `last_used_at`.
- **Scope resolution.** A `project` path resolves with the existing
  `learned_memory_scope_for_path`: a root of a stored project group maps to
  the group scope; any other path maps to its canonical path. A path that is
  not a project therefore returns an empty list. The API does not enumerate
  projects or reveal scope keys.
- **Read switch.** When `settings.learnedMemoryRead` is `false`, Electron main
  returns `{ readEnabled: false, entries: [], nextOffset: null }` and does not
  call the host. The plugin can then explain why nothing is shown. Turning
  the switch back on restores results. No memory is deleted either way.
- **No side effects.** A listing does not update `last_used_at` or
  `use_count` and does not record an index capture. A plugin view must not
  distort the usage signals that consolidation relies on.
- **Order and paging.** Rows come in the manager's order, `updated_at DESC,
  id ASC`, the order of `list_memory_entries`. `nextOffset` is `offset +
  entries.length` when more rows exist, otherwise `null`. The host fetches
  `limit + 1` rows to decide that.
- **Validation.** Electron main validates `scope`, an absolute non-empty
  `path` for `project`, `kind`, and the bounds. The host re-checks them and
  answers `INVALID_PARAMS` with no echo of the input.
- **Audit.** The existing plugin API audit records the call, its result, and
  the entry count, never content.
- **Reach.** Plugins only. RACP, remote web, and mobile clients get nothing
  new.

### 3. Wiring

Following the `usage.read` precedent:

1. `packages/plugin-sdk`: the permission, the `memory.list` member of the
   host API type, and the exported input and result types.
2. Electron main: a new module `electron/main/plugin-memory-read.ts`, beside
   the other flat `plugin-*.ts` modules, holds the input normalizer and the
   read-switch check. `plugin-runtime.ts`
   gains one `case "memory.list"` that calls `assertPermission(loaded,
   "memory.read")` and delegates to that module, so the 6,000-line runtime
   grows by a few lines only. `services/plugin-services.ts` adds
   `memory.list`, which calls the host RPC with `pluginId`.
3. Host core: `plugin.memory.list` is one thin arm in `rpc/mod.rs` that
   delegates to `rpc/memory_rpc.rs`, where the projection lives beside
   `memory.list`. The projection is a separate serializable struct, so a new
   field of `MemoryEntryRecord` never leaks to plugins by accident.

### 4. Compatibility

- The change is additive: there is no schema migration, no config-sync
  change, and no protocol version bump.
- A plugin that declares `memory.read` must require the first Desktop
  release that ships it (`engines.minihAgent`), because older hosts refuse
  the manifest. `minih.personal-knowledge` ships the consumer as 0.3.0 after
  that release.
- D668 §8 gets an amendment note: a read-only listing of active notes is
  allowed through `memory.read`. Write access, suggestions, and provenance
  for plugins stay out of scope.

### 5. Documentation updated in the implementing change

- `docs/spec/07-plugins/13-plugin-permissions-matrix.md`: the row of §1 and
  both label locales.
- `docs/spec/07-plugins/03-plugin-api.md`: a `### memory (requires
  memory.read)` section with the contract of §2.
- `docs/spec/07-plugins/01-plugin-system.md`: the API list.
- `docs/spec/03-runtime/06-host-rpc-protocol.md`: `plugin.memory.list`.
- `docs/adr/agent-long-term-memory.md` §8: the amendment note.
- `docs/adr/README.md`: the status of this record's index row, on acceptance.
- `docs/spec/08-meta/decisions-log.md`: the decision entry on acceptance.
- `packages/shared/src/changelog.ts`, following
  `docs/spec/06-delivery/05-change-checklist.md`, because the Plugin SDK is a
  released surface.

### 6. Tests

| Level | Covers |
|---|---|
| host-core RPC | Only active notes; projection has none of the excluded fields; `kind` filter; `nextOffset` at the boundary; no change to `use_count` or `last_used_at`; a group root resolves to the group scope; invalid params |
| Electron main | Refused without `memory.read`; `readEnabled: false` with no host call when the switch is off; normalizer bounds and the absolute-path check |
| Plugin SDK | A manifest that declares `memory.read` validates; the permission list contract |
| Renderer | The install review shows the localized label and boundary text |

## Consequences

- Plugins can build memory-aware views on a stable, host-owned contract
  instead of reading SQLite.
- Any plugin the user grants `memory.read` can read every active note in
  the user scope and in any project it names. The install review says so,
  and the credential detector already keeps secrets out of memory.
- Writes, tombstones, provenance, and suggestion review stay host and user
  actions. The prompt-injection exposure of D668 does not grow, because a
  plugin cannot create memory.
- The permission is a contract and a disclosure, not containment: a plugin
  main process with raw Node could still open the database file. This ADR
  does not change that limit of spec `05-security/01-security.md` §6.

## Alternatives

- **Let plugins read `pi.sqlite`.** Rejected: it breaks SQLite ownership,
  ignores the read switch, and has no compatibility contract.
- **Expose `memory.search`.** Deferred: a view lists by scope; search with
  `recordUse` would change usage signals. It can be added later as a second
  call under the same permission.
- **Include suggestions and archived notes.** Rejected: suggestions are
  unconfirmed content, and archived notes are what the user chose to hide.
- **Per-project consent.** Rejected for v1: no consent surface per scope
  exists, and install-time confirmation matches `usage.read`.
- **A write or archive API**, so a plugin could finish a promotion. Rejected:
  provenance rules require user-authored messages, and archiving stays the
  user's action in the memory manager.
- **Return project roots or scope keys** for discovery. Rejected: the plugin
  passes the paths it already knows, and the host does not enumerate the
  user's projects to it.
