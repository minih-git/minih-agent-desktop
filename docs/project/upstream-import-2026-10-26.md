# Selected upstream reliability fixes: 2026-10-26

## Scope and provenance

Approved for content adaptation on 2026-10-26. Request branch:
`fix/upstream-selected-20261026`; base:
`eb2c9251f0ab06e89e2c0384615c657c87b9825e`.

Source: https://github.com/vastsa/PI-Desktop, reviewed interval
`d2c9fc44087f24260521c66530c4f92c04790105..c099b6a4cdb4dcdc3bf467432e36af10fde77080`.
This is a selective content import, not an ancestry merge or a complete import.
The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. Daily monitoring checkpoints
mean analyzed, not imported, and are not advanced by this implementation.

| Source revision | Selected non-plugin content | Upstream author |
|---|---|---|
| `b8748f2ebcb18392734aeadbbe74c9a9d343a37c` | Connection/stream abort wording stays retryable, not user Stop | xpeng5278-web |
| `c5e53d30258fc8c071aaa6f2eb7134ef0baafaf2` | TLS authentication wording stays transport, not an API-key rejection | xpeng5278-web |
| `9944b39943ebca76bf92bb3cbbf3f5dffe8b5112` | Restore MCP text resources and resource links from persisted content | xpeng5278-web |
| `94061cd4503b03ae16efa2fd039e20144cfcf2ac` | Scale the mode-chip reservation with appearance typography | Liu Zixiang |
| `7a95fd08a1bfd6f0b711c6ea6c5f6bd0f4832ef7` | Cache file-derived native session list projections | iced |
| `c099b6a4cdb4dcdc3bf467432e36af10fde77080` | Protect ambiguous historical v22 titles during future upgrades | ShawTim |

Original contributor attribution is retained through these exact source revisions;
Lan is additionally credited in the upstream resource/TLS/title commits. Only
actual changed content is imported, not unrelated history repeated in commit bodies.
Plugin-only changes, plugin-specific result-array restoration and title assertions,
release metadata and version changes are excluded.

## Adaptation boundaries

- Preserve Minih package names, brand, Router routing/presets and custom runtime
  behavior. No upstream history graph, remote provider or permission change.
- Actual structured cancellation and fixed Stop phrases still terminate; socket
  and stream failures use existing bounded retry. Explicit 401/403, credential
  rejection and recognized certificate verification failures remain terminal.
- MCP history reuses the existing live `hostContentBlockText` helper. Preserve
  images, replay call identity, tool activation/details and interrupted/error
  semantics; binary resource bytes are not decoded into text.
- Native list caches only canonical-path/device/inode/size/mtime file facts.
  Live trust, cwd, provider/auth and ownership are recomputed. Existing single-root
  containment, duplicate ordering, prompt/fork and full-byte write guards remain.
  Lazy snapshot acquisition lives in the existing Minih lease owner, retaining
  `.minih-agent-desktop.lock`; no upstream lock-name fast path is copied. A missing
  target under an existing lease is not mistaken for an absent lock. Removed
  files, missing roots and disposal prune cached projections. No latency gain is
  claimed without measurements.
- Future v22→v23 migrations retain historical titles as `legacy`, including old
  untouched placeholders, rather than guessing provenance. This deliberately
  protects same-text manual renames at the cost of leaving old placeholders
  unchanged. Existing v23+ rows are not reclassified; new/default and manual
  title behavior, backups, schema 26 and later migration steps remain intact.
- Mode-chip width/min/max/flex scale together; existing mode/menu/permission,
  animation and Composer behavior remain unchanged.

## Development verification

- Before production adaptation, the focused Runtime regression baseline produced
  9 failures (transport abort/TLS classification, MCP resources and cache reuse).
  The changed Composer reservation assertion also failed against fixed 96px CSS.
  The real v22 migration regression failed against the old title heuristic.
- Final focused Runtime suites: 513 passed across error classification, provider
  retry, runtime history/public prompt wiring, native files and new regressions.
  Shared and Runtime builds passed; task-local Agent Host/Host Runtime dependencies
  were built before downstream verification.
- Desktop Composer/native routing tests: 26 passed after the required dependency
  build. The first native IPC run lacked Host Runtime build output; it was not
  accepted as a code regression or reported as passing.
- Parent-agent Rust verification: all 47 database migration tests passed with an
  isolated canonical TMPDIR; the v23+ manual-placeholder regression also passed.
  Fixtures use temporary databases only, never the user's database.
- Style-token, architecture and whitespace checks passed.
- The production Desktop build passed with existing chunk-size warnings. An
  isolated Electron/Chromium regression used the production `ComposerModePicker`,
  actual English/zh-CN catalogs and this worktree's built stylesheet: 12 combinations
  of 450/900px width and 100%/115%/150% font scale, 36 menu selections, no clipped
  labels, stable adjacent geometry and no fixture-toolbar overflow. An in-memory
  old-96px negative control was rejected. Six screenshots were retained under the
  session scratch `composer-mode-font-9Bihc6/`; no user app/profile was opened.
  Repeat with `node --test apps/desktop/test/composer-mode-font-scale.e2e.mjs`
  after building the task Desktop. This is a focused picker fixture, not a full
  Composer/physical-input acceptance claim.
- Documentation locale/page checks and all 13 documentation tests passed after
  synchronizing the Chinese traceability row and font-width description.
- The Rust delegate additionally reported 13 title tests, rustfmt and clippy
  passing; its exploratory full suite had 1187 passed, 1 ignored and one existing
  data-relocation failure under the default macOS temporary-path spelling. The
  parent independently reran that exact failing test with canonical isolated
  TMPDIR and it passed. The default-path full suite is not reported as green;
  no unrelated data-relocation fix or user-database operation was performed.

The initial implementation ended without committing or publishing. The user
subsequently authorized commit, push and main integration on 2026-10-26; Git
and the corresponding pull request record that delivery. Installation, release
and deployment remain outside that authorization. The complete upstream import
baseline is unchanged.

## Final verification closure

- Desktop typecheck and the new UI fixture typecheck passed. The final combined
  Desktop run passed 27 tests, including the isolated Electron interaction; its
  screenshots are under session scratch `composer-mode-font-HNH4t2/`.
- Strengthened native replacement coverage proves size and mtime are identical
  while inode changes; all 45 native tests passed after that assertion was added.
- Changed-file lint using the repository's unused-variable rule passed for nine
  files. The tenth, `runtime.test.ts`, reports exactly one pre-existing unused
  `checkpoint` variable (baseline line 11487, current line 11515), independently
  reproduced by linting the unchanged base content. No unrelated cleanup was made.
  Therefore the ten-file lint run is not labeled green.
- Final Runtime build, Desktop build/typecheck, style tokens, architecture,
  Rust changed-file formatting, docs locale/page checks, 13 docs tests and
  `git diff --check` passed. The primary checkout's existing iOS lockfile change
  remains untouched. The initial development stage did not commit, push,
  integrate or deploy; the subsequent authorized delivery is recorded separately.
