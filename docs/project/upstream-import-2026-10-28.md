# Selected upstream capabilities: 2026-10-28 interval

## Scope and provenance

Approved for implementation on `feat/upstream-capabilities-20261028`, based on
Minih main `d7e1b6701b48d73a6960bd4a340a486932d590b0`. Implementation continued on
2026-10-29 in its dedicated worktree. Source repository:
https://github.com/vastsa/PI-Desktop; reviewed interval:
`f34d36a27940066d2b00014b6942e37d10f9eda1..68868dfc8f7d040481ba2432c2178399386d2a9d`.

This is selective content adaptation, not an ancestry merge or complete import.
The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. Monitoring checkpoints mean analyzed,
not imported; this implementation does not advance them.

| Upstream source | Selected content | Upstream author |
|---|---|---|
| `e8f413bcaf802146cc689b5c9e8b6e78f9aefbf3` | Final exhausted billing quota classification | vastsa |
| `fe31fa13da3815fb6a08a56fcf167ba54ba46d86` | Real DeepSeek reasoning field and leading placeholder echo | vastsa |
| `051aceff7e25a39e43073d64c298a9179e806fa2` | Malformed tool-call recovery | Linuxdazhao |
| `49f23668d7c770446f1783422d3e9a15cf22079b` | Image geometry admission across fresh and restored input | vastsa |
| `2bee85715a017aee23ba509ba8e1891548fc25fa` | Lexically normalized path-lock keys | xpeng5278-web |
| `605d413fc6d0147e8e198c0a941af0bdbfeb7f4b` | Incremental UTF-8 file-index decoding | FuYukiH |
| `c0b3c2bead294e8243f029ad6c7230398232ec38` | Orphan delegate tool-result projection | xpeng5278-web |
| `eb740b1677d842f81c3c16111b32d70dc55c034a` | UTF-16-safe Bash progress bound | xpeng5278-web |
| `69fba162eb93fcb9679aad65e966f04379589a75` | Persist follow intent before smooth scrolling | new-Beginner |
| `47f38b7669099b3a50e04b4f8ea3f47593fe6b1f` | Revision-root acknowledgement without old-message replay | Seraph Zero |
| `ea0289edb0b30ff12d1b142686da792a2aa3193f` | Running state after renderer recreation | FuYukiH |
| `5dfa023d8881f00da1d608cd40994e72e756d9ee` | Empty-draft queued steering shortcut | wojiecihuo |
| `feaf61ad2d4278d7a9dbfaae3d9c1ffc26b88b60` | Provider row busy guards only | Liu Zixiang |
| `f3e5cc310e1b53888357c425faa50d19a9d2c164` | Required generic row-guard helpers only | liuzixiang |
| `73b714ed28065b0ba0af6a22ad5648d312011fa0` | Per-turn changed files linked to existing Review | vastsa |

The complete storage group below is adapted to its final net semantics, not its
intermediate optimistic-deletion behavior. Original authorship is retained here;
no upstream commit graph is attached to Minih main.

| Storage source (all authored by Seraph-x) | Purpose |
|---|---|
| `ea9e4c214d7065abd441d2a321d1eb0d855ccd17` | Lossless outbox codec |
| `e9e7e7f350bd4ae4fb50824c9702a48cf7c8cf91` | Host ID history mutation |
| `1dc4c0639c18020ab5b651f843db356c490c3615` | Desktop ID wiring and canonical revision prefix |
| `6c920c79dad5f3d043dab52c7b40d026ec6d90b6` | Preserve local-only remote guards |
| `0fbb0ce129d15d18524e87919333f30867fd350b` | Serialize consecutive deletes |
| `f2b48b4b385ef38de81aa5b89547e72fd64523da` | Preserve writes on strict mutation drains |
| `cc061220ca4b255775738e0bee0d1f03145ae72b` | Nested exact text mirrors |
| `ba51b924d8e50596c6ec83d9dd8fd5df654492b9` | Host self-contained binary storage and version gate |
| `2549e596e7d1d4c08ce78d13c94e1136393b626b` | No-change deletion handling, superseded by final confirmation flow |
| `b7736c6ac4956651f72f146af4a558e4cf324f54` | File-generation integrity before mutation |
| `0a7e65530b447474a5f9ab03b79974bac361190e` | Corruption and cross-platform regression coverage |
| `7ce7a1fe47ee5a4f2000f4052db61bf7959cdb4b` | Change deletion projections only after Host confirmation |

## Minih adaptation boundaries

- Preserve Minih brands, package names, Router presets/endpoint selection,
  permissions, sequential tool execution, side notes and retained reading windows.
- Keep Pi 1.1.0 and the existing compatibility patch set. Exclude Pi 1.4.0,
  Fast, completion scroll-to-question, GenUI, Windows process-tree changes,
  plugin features, native tab menus and unrelated test/release maintenance.
- Provider guards apply to `OtherProvidersSection`, not the Router-owned
  `ModelConfigPage`. Generic guard helpers are the sole earlier-checkpoint
  dependency; the previous capability-page changes are not imported.
- Keep automatic disclosure and user choices. Review navigation uses its existing
  one-time reveal mechanism. A selected older reading-window record is carried
  only as transient read-only evidence, scoped to its session; current live rows
  win, and no transcript cache or persisted history is rewritten for navigation.
- Minih's v25-to-v26 learned-memory migration is retained. The storage format gate
  appends v26-to-v27, with backup and old-binary rejection. The Host RPC 64 MiB
  ceiling and legacy full-upload APIs remain unchanged. Rollback needs the full
  pre-upgrade profile backup, not a manual version-number downgrade.
- No real profile, paid provider, production Host or running user Desktop is a
  test environment. No release, installation, Git commit, push or merge is implied.

## Development verification

All results below are local candidate checks, not upstream reports or release
acceptance. The candidate base and refreshed `origin/main` are both
`d7e1b6701b48d73a6960bd4a340a486932d590b0`; no task commit was created.
Executable-input fingerprint (118 modified/new inputs; docs/build output excluded):
`sha256:6a0eacdd2f5e4ecbd4e837917de293648f169320cc61e3848048340e559fdcf8`.

- Reproduced pre-fix failures for multibyte index chunks, tall fresh attachments,
  revision-root replay, missing running bootstrap/list snapshots, placeholder
  visibility and mixed DeepSeek replay fields. The reading E2E's
  `--baseline-follow` control loaded the fixed base hook in memory and failed
  specifically on synchronous follow intent; current code passed all three
  reading/retention/continuation probes without modifying baseline source.
- Affected workspace dependency builds and Desktop typecheck passed. The new
  card/provider interaction fixture also passed its own strict typecheck.
  Production Desktop build passed with the existing large-chunk warning.
- Runtime: 113 files / 1608 tests passed against the task-private updated Pi
  patch. Shared: 136 files / 1722 tests passed (the existing configuration runs
  source and emitted-artifact copies). Host Runtime codec/index: 38 tests passed;
  i18n key/catalog/copy checks: 32 passed.
- Desktop: 148 targeted tests passed, covering real store/API/preload/IPC history
  wiring, more-than-64-MiB retained history, outbox strict-drain failures,
  concurrent deletion/late events, revision projection, bootstrap races, queue
  submit, provider guards and completed-turn rendering.
- Host: 62 affected binary-storage, generation, migration, history-mutation,
  relocation and image-Read tests passed. The strengthened four migration tests
  compare nonempty learned entries, tombstones, cursor/lease state and FTS rows
  against both the original and schema-26 backup. The exact legacy v25 learned
  migration test also passed after updating its final-version assertion to 27;
  the v25-to-v26 step itself remains unchanged. An initial unmatched memory
  filter ran zero tests and is not counted as passing coverage.
- `e2e-tool-result-persistence.mjs` passed using the explicitly built candidate
  `minih-agent-desktop-host-core` binary and disposable profiles. It covered 35
  deterministic screenshots (98,989,920-byte old upload, 24,843,724-byte encoded
  storage), restart, exact payload restoration, canonical revision activation,
  deletion/retraction/fork, a 67,114,080-byte unique-image history (95 images;
  largest ID mutation 182 bytes), nested TS/Rust mirrors and copied-profile
  relocation. These are fixture storage/wire measurements, not latency claims.
- Isolated Electron interaction passed in English/zh-CN at 320/900px: production
  card and Review navigation, older reading-window evidence, manual collapse and
  repeated reveal, local/remote session isolation and two real provider rows
  settling independently. The final fixture explicitly loads the production
  lazy ChatSurface/Settings CSS and asserts tile styling and >=24px row targets;
  the first main-CSS-only run is not accepted as layout evidence. Screenshots
  are session-scratch `turn-changes-{en,zh-CN}-{320,900}.png` (dark theme).
  `e2e-running-session-reopen.mjs` passed two live-window recreations and an idle
  recreation with real Sidebar selection and screenshots.
- All 83 Pi patch hunks have valid counts; mapped/locked/installed patch checks,
  style tokens, architecture and whitespace checks passed. Rust formatting was
  applied only to changed Rust files, then checked. Documentation locale/page
  checks and all 13 documentation tests passed.

## Verification limits and environment recovery

- Changed-file unused-variable lint checked 92 files: only the pre-existing
  `checkpoint` variable in `runtime.test.ts:11669` failed. Linting the unchanged
  base snapshot reproduced the same error at line 11515; the other 91 files
  passed. The existing error is preserved, so the whole lint run is not green.
- The initial pnpm build command tried automatic dependency reconciliation and
  aborted on the reused symlink layout. Its temporary primary importer-link
  changes were restored. Builds then called installed tools directly. Only the
  changed Pi dependency was copied to task-private, non-hardlinked instances;
  other dependencies/caches remain reused. The original primary Pi package
  contents remain unchanged. Updated compiled replay logic exactly matches the
  new patch and passed the previously failing regressions; no dependency-version
  upgrade or second full runtime environment was introduced.
- An exploratory full Host run was interrupted and is not a passing full-suite
  result. The scoped affected Host tests and actual storage user path above are
  the accepted local evidence. Full monorepo/CI, Windows/Linux native behavior,
  real paid providers and user-profile upgrade/rollback were not accepted or run
  as this task's gates.
- The primary checkout retains only its pre-existing iOS `Package.resolved`
  modification. Main, the independent-history baseline and the automation
  checkpoint are unchanged. No Git commit, staging, push, merge, release,
  installation or user-data migration was performed.
