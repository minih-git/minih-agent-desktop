# Selected upstream recovery and settings fixes: 2026-11-08

Status: implementation candidate in `fix/upstream-selected-20261108`, based on
Minih `33f07dc0b`. Not committed, integrated, released or installed by this task.
This is selective content adaptation, not an ancestry merge or complete import.
The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`.
The monitoring checkpoint `b94d1fb9bc3198f30f6ccaefe8c5d5cf37cc558b`
means analyzed, not imported.

## Provenance and adapted behavior

Source: `vastsa/PI-Desktop`, reviewed at the monitoring checkpoint above.

| Adaptation | Source revision | Minih-specific constraints |
| --- | --- | --- |
| Bounded tail checkpoint recovery | `4d4a17d7eaa7d1c8ab0ba26867e781c2252a65ab` | Tail includes trailing checkpoints; middle pages stay bounded. Preserve binary transcripts and physical offsets. |
| Sidebar layout backup/recovery | `b7d03c6576aee0eeede77dca775fd35edb2cc2f8`, test follow-up `398f6d6388d9e0c23c22b35edfe246e1b33a4be5` | Keep manual titles, existing cache key, generation fences, running-session restoration, Minih IPC names and Rust-owned groups/workspace. |
| MCP destination ownership | `e9af6fa36d6d08d1946612f4397759b1d381b47c`, `922058705921e79d45faa747c8586649834e067f`, tests `9ec4a942d24f59e728ea9e26debaff17020682ee` | All targets the selected project, editors pin ownership and duplicate checks reread that destination. Keep Host validation and fork collection/control-channel behavior. |
| Image-generation model disclosure | `4cd88649ca1b3ed6fad8b542eb10f2fda73a6631` | Help belongs in shared ModelBindingFields; badge belongs in the collapsed picker row. Keep per-model wire formats, complete IDs and capacity overrides. |

Sidebar recovery adds superseded-restore protection beyond the source patch and
keeps backup errors observable. Presentation backup is private and atomically
written; unreadable files are not overwritten, and storage relocation remaps
only internal paths and project metadata keys. Database schema is unchanged.

Browser reconnect semantics, context-capacity display, usage-cost UI, unified
job selectors and plugin updates are excluded. No provider presets, Router
endpoints, pricing, application version or full-import baseline changes.

## Pending release notes

- Reopening a compacted conversation retains checkpoints appended after its last
  message, including after Host restart.
- Retained project layout and manual conversation-title metadata recover after
  Chromium cache loss. Explicitly closed project tabs remain closed.
- MCP All creates/imports/installs into the selected project; editing keeps its
  original destination even if the page switches projects.
- Image-model marking explains chat exclusion and stays visible in collapsed
  settings rows, including the shared independent editor controls.

## Verification

Baseline: new sidebar recovery test failed because the restore entry was absent.
New Rust tail test read 1 checkpoint instead of 3; new relocation test retained
its old internal path. Production fixes were applied after those failures.

- Final sidebar/bootstrap/IPC and existing sidebar regressions: 65 passed,
  including backup-write failures and the shared initialization/recovery mapping.
  The initialization/chat-error subset separately passed 39 cases.
- Rust `transcripts::tests`: 38 passed; `data_relocation::tests`: 10 passed.
  Both new regressions failed before their production fixes.
- `scripts/e2e-compaction-tail.mjs`: passed against the rebuilt candidate Host;
  latest checkpoint and original historical usage survive Host restart.
- `scripts/e2e-sidebar-recovery.mjs`: passed three isolated process starts with
  fresh Chromium profiles, manual-title metadata and secondary-renderer denial.
- Shared/i18n and required downstream packages built using installed tools;
  Desktop typecheck passed before the settings adaptation. Package aliases point
  into this worktree; third-party dependencies reuse the primary checkout.
- Architecture, Agent policy, documentation structure/pairs and added relative
  links passed. Scoped Biome checks passed for the files present at that stage.

- Shared protocol contracts: 16 passed, including the additive Minih channels.
- Settings/model configuration/control-channel regressions: 40 passed, including
  real Electron MCP create/import/install/editor-owner paths and image-model
  marking/unmarking/collapsed badge. The old MCP implementation failed because
  All created at the wrong level. Editor subtitle now also follows its owner.
- Final Desktop typecheck, 30 changed TS/TSX/MJS Biome checks and documentation
  checks passed. Desktop production bundling passed after building the existing
  voice-runtime and plugin-devkit dependency outputs in this worktree. The
  existing large-chunk warning remains.

No full-suite release gate, installed-app acceptance, Windows/Linux native
acceptance, commit, push, PR or merge is claimed. No dependencies were installed.
