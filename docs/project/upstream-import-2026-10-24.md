# Selected upstream import design: 2026-10-24

## Status and provenance

Approved by the user on 2026-10-24 and implemented in the dedicated request
worktree. Scoped development validation passed; the macOS fullscreen-capture
probe has the environment limitation recorded below. No commit, push, merge,
installation or release was performed. The user selected sections I and II, not III.
The approved temporary delta is folded into the owning runtime/UX specs and their
maintained Chinese mirrors; this file is provenance, not a second contract.

- Source: https://github.com/vastsa/PI-Desktop.
- Reviewed source range:
  `9f313c8f855ef6f8311622ad63dd7e6583cef2d7..1a812ed7b84e0bd1b117080eb4e51c76eba35d48`.
- Refreshed Minih request base: `d5e9e3b00031238f0ea45ab40d38702c09a93f6d`.
- Request branch: `feat/upstream-selected-20261024`.
- Dedicated worktree: `.worktree/upstream-selected-20261024` under the main checkout.
- Complete imported baseline stays
  `0d235a91a7718c8b7c0b1b485dc603c2840d5645`.

This is reviewed content adaptation, never an upstream-history merge or a claim
that the whole range is imported. Preserve original contributors' attribution
through these source revisions:

| Source revisions | Selected content |
|---|---|
| `0eef9df3a`, `487b6fca8`, `4f6340acf` | Final latest-submission draft restoration, not three separate mechanisms |
| `1191e07f1` | Session task admission/deletion and shared Todo/task dock |
| `5b0f15c92` | Only the Gemini Live missing-close-reason production fix and its relevant regression |
| `b9ad8e68a` | Explicit per-model Chat Completions reasoning-effort override |
| `c3e0bbdad` | General Browser/BrowserPreview background execution and retained-page lifecycle |
| `96fafc854` | Optional-key inference for custom endpoints and staged key removal |
| `e0f713707`, `4517794ca` | Project crumb, inline local-title rename and empty-chat identity |
| `6c90bf427`, `ecd9ea9f6` | Turn-usage capsule with above-first placement |
| `c318a9721`, `26f9fdf6d` | Header hairline and bounded metadata, adapted to Minih process semantics |

Carry matching tests with their behavior, not as extra features. Exclude pure
extension updates and unrelated portions of mixed commits. Do not change upstream
checkout, monitoring configuration, release identity, model-catalog snapshot,
dependencies, running Desktop or user data. No commit, push, merge, packaging or
deployment is authorized by the migration request alone.

## Minimal implementation choices

Direct adaptation is sufficient. Reuse the existing ownership boundaries; do not
introduce a framework, general command registry, new tool, feature-flag system,
database abstraction or dependency. Preserve brand/package/channel/data/update
identity, Router routes, remote-workspace boundaries, side notes, subagent roster,
notification cards and current transcript density defaults.

1. **Send and Live fixes.** Add the final small draft-slot helper at the existing
   submit hook, and make close-reason decoding optional at the Live adapter.
   Keep existing guards and error semantics; do not transplant older intermediate
   race fixes or replace the draft controller.
2. **Task ownership.** Add per-session count/stop helpers to the registry and
   use the existing side-data cleanup convergence point. In Minih, all admission
   checks must precede spawn inside its lifecycle lock; retain `extra_env` and
   shutdown protection. Adapt the existing hook for one shared dock without
   regressing its session-switch cancellation or row/output behavior. The only
   resource-policy changes are the explicit 10-per-session and 64-total limits.
3. **Model settings.** Thread one optional tri-state field through the existing
   Shared/Rust/runtime/copy/sync chain. Place its UI in `ModelBindingFields`, not
   the upstream monolithic picker. Use per-model effective protocol. Retain the
   provider UUID/vendor identity rules, DeepSeek automatic defaults, Router
   selection/fallback and user-authored model settings. Do not replace
   `provider-presets.ts` or `provider-ipc.ts` wholesale.
4. **Browser lifetime.** Adapt the existing Main page owner and add one narrowly
   owned backing host. Separate background state publication from visible chrome.
   Keep the IPC addition additive and session-filtered; reject stale renderer
   restores. Existing Browser transport wiring may change only as needed for
   trusted session identity and this lifecycle, not unrelated API expansion.
   Amend the retained-browser-pages ADR rather than leaving reload/disposal rules
   contradictory; record the new page/presentation lifetime choice separately.
5. **Custom authentication.** Replace the custom-only mode toggle with effective
   key inference and staged removal. Reuse existing Host secret storage and
   no-auth handling. Named presets remain named presets; blank edits do not
   silently anonymize Minih Router or delete an existing key.
6. **Chat UI.** Use existing shared controls for inline rename, add usage
   composition beside current metadata, and adapt only header visuals. Preserve
   side-note access, localized errors, IME behavior, density/fold/narration/search
   semantics, issue indicators and main-pane geometry. No shimmer is introduced.

The optional binding field changes provider JSON, not SQL tables. Read existing
records normally and round-trip the new field. Older strict configuration
importers do not understand new-field exports; document that limit rather than
silently dropping the setting. Browser pages remain process memory, not a new
persisted DOM model. Native cross-platform behavior must be reported according to
what actually ran, with no macOS result relabeled as Windows/Linux verification.

## Development validation

Before fixes, add targeted regressions and demonstrate the relevant old failure
where practical. Test representative user paths through existing production
wiring, mocking only external edges. Reuse compatible host dependencies/caches
and isolate mutable profiles, ports, data and artifacts. Do not use paid APIs,
live accounts, user history or the running Desktop.

| Surface | Concrete development checks |
|---|---|
| Composer and Live | `node --test apps/desktop/test/composer-input-history.test.mjs apps/desktop/test/composer-send-state.test.mjs apps/desktop/test/composer-submit-race.test.mjs apps/desktop/test/live-voice-gemini-adapter.test.mjs`; rejected old send after newer success, slot reuse, session switch and missing close reason |
| Background tasks | `cargo test -p host-core --locked background_tasks` plus focused deletion-path and admission-before-spawn regressions; `node --test apps/desktop/test/background-tasks*.test.mjs`; task A/B isolation, deletion versus archive, collapsed tab selection, badge and refusal to hide live tasks |
| Provider settings | Runtime `provider-reasoning-effort.test.ts` and `provider-binding.test.ts`; Shared `provider-sync.test.ts`; `cargo test -p host-core --locked providers`; Desktop provider-copy, custom-provider-no-api-key and new model-field interaction cases; inspect actual local-fixture request bodies and save/cancel/key transitions |
| Browser and transcript | Existing `browser-host-session`, `browser-pane-navigation`, `browser-capture-resize`, `browser-cdp-deadline`, `browser-preview-tool`, `topbar-title-rendering`, `context-usage` and `turn-process` test files, plus focused new lifecycle/rename/capsule cases. Exercise real isolated Chromium page input/reload/retention and the modified UI with screenshots, including hidden background sessions and narrow layouts |

Build changed Shared, i18n and Agent Runtime packages before checking consumers;
build/typecheck Desktop and build the changed Host. Lint changed code with the
repository's installed linter. Add only scoped offline Electron/Host checks where
a real process, filesystem or IPC boundary cannot be proven by component tests.
Do not run `verify:ui:*` or attach to the user's app. Full-repository publication
gates belong to a later explicitly authorized commit/push/merge stage; do not add
that stage, broad review cycles or extra evidence-document scaffolding here.

## Documentation and completion

On approval, synchronize the owning specs, maintained translations and semantic
E2E scenario docs alongside implementation. Add the focused model override ADR
and browser lifecycle ADR and amend the existing turn-display record. Fold this
proposed delta into its owning specs when those changes are implemented, leaving
this source/design record as provenance rather than a second permanent contract.

Completion means the selected behaviors work in the request worktree and the
scoped development checks pass, with failed/skipped/environment-blocked checks
reported honestly. It does not mean main was updated, the app was installed, or
the complete upstream baseline advanced. Record actual results only after they
run. Preserve unrelated worktrees, branches and changes throughout.

## Executed development results (2026-10-24)

- Composer/Live: the production submit-hook race tests reproduced two old failures;
  the missing Gemini close-buffer test reproduced the old TypeError. The four
  focused files passed 34 tests after correction.
- Background registry: `cargo test -p host-core --locked background_tasks::tests`
  passed 10 tests, including missing-session and separate 10/64 pre-spawn refusal.
  The isolated real Host process probe passed permission/cancel refusal, ten-task
  bounded-output stress (202 MB produced), turn-abort survival, per-session limit,
  single/batch deletion, project removal, unrelated-owner survival and Stop/shutdown
  reaping. Its global-cap test uses registry fixtures rather than 64 real children.
- Model chain: Shared sync/protocol passed 60 tests; Runtime request-body/capability/
  binding/native-search passed 108; Host Provider passed 68. Copy passed 9 after
  reproducing and fixing loss of per-model `apiStyle` alongside the new parameter.
  Existing absent/null Rust records normalize to automatic behavior (None); no
  schema migration or claimed old-strict-importer compatibility is introduced.
- Provider UI: the focused settings suite passed 106 tests; final custom-key and
  advanced-capability tests passed 19. Real isolated Electron probes passed all
  28 English/Chinese cases and 850/1000/1400-width English/Chinese/German layouts,
  including optional-key inference, staged clear/cancel/replacement/failure and
  effective per-model protocol selection. Screenshots were captured.
- Browser: focused lifecycle/navigation/capture/preview/restore/wiring tests passed.
  The same-session sibling regression first reproduced an incorrect fallback;
  retaining the closed connection identity fixed it. The final three lifecycle
  files passed 34 tests. Real isolated Electron/Chromium background navigation,
  UID input/click, screenshot, collapse/reshow, renderer-reload recovery, closed
  target refusal and final backing-window disposal passed. Existing real-plugin
  forwarding/provider-catalog IPC tests passed 8 after local dependency builds.
- Chat: 22 focused files passed 205 tests; the final five added interaction/
  presentation files passed 24. Real isolated Chromium probes passed 60 process/
  usage assertions, eight dock interactions and title rename/IME/Escape/switch/error
  interactions. The standard task UI probe also passed at 1280, 700 and 390 widths.
  These exercise production components with external boundaries stubbed.
- i18n: nine languages' key/placeholder/renderer-copy checks passed 32 tests.
- Builds/checks: task-local Shared, i18n, Runtime and required consumer dependencies
  built; Desktop main/renderer typecheck and production build passed; the Host
  built from this worktree and its explicit binary ran the process probe. Changed
  covered files passed Biome lint; Rust format, style-token, architecture and
  `git diff --check` checks passed. Existing bundle-size warnings remain warnings.

### Environment and limits

Dependencies were referenced from the primary checkout without installation.
Task-local workspace-package links prevent consuming stale primary dist files.
Cargo caches were copy-on-write reused in the task target; Electron 43.6.0 was
extracted from its existing local cache into scratch without download/install.
All mutable profiles/data/ports/artifacts were isolated. No paid provider, user
profile, running Desktop or monitoring configuration was used or changed.

`scripts/e2e-browser-capture-resize.mjs` passed capture-0..11, maximize and restore,
but macOS's nonforeground fullscreen stage did not emit `enter-full-screen` and
hit its 30s deadline. This stage is environment-blocked, not reported as passing;
the lifecycle/background probe passed separately. Windows/Linux native behavior,
real accounts/audio hardware, `verify:ui:*`, full-repository publication gates,
commit/push/merge/packaging/deployment were not run. No upstream ancestry or
complete-import baseline was advanced.

Owning contracts: runtime IPC §13a, runtime provider schema/model selection,
tools/background tasks, Host RPC background tasks, Live Voice, UX settings,
component/interaction specs, semantic E2E scenarios and the focused lifecycle/
reasoning ADRs. The source snapshot and section III exclusions above remain fixed.

Final convergence: all 246 tests in the changed/new Desktop test files passed
after the same-session Browser fix and removal of the replaced BackgroundTasksBar
and its unused hook alias. Desktop typecheck/build, changed-file Biome lint,
targeted Rust format and `git diff --check` passed again. The standard task dock
probe and combined rename/process/usage probe passed on the final implementation.
Local documentation links resolve; the temporary behavior delta and its stale
references are removed. The request branch remains uncommitted at the base above.
