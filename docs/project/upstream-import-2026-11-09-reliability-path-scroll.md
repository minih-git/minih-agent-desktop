# Selected upstream reliability, paths, and scrolling: 2026-11-09

Status: selective content adaptation on `fix/upstream-small-path-scroll-20261108`,
started at Minih `33f07dc0b7194e04494d87a1936e99e28de8727e`, refreshed by a
commit-free fast-forward to `aa1023931fd4bc06a0119d1303104c27ee4e2085` before
final task-tree verification.
This is not an ancestry merge or a complete upstream import. The complete
imported baseline remains `0d235a91a7718c8b7c0b1b485dc603c2840d5645`.

Source: `vastsa/PI-Desktop`, reviewed interval
`b4430db052e85c4535ad8c919f9e3f7933b015dc..0eb607643d3199c6335eae236399623e07b57e3c`.
Only the user-selected reliability fixes, native project aliases and transcript
scrolling are adapted. Plugin changes, Pi upgrades, background job controls,
steering cancellation, agent mentions and Composer redesigns are excluded.

## Provenance and preserved boundaries

| Content | Upstream revisions | Minih adaptation |
| --- | --- | --- |
| Large Base64 images | `7120625b9ef4432f231d532a8223efff33703e44` | Flat alphabet and quantum validation; existing size and image checks remain. |
| Explicit output ceiling | `76ed6ca5e48cd49dbc1eeb1945254df59d95b2b3` | One repair shared with opaque-limit repair; preserve payload hooks and terminal quota/context errors. |
| Historical image budget | `bfc69c73ac2713dfc1b24436bb5ed72e03d4e031` | Charge only accepted pixel payloads, newest first; reads remain bounded. |
| Thinking in retained tails | `969c3c04b97ef8a2d38136daef12c3d414903acb` | Reserve answer text first; shortened thinking loses its signature, fitted/redacted blocks stay intact. |
| Terminal status envelopes | `11a0da8588757a3022bf96543b49a355c8eadc16`, classifier portion of `a28baea56615de884e5ed3328347b74be57a6b0d` | Leading DashScope status and Zhipu JSON code 1308; keep Pi 1.1, transport precedence and genuine rate-limit recovery. |
| Unexecuted text-form tool call | `18eb37ba43b9ac3e5b579c3cd52d902395194771` | Message diagnostic only; no prose execution, retry or structured sibling cancellation. |
| Stop restores typed input | smart-stop portion of `841b64461f9308a5985a6f82cc54f88b4a5effe9` | Prefer the stored `command` only when a submitted snapshot is absent. Keep session targets and current drafts. |
| Native project aliases | `b55628bf4415c0ebdadbc9c4ce4a5b1612c1084e`, `e89807ba0e0dabcae4a36ea523149871c74e522e` | Minih v29-to-v30, not upstream v27-to-v28; preserve keep-warm/archive tables, learned memory, remote identities and stored symlink ownership. |
| Adaptive history and content retention | `9eb23cb2b7e38ab53f73d285157d0baa6fabe81b` / `1283c8bd5c171289c4dc3a1e25d70cda24bb74f4` (one duplicate patch), `11fa50d372adb845f37b32a5a8fdd2abb187532b`, `dc3c29dee8abd56340ebeabff85191576808bcd5` | Preserve canonical tail freshness, actual-bottom sampling, remote opaque cursors, disclosure/search ownership and stateful Markdown. |
| Latest navigation and continuous history | merge contributions `0a25866a275eb9c941baaa8e2cc8745cbcbbb5fc`, `2d20113e3cb86a1eefa961e586dd20eee26a69a9` | Native smooth travel, interruption and late growth; view history never becomes model input. |

No provider preset, Router endpoint, application version, dependency version or
lockfile change is part of this request. Runtime metadata cannot be treated as
Minih Router billing data. User profiles and live/paid providers are not test
fixtures. The primary checkout and unrelated worktrees stay untouched.

## Pending release notes

- Large image results no longer fail in recursive Base64 validation. Explicit
  output caps and terminal provider envelopes recover or stop on the right path.
- Replayed images and retained thinking respect their actual context budgets.
  Literal tool-call text is identified without being executed.
- Stop can restore the original typed command after its local draft is gone.
- Native case aliases keep their sessions, schedules and memory when unified;
  a verified schema-v29 backup precedes v30. A historical symlink does not make
  project removal target a different stored project.
- History prefetch and readable anchors remain responsive through late layout;
  returning to latest retains continuous reading pages and stateful content.

## Verification

All checks use task-local output and synthetic fixtures. The old implementation
failed the added runtime, smart-stop and native-path cases before the fixes;
scroll regressions reproduced missing adaptive lead and discarded continuous
history. Additional review cases caught JSON code prefixes and compat thinking
signatures; both were corrected and rerun.

- Final runtime core: 8 files / 569 tests passed (large images, provider retries,
  errors, image history, retained thinking, text-call recognition and real local
  SSE runtime wiring). Adjacent compaction/provider suites also passed.
- Desktop transcript, remote-reader, observer cleanup, minimap and smart-stop: 220 tests
  passed. Shared error registry: 6 passed. i18n: 32 passed.
- Host database: 63 passed, including 11 new path/migration cases, fresh versus
  upgraded schema equality and v29 failure rollback/backup. Learned memory:
  43 passed; conversation archive: 21 passed; scheduled-project deletion: 2
  passed; the v19 queue upgrade: 1 passed. Case-sensitive native directory cases
  execute only where that filesystem supports them.
- Task-local Host build and `python3 scripts/e2e-project-path-case.py <task-host>`
  passed on macOS: v29 backup, v30, session/schedule/custom-data preservation,
  unchanged transcript bytes and scoped deletion. No user database was opened.
- `node scripts/e2e-transcript-reading-position.mjs` passed saved reading/follow,
  canonical-tail freshness, real SessionPane restoration/continuation and seven
  priority checks, including nonblocking paging, opposing row resizes, empty-page
  retry, interruptible native latest travel, hide intent and Review containment.
- `node scripts/e2e-transcript-prose.mjs` passed native pointer/wheel input,
  measured prose recycling, selection protection, code/HTML retention and
  hidden-pane state. Synthetic screenshots were captured and reviewed.
- Shared/i18n/runtime and Desktop dependencies compiled; Desktop typecheck and
  Electron/Vite build passed. Existing large-chunk warnings remain.
- Changed-file Biome `noUnusedVariables`: 52 files passed with the same rule in a
  scratch config, since the repository config excludes worktrees. Changed Rust
  formatting, architecture, Agent policy, documentation pairs/links and
  `git diff --check` passed.

After the safe refresh to `aa1023931`, the native minimap regression exposed a
reading anchor reacquiring ownership during explicit smooth navigation. The
scroll hook now hands it back only on real reader input; the failed journey
then passed with its clicked turn at 24px. The minimap test waits for native
`scrollend` and actual target geometry rather than three compositor frames.
`node scripts/e2e-transcript-minimap-jump.mjs` and the complete reading-position
journey were rerun successfully on the refreshed task tree.

The candidate is the uncommitted request tree based on the base above, not a
commit-specific landing candidate. Before push/merge it still needs the normal
integration gates. No commit, push, remote merge, release or installed-app upgrade
was performed. Windows/Linux native acceptance, real providers, full release
gates and a live user-profile migration were not run.
