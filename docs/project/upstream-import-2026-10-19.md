# Selected upstream content import: 2026-10-19

## Provenance and history boundary

Source repository: https://github.com/vastsa/PI-Desktop.
Initial request base: `1a86df751851b21725d17301652553af8e03934b`.
This is a reviewed content import, not a merge of upstream ancestry. It does not
advance the complete imported baseline beyond
`0d235a91a7718c8b7c0b1b485dc603c2840d5645` or claim that intervening upstream
changes are present. Original contributors retain authorship and attribution.

| Upstream revision | Selected content |
|---|---|
| `5a8ae904f1c0324473260523f653fcda1f923535` | Temporary sidebar width loan; preserve saved panel preference and safe gesture floor |
| `d215d2118da7e504a256c197ca93c363fbc47319` | A separate explicitly labelled TodoDock disclosure button |
| `7507217bcb7632fb1037503c9fff06807117c41d` | Host-owned background Bash execution and Composer controls |
| `ccf588bfc7f1fbb8a3a96e31bb447df9e8f99f27` | Bounded previews, final output drain, responsive stop/shutdown and user-path coverage |
| `e6cf13ae86dedfa658152a8446d85bb1c2de9d9d` | Running-only default visibility and dismissible new terminal receipts |
| `15c7081c0bba4e6ce5a45eec75b1d4d69f199794` | Required Windows test constructor fields for the new Bash options |

## Minih adaptations

- Keep Minih packages, channel prefix, brand/data/update identity, independent
  version, Minih Router, account backup, remote workspaces, subagent roster and
  transcript presentation customizations. Do not import release/catalog changes,
  plugin APIs/reviews, sidebar redesign or TodoDock shimmer.
- Keep permission admission cancellable. Detach only the registered process
  lifetime, not a user's pending approval.
- Forward isolated-worktree environment to background commands. Preserve the
  existing missing-runner fallback and conditional Windows Job breakaway.
- Serialize background admission with shutdown and reject startup before spawn
  when the Host is shutting down or the running-task limit has been reached.
- Keep background RPC business logic in its own module and tests separate from
  the process module. Do not add process state to the renderer or persistence.
- Use semantic E2E ids; upstream `E2E-265` already names a different Minih scenario.

## Unreleased user-facing changes

Reopening the sidebar no longer overwrites a saved work-panel width. TodoDock
has a single explicit expand/collapse control. Local long-lived Bash commands
can continue after the turn, expose bounded output and explicit Stop, and are
cleaned up when the Host exits. These notes do not bump a released version.

## Verification entry points

- Runtime parameter forwarding and existing foreground timeout tests.
- Host-core background lifecycle/environment and existing Bash ownership tests.
- IPC forwarding/id-validation and cross-layer contract tests.
- Work-panel preference and TodoDock component/interaction tests.
- Isolated background Host/renderer, three-column layout and Todo checklist E2E.
- Desktop typecheck/build, architecture/style/protocol/doc guards and diff check.

Only actually executed results in the task delivery report count as passing;
this source record is not a claim of deployment, publishing or cross-platform
acceptance. Do not merge old-history branches or upstream main to reproduce it.

## Verified request candidate

Implementation validation used the request worktree
`fix/upstream-selected-20261019` on refreshed Minih main
`ce732e7dcc00d668c0751c4f48e587e7f572737c`. The results below precede
commit/publication; exact-commit and PR-integration gates are rerun for delivery.
Validation environment: macOS, Node 24.14.1, host-installed dependencies and
shared Cargo target; no new dependency installation.

- Passed: 328 runtime tests; 9 background lifecycle/remote-boundary tests;
  22 existing Bash regressions; 61 targeted renderer/IPC/lifecycle contracts.
- Passed: Host and Desktop builds, Desktop typecheck, Biome lint, style tokens,
  architecture guard, agent policy, Rust format and Clippy. Clippy reports four
  preexisting warnings in unchanged delegation, hashline and transcript files.
- Passed: offline real-Host background stress (10 commands, 202 MB produced,
  256 KiB maximum retained per stream), denied/cancelled approval, remote
  background rejection, turn survival, explicit Stop and graceful-exit cleanup.
- Passed: background renderer interaction at 1280/700/390px, final output
  selection, stale-response rejection, retryable Stop and responsive input;
  isolated screenshots are captured by the probe.
- Passed: three-column layout 205/205 checks and the production Agent/TodoDock
  interaction including button-only disclosure and persisted checklist recovery.
- Passed: 85 paired documentation structures, 588 page/link checks and diff
  whitespace validation.

The real Host test caught a double-termination race after successful Stop; the
supervisor now records completed tree cleanup and does not terminate a reaped
process group again. Actual termination failures still report failure. Offline
E2E fixtures seed the production schema with EasyTier disabled before boot.

Not run: Windows/Linux native execution, full repository test suite, packaging,
publishing or deployment. Existing release numbers, update sources, model
catalog and the complete upstream baseline are unchanged.

## Candidate refresh

The task branch was fast-forwarded within the independent Minih history to
`ce732e7dcc00d668c0751c4f48e587e7f572737c` after concurrent memory/push changes landed.
Both sets of appended E2E scenarios are retained. All relevant candidate checks
are rerun after this content reconciliation; no old upstream ancestry is added.

Final rerun on the refreshed candidate passed all four isolated E2E suites,
including 205/205 layout assertions, plus all listed builds, typechecks,
328 runtime / 9 background / 22 foreground Bash / 61 frontend contract tests.
