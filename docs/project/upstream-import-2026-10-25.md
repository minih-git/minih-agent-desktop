# Selected upstream fixes: 2026-10-25

## Scope and provenance

Approved for implementation on 2026-10-25. Request branch:
`fix/upstream-fixes-20261025`; base:
`f407caa716f80db36639f8cc38edb870684d76ae`. The user subsequently authorized
commit, push and integration into main. Git and the corresponding pull request
record that delivery; this provenance record does not imply installation or release.

Source: vastsa/PI-Desktop, reviewed range
`1a812ed7b84e0bd1b117080eb4e51c76eba35d48..d2c9fc44087f24260521c66530c4f92c04790105`.
Preserve original contributors' attribution through these revisions:

| Source revision | Selected content |
|---|---|
| `8e8b99ee36bcdb3b0253641e492eafe79a31c4f9` | Official DeepSeek effort defaults and precise hostname matching |
| `67ce4fa660184491f0e9a3fe7a631809e083aad3` | Bounded automatic continuation of restored reading ranges |
| `76d1141994d0d31ca7266465ca927b7591d353c9` | Retained page restoration without narrowing or overriding navigation |
| `6e6f86244e9ce3621fd76834de6efcef411e8018` | Transient reading protection, local disclosure choices and group defaults |
| `672ed35e3f2a166b7c4c275d059e500ada27c0b9` | Container-wide task-dock collapse across sessions, initially collapsed |
| `45412281f7026c6ecb27d5ae748642d886d9f72e` | Accessible inline saved-key removal icon |

This is reviewed content adaptation, not an ancestry merge or full import. The
complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. The daily monitoring checkpoint
means analyzed, not imported, and is not modified by this implementation.

Exclude all extension-specific content, the upstream release/version/changelog
bundle and model snapshot refresh. Minih's brand, package identities, version
1.0.0, Router preset/route/fallback and user-authored model settings remain.

## Adaptation boundaries

- DeepSeek's official hostname is parsed. Relays, including Minih Router, keep
  effort suppression and nonempty replay defaults; explicit per-model saved
  booleans still win. No Router IPC or transport rewrite.
- Reading continuation uses local physical pages only. Preserve remote opaque
  cursors and their forward-read refusal, canonical-tail bookmark staleness,
  selection quoting, navigation priority, cancellation and model-input isolation.
- Keep compact/standard/detailed item defaults, narration, standalone Bash rows,
  topology and explicit choices across pane eviction. Reading focus/selection is
  transient; global listeners are removed after the final subscriber unmounts.
- Keep task output cancellation, session-owned polling/visibility/badges and
  process ownership. Only the container expansion is shared across sessions.
- Key removal remains staged until Save; blank edits/cancel preserve the key,
  replacement wins, and named/relocatable Router fields are unchanged.

## Development verification

- Red baseline: Shared provider assertions reproduced 8 failures, Runtime
  official-default assertions reproduced 2 failures, and reading assertions
  reproduced 4 failures. UI subset regressions separately reproduced old
  folding/dock/key-layout behavior before production adaptation.
- Final Shared provider/Router tests: 55 passed. Runtime provider-binding and
  effort tests: 88 passed, covering low/high/max/off, explicit send/omit, unchanged
  Responses/Anthropic behavior and Minih Router relay defaults.
- Final focused Desktop suite: 160 passed, including reading, disclosure, folding,
  background tasks, custom credentials, search, summaries and turn-process behavior.
  The final three suites total 303 passing tests, no failures or skips.
- Style-token, architecture and whitespace checks passed. Explicit changed-file
  lint passed for 31 files; the already-excluded thinking-ui test has three
  pre-existing unused-variable diagnostics confirmed in the base revision.
  No unrelated cleanup was performed. Newly added documentation links resolve;
  apparent missing links in the existing E2E plan are literal test-message examples.
- Task-local workspace dependencies were built before consumer verification.
  Runtime build, Desktop typecheck and production build passed. Existing bundle
  size warnings remain warnings.
- Real isolated macOS Electron/Chromium: transcript rendering (46 new automatic
  folding checks plus existing density/search/task paths), task dock at
  1280/700/390 widths, 28 English/Chinese provider journeys, and reading
  retention/continuation/search/cleanup probes passed. Reading and task screenshots
  were captured. These fixtures stub external IPC/provider boundaries.
- Reading UI waits for stable latest-projection geometry before a subsequent
  disclosure; the older scenario also passed independently against current code.
  Provider geometry uses the actual built stylesheet, not an unstyled button.

Development did not install dependencies, call paid APIs, use live credentials
or the user Desktop/profile, mutate Host persistence, or run Windows/Linux native
checks. Packaging, installation and deployment remain outside delivery scope.

## Authorized delivery checks

- Every workspace package plus CLI/Gateway compiled, and all package/application
  typechecks passed. Desktop, remote-web and documentation bundles passed.
- Full local JavaScript suites passed, including 4,920 Desktop tests (three
  platform-specific skips), 1,528 Runtime tests, 1,646 Shared tests and the other
  workspace suites. CLI has one platform-specific skip. Documentation checks and
  all 13 documentation tests passed after synchronizing the Chinese traceability
  row; the legacy clear-key text assertion now checks the accessible icon.
- Repository-configured lint explicitly checked 406 files and passed. Agent policy,
  style tokens, contrast (68 checks), patch/pre-push regressions (37 tests), Rust
  formatting and whitespace checks passed. Architecture and task-candidate UI
  results are tied to the delivered candidate through Git and the pull request.
- The optional standard pre-push wrapper cannot use the reused `.pnpm` symlink
  because pnpm refuses a non-real hoist directory. Its corresponding builds and
  checks ran directly with task-local workspace resolution instead; only this
  optional wrapper is explicitly bypassed for the branch push. Remote CI and
  branch protection are not bypassed. Rust lint/tests and cross-platform results
  are reported by remote CI, not relabeled as local verification.
