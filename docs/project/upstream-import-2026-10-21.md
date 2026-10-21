# Selected upstream reliability import: 2026-10-21

## Design and provenance

Source: https://github.com/vastsa/PI-Desktop. This is a reviewed content import,
not an ancestry merge. The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. Original contributors retain credit.
The request starts from Minih main `b68970e7f9f5f104e91f71e67872159c85daf231`.

| Source revision | Selected content |
|---|---|
| `77a706acb38be02e175d9f0557f2c80d455966c9` | Main and subagent retries accept transcripts whose failed assistant was already compacted away |
| `2fb3deb4d3920a4c698a193bb65456096b7a7d43` | Keep the active work-panel tab close action visible |
| `16802b225e81b0be549457658ff25035ca5f6fc8` | Only the empty quoted prompt-template argument parser fix; no Pi dependency upgrade |
| `9a69e1d8863bbb94e0bb7d930b13a26bf460864d` | Optional client-certificate compatibility for provider metadata probes |
| `494b5f7c8f908aaf1f04bd5e86572dd32ec15167` | Final macOS translucency preference after `0463abdb9`, `e144b8e6d`, and `1d6dbd988`; preserve default translucency |

## Minimal implementation and preserved invariants

- Reuse `removeTrailingAssistantMessages` for both retry paths. Keep retry
  budgets, cancellation, fallback routing, visible transcripts, usage and
  compaction ownership unchanged. No runtime refactor is needed.
- Preserve empty quoted argument tokens without changing other template syntax.
- Scroll the active tab and its close action into the existing tab-strip viewport;
  preserve session scoping, sidebar width loans, roster and side-note controls.
- Retry only the exact optional-client-certificate failure for replayable HTTPS
  GET/OPTIONS metadata, once. Retain proxy routing, TLS/hostname verification,
  same-origin redirect guards, cancellation and observable failures. Never replay
  agent turns or broaden generic TLS error handling.
- Add an optional macOS boolean setting: absent/true keeps the shipped glass;
  false creates an opaque main window on the next launch. Read it before window
  creation, report the applied surface, and show a pending-restart hint only
  when the stored preference differs. Other platforms remain unchanged. Use
  existing settings persistence and UI primitives; no database schema migration.
- Preserve Minih branding, package/channel/data/update identities, Minih Router
  protocol/endpoint selection, LAN/public fallback, remote connections, existing
  dependency versions and compatibility patches. Exclude plugin-only changes,
  native Pi session discovery, Pi auth import and OpenCode-specific routing.

## Acceptance plan

Add failing regressions before fixes where practical, then rerun them green.
Cover both compacted retry paths, empty quote positional arguments, overflowing
active-tab close visibility, exact certificate fallback/error/cancel boundaries,
and macOS default/opt-out, restart, theme and non-macOS behavior. Exercise real
production wiring with only external edges mocked. Run affected unit/contract
suites, JS builds/typechecks, lint/architecture/doc guards and isolated browser
or Electron user paths with screenshots. Reuse host dependencies; keep mutable
profiles and artifacts isolated. Do not use the running user app or paid APIs.
GPU savings require a controlled native measurement; upstream numbers are not
local evidence and no saving is claimed by merely adding the switch.

## Validation status

Local implementation and main-agent review are complete. The validation
snapshot below was recorded at the initial handoff, before staging, commit,
push or PR creation. It is historical evidence, not the current Git status.
The follow-up request authorizes commit, push and a PR, but not merge, release
or deployment. Publication and refreshed-candidate results belong in the PR.

### Initial candidate identity

- Branch: `fix/upstream-reliability-20261021`.
- Starting base: `b68970e7f9f5f104e91f71e67872159c85daf231`.
- Final prepared base: `1e8231f0b46bf248e4e38a77af7accfd2c9b642a`.
- At the initial handoff the branch contained an uncommitted working diff,
  not a tested task commit.
- Working-code SHA-256: `a17729bedab3b4da483a39329581330b6e5209c85aa7098b9a050408d17f1da3`.
  This hashes each sorted changed/non-ignored-untracked non-document path,
  then NUL, its bytes, then NUL (47 files). It excludes this record.
- The final fast-forward from `46a9f9147083` changed only remote-web code and
  its own E2E fixture, not any tested Desktop/runtime input. The new UI and
  certificate E2Es were rerun after that fast-forward. The PR-base check passed
  at preparation. No PR integration candidate was created.

### Verified results

| Check | Result |
|---|---|
| Added runtime regressions on old implementation | 5 assertions fail; fixed scoped suite passes 391/391 |
| Agent runtime full suite | 104 files, 1464 tests pass |
| Desktop full package test command | 4554 pass, 0 fail; 3 Windows-link cases skipped on macOS |
| Shared and i18n suites | Pass; Shared discovers both source and emitted tests in its current package command |
| Desktop dependency builds, Desktop build, runtime bundle | Pass |
| Runtime and Desktop typechecks | Pass |
| Certificate unit/transport regressions | 15/15 pass; invalid server identity and mandatory client auth still fail |
| Old Electron model-discovery baseline | Exact client-certificate error before HTTP (zero HTTP requests) |
| Certificate Electron E2E | Pass: direct, authenticated proxy, bypass, origin refusal and abort |
| Old WorkPanel baseline with real CSS | Close action extends 22px beyond the visible strip; same assertion fails |
| New real UI/native-window E2E | Pass for absent/true/false startup values, save/read failures, busy state, restart hint/revert, typed boundaries, theme/background and active-tab close click |
| UI evidence | Six light/dark native-window screenshots; additional theme-surface screenshots |
| Protocol smoke | 23/23 pass; 2 real-provider tests intentionally skipped |
| Subagent registry E2E | 36/36 pass |
| Isolated Electron app boot | Pass, including sandbox preload/IPC and 800-session responsiveness probe |
| Theme surfaces and work-panel reorder E2E | Pass |
| Lint, style tokens, architecture, agent policy, Pi dependency/patch guards | Pass |
| Documentation checks | 86 locale pairs and 597 pages; only existing ADR-format notes |
| Whitespace and scope audit | `git diff --check` passes; no dependency/lock/patch/identity or Router-selection change |

### Review adaptations and limits

- Fixed an upstream handshake-cancellation defect: destroying TLS with an error
  could produce an unhandled socket error after `once` removed its listener.
  Destroy without a second error and rethrow the caller's abort/timeout reason.
- Keep applied-window-state compatibility optional on the renderer side. The
  settings row reports errors rather than swallowing them, and disables its
  switch while saving. Copy makes no unmeasured GPU-saving promise.
- Reuse the host's dependency environment and prebuilt debug Host; no dependency
  installation or native Host rebuild was required. App boot uses fresh offline
  schema fixtures with EasyTier disabled. Native-session unit fixtures use
  self-cleaning system temp projects because placing them below the real user's
  global skill directory correctly triggers the unchanged trust boundary when
  HOME is isolated. Other fixture profiles, data and evidence use isolated paths.
- UI/native execution was on macOS only. Windows/Linux native surfaces and PAC
  routing were not individually exercised; platform helpers/guards and proxy
  routing retain their existing tests. No GPU measurement, real provider call,
  installed-user-app acceptance, packaging or release was performed.
- Safety incident (already disclosed): an early Host preflight incorrectly used
  `--version`, which this Host does not support. It started against the default
  data directory and logged recovery of one in-flight reply. The exact user-data
  effect was not established; no rollback was attempted. Later Host runs used
  explicit isolated data/HOME. Do not infer that every action in this task was
  read-only with respect to user state.

The complete-import baseline is unchanged. These results prove only this
selective local candidate, not publication, deployment, or a full upstream import.
