# Selected upstream fixes: 2026-10-29 interval

## Scope and provenance

Implemented on 2026-10-30 in the dedicated `fix/upstream-selected-20261029`
worktree, based on Minih `origin/main`
`9fb56ff2e4d4c70ae78f6b7e413b4b8ec4924573`. The approved scope is the first
batch of five fix groups from the 2026-10-29 upstream analysis. Source repository:
https://github.com/vastsa/PI-Desktop; reviewed interval:
`68868dfc8f7d040481ba2432c2178399386d2a9d..454cca2e149eabf85cbba516bb6a11de5f19780e`.

This is selective content adaptation, not an ancestry merge or complete import.
The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. The monitoring checkpoint means
analyzed, not imported; implementation does not change it. Initial implementation
did not include Git delivery. The user separately authorized commit, push and
integration into Minih main on 2026-10-30; release, installation and user-profile
migration remain outside that authorization.

| Upstream source | Selected content | Upstream author |
| --- | --- | --- |
| `25bca249dc0989f105b413029ed3784b286c5900` | Checkpoint writes remain tracked across settlement and shutdown | FuYukiH |
| `915f636dfeb8b52dd1fefbfc1ec073a66eab2ad2` | Normalize the empty-draft IME slash alias only after composition commits | Xuese |
| `8b320b4eb278e256d7471081ad18629073029b0e` | Explicit MCP Market installation owner and destination-scoped badges | Linuxdazhao |
| `d3ba191d501219e4bb4150b25c2cf1feabc5d773` | Reader input cancels browser-owned smooth navigation | Seraph-x |
| `5fac167743a07dba9953dc45aa55fc0cbea19b0a` | Preserve control-key and nested-scroll ownership | Seraph-x |
| `bf38d53721a8b767bb03aa7915e92b9883a1bee3` | Disclosure takeover retires old smooth navigation | Seraph-x |
| `6a0855bbd7a4680fb17c34e8ffcce7d9a0d754bd` | Keep a non-tail running turn active | yu.xia |
| `e3a22e7120ec6aab11bd7618e5ffe35c998e6311` | Stop live-turn selection at an ordinary user boundary | yu.xia |
| `bc4cfbf7a18997da3d36e7d3df3fb27ae0ce7cf1` | Keep system rows inside the current live-turn walk | yu.xia |

## Minih adaptation boundaries

- Preserve Minih branding, Router presets, Pi 1.1.0 and its compatibility patches,
  permissions, side notes, `#` conversation completion and remote attachment guards.
- Checkpoint repair stays in the shared Host Runtime class used by Desktop and
  headless event persistence. Issued writes outlive pending-state settlement;
  same-session writes remain serial and message identity bounds settlement/flush.
  No IPC, protocol, database schema or storage-format change is introduced.
- IME pre-edit text is not repainted. Only a composition begun in an empty draft
  may apply the leading alias on commit; draft replacement releases its origin.
  Existing lost-compositionend recovery remains covered.
- MCP Project installation requires the selected project. All/Global remain global,
  and installation badges only describe that destination. No missing-project fallback
  writes into global configuration. Existing localized errors and API ownership stay.
- Main and delegated transcript scrollers cancel smooth navigation only after
  input ownership is established. Button Space, select/editable keys and nested
  gestures keep their owner. Explicit disclosure choices, density and reading
  bookmarks/continuation remain unchanged. Completion does not navigate to a prompt.
- Non-tail liveness crosses steering side notes and system rows, but not an
  ordinary user-message boundary. Historical reading windows do not activate
  old streaming rows. No new turn-outcome header or idle/unsettled label is imported.
- Provider signature replay, append-only Review storage, radial menus, Windows
  process-tree handling, plugins and unrelated upstream features are excluded.

## Development verification

These are local candidate checks against the base above, not release acceptance
or an upstream test claim. Tests use isolated profiles/files and
controlled provider/IPC boundaries; no user Desktop, real profile or paid model
service is used.

- Before production edits, the new checkpoint lifecycle suite reproduced five
  failures; MCP installation failed because Project wrote to Global; native
  Chromium IME composition failed because pre-edit `、` was rewritten to `/`.
  Transcript regressions reproduced seven failures and the disclosure browser
  probe reproduced an old navigation moving the manually toggled title.
- Checkpoint unit suites: 15 passed. Host Runtime event/persistence/runtime-service
  suites: 23 passed. Combined Composer/MCP/checkpoint suites: 47 passed, including
  the destination-owner user path (checkpoint tests overlap the 15 above).
- Transcript row, scroll, disclosure, density, projection and summary suites:
  92 passed. The final focused rerun of row/scroll/disclosure suites passed 65
  tests (overlapping the 92).
- The checkpoint child-process probe passed: held write survives transport
  shutdown/restart, old/new same-session writes remain serial and a separate
  session progresses while the first is held. It exercises real HostProcess
  stdio transport/event pipeline with a controlled Node peer, not Rust Host.
- Isolated Electron native-composition probe passed, including cancellation,
  nonempty punctuation, replacement-draft origins and missing compositionend.
  Market owner and market retry probes passed. Adjacent Composer paste/attachment
  and history-restart probes passed after updating their existing callback/state
  fixtures to current production contracts. Deep-file-search user-path regression
  passed, preserving Minih conversation completion.
- Isolated Electron transcript disclosure/scroll takeover, comprehensive rendering
  and retained reading-position probes passed. Main and nested interruption
  offsets stayed 424.5 and 244.5 respectively; the live-turn visual probe retained
  `turn-process open active`, expanded state and the activity marker. Screenshots
  are session-scratch `composer-ime-final.png` and
  `transcript-scroll-live-turn-probe.png`; no screenshot is added to the repository.
- Affected workspace TypeScript builds, Desktop typecheck and production Desktop
  build passed. The build retains the existing large-chunk warning. Changed-file
  unused-variable lint checked 32 source/test files with no fixes; architecture,
  style-token and whitespace checks passed. English/Chinese documentation pair
  and page checks passed.

## Environment and verification limits

- Reused the primary checkout's third-party dependencies without an install. pnpm
  refused symlinked task-state directories, so installed tools were called directly.
  Primary workspace aliases included stale links to a removed worktree; only the
  task-local dependency link layers were replaced, pointing internal packages to
  this candidate. Build outputs stay task-local. Primary dependency links remain
  unchanged.
- Two initial Desktop build attempts failed because of the invocation directory
  and missing local DevKit output. Corrected directory/dependency builds and the
  final production build passed. Initial lint command/option errors were corrected
  before the successful changed-file run; these failed attempts are not passes.
- Release packaging, Windows/Linux native behavior, OS-level physical IME
  candidate windows, real providers and installed-application acceptance were
  not run locally. No Rust production code or migration changed.
- The primary checkout remains on main with its pre-existing iOS
  `Package.resolved` modification preserved. Delivery must not stage that file,
  generated artifacts, dependency links or unrelated work.

## Pre-delivery verification (2026-10-30)

- Refreshed fork `origin/main`: still the base above. The source diff contains
  only the approved five fix groups, their regressions, specifications and
  provenance; no upstream commit history is attached.
- All nine workspace package builds, all four app typechecks, repository lint,
  style tokens, architecture, agent policy, contrast/patch/pre-push unit checks,
  Rust formatting and whitespace checks passed using installed tools directly.
  The pnpm wrapper remains incompatible with reused dependency symlinks; no
  dependency installation or shared directory rewrite was performed.
- Full local JavaScript suites passed: shared 1722, i18n 32, SDK 396, DevKit 52,
  Agent Host 99, RACP 193, Voice Runtime 52, Agent Runtime 1608, Host Runtime 233,
  Host CLI 82 (one skipped), Gateway 238, Remote Web 1029, Desktop 5042 (three
  platform skips). Shared/SDK counts include configured emitted-artifact copies.
- Gateway initially failed because the long session-scratch path exceeded macOS
  Unix-socket limits. A short temporary alias to scratch made all 238 pass; the
  alias was removed afterward. Production paths and guards were unchanged.
- Post-commit task-candidate E2E and remote PR integration gates are separate
  delivery stages; the PR records their actual tested revisions and results.
