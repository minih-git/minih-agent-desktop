# Selected upstream reliability fixes: 2026-11-01 interval

## Scope and provenance

Implemented on 2026-11-02 in `fix/upstream-selected-20261101`, based on Minih
`origin/main` at `ad77e4b1641cccd9e9a5e1645808797d7c6de426`. Source repository:
https://github.com/vastsa/PI-Desktop. Reviewed daily interval:
`bdc7472ef45c46ad663b0eec97d3e04893653a87..0ba8cfd57cdc6baa4c1dbf16a617eb933ad3e0ee`.

This is selective content adaptation, not an ancestry merge or complete import.
The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. The automation checkpoint means
analyzed, not imported, and this implementation does not change it. Initial
authorization covered implementation only; on 2026-11-02 the user separately
authorized commit, push and integration into Minih main, but not release or installation.

| Upstream revision | Adapted content | Original author |
| --- | --- | --- |
| `59a0e6df39e33b17c118df5b630fa3071e51d6f9` | Count CJK in serialized tool-call arguments | xpeng5278-web |
| `38ffd0c176f9447aa758e1ebb38848dcf0568523` | Include kana, Hangul and compatibility ideographs in output estimates | xpeng5278-web |
| `47cebe18bd964de85c8ec8fefa382392bc915d67` | Terminal HTTP 402 and explicit credit exhaustion | xpeng5278-web |
| `5f4bb8d67c0af595ce52c08f6dc3d27077864801` | Read HTTP status from structured unprefixed Gemini JSON errors | xpeng5278-web |
| `91a06646d79144999fc596e186696ea763fe7ce7` | Collect stored file-argument aliases during compaction | xpeng5278-web |
| `01712462eefd1c7d122a627ed03eca19d4ead0d8` | Necessary dependency: collect files from the recent tail folded into the summary | xpeng5278-web |
| `a0f9ae4490c284c14cb7b1c3b5a870c2950d4487` | Restore Host Read images and MCP resources on Task resume; shared conversion only | xpeng5278-web |
| `0d51d4bf01990ea0eb7d4dfbcbbb7a619a4b11d1` | Diagnose the first field causing runtime retirement | muzimu217 |
| `b578585f6c9d86b819fe32ebd37e6dfb660f1105` | Bound the work-panel launcher and scroll its tool list | yu.xia |
| `1a05c804fae604882ae7561fd195d1e37babd53d` | Preserve 40px launcher hit targets under overflow | yu.xia |
| `58572bad676ea93014bf650392acdb05901694f5` | Theme-visible scroll affordance and launcher user-path coverage | vastsa |

Original contributors retain authorship and attribution. The older tail-collection
revision is included only as a dependency discovered while validating the selected
alias fix: the initial planner-only adaptation still produced empty file lists
when a short conversation's tool calls all fell in the recent tail. No older
history is attached and no historical backlog is reclassified as imported.

## Minih adaptations and preserved invariants

- Preserve Minih branding, package and channel identities, Router presets,
  provider fallback routing, permissions, local/remote capability restrictions,
  learned memory, model system prompts, side notes, Review and existing layout.
- Keep hosted-search replay projection/validation, canonical transcript folding,
  catalog context-window ceilings, observed-usage calibration and billing intact.
  CJK changes affect request estimates and output caps, not reported usage or cost.
- Keep Stop, local preparation failures, certificate failures, context overflow
  and genuine throughput throttling classification. JSON status extraction accepts
  only integer 400-599 codes nested under `error`, or root Google RPC status shapes.
  SDK status and explicit status prefixes retain priority.
- Share path alias definitions with execution instead of duplicating precedence.
  Canonical empty/invalid values do not fall through. Summarized recent-tail
  collection copies the planner's sets; Minih's `recent_window` model-switch
  branch still keeps that tail verbatim and does not fold it into the summary.
- Share only content restoration between parent/delegate history; preserve each
  caller's error/interruption flags, ToolSearch activation metadata and details.
  Binary images stay image blocks; MCP resources and links stay model-visible.
- Keep all runtime reuse comparisons, including `provider.fallbackBaseUrl`,
  `modelSystemPrompt`, `learnedMemoryRead`, and sidecar `lastActivity` cleanup.
  Diagnostics log field names, never values. This does not repair key-refresh
  retirement or promise provider prompt-cache improvements.
- Apply the launcher fixes as one final combination: pinned title, bounded list,
  independent scrolling, nonshrinking 40px rows, theme-aware visible thumb and
  stable gutter. Preserve Review/side-note order and all existing view navigation.
- Exclude plugin-only updates, the scheduled-task global switch and default
  collapsed turn-change summaries. No dependency upgrade, version bump, schema
  migration, new public RPC or persisted-format change is introduced.

## Development verification

Only actually executed results count. Tests use task-local builds and reused
third-party dependencies; no install, shared-dependency rewrite, running user
Desktop, real account or paid model service is used.

- Before production edits, the corrected new runtime regression suite reproduced
  26 failures with 3 passing controls. Launcher CSS contract and isolated Electron
  geometry probes also failed on the old CSS. The first compaction fixture lacked
  required message metadata; it was corrected before counting the baseline.
- Initial runtime verification passed 523 tests. After adding metadata/path
  compatibility controls, the expanded runtime/error/retry/delegation/compaction
  selection passed 637 tests across 9 files.
- Shared and agent-runtime TypeScript builds passed. An initial build identified
  test-fixture type omissions, fixed without production fallbacks.
- The real sidecar/Agent/local HTTP probe passed CJK output capping (110,000 Han
  characters retained; output cap 10,275), exactly one terminal HTTP 402 request,
  Task(resume) image/MCP text/link replay, unchanged-runtime reuse and safe rebuild
  diagnostics for all three Minih-specific comparison fields.
- An additional real `agent.compact` regression reproduced an empty folded-tail
  file list before the dependency repair. After repair, the same probe passed
  checkpoint read/modified lists and summary tags, alongside all other scenarios.
- Main-agent reruns passed 104 work-panel tests and all 5 isolated Electron launcher
  scenarios (40/few/no contributed views, narrow/short panels, English/Chinese,
  light/dark themes, native focus reveal, opening and closing the final tool).
  Five screenshots are stored only in session scratch, not the repository.
- Fixture-only probe corrections addressed UTF-8 chunk decoding, the adapter's
  `max_completion_tokens` spelling and a resource-link assertion; no production
  code was changed to satisfy those faulty assumptions.

## Candidate refresh and final development checks

During verification another session landed cache keep-warm on Minih main. The
request branch was safely fast-forwarded to
`fe74f012ac60a56338209b07c1b6a104ecbd8f11` while preserving this task's uncommitted
content with a verified scratch backup and Git's three-way working-tree merge.
No upstream ancestry, task commit or main-worktree edit was introduced. The
new provider-request assembly, keep-warm ledger and cancellation paths remain.

The refreshed candidate passed 687 tests in 12 selected runtime suites, including
keep-warm and idle lifecycle regressions; shared/runtime TypeScript builds;
104 work-panel tests; all five runtime sidecar scenarios; and all five isolated
Electron launcher scenarios. It also passed changed-file unused-variable lint
on 13 code/test files using the repository's Biome rule, with no fixes applied,
87 English/Chinese document pairs, 627 document pages, architecture/style-token
guards, current-main ancestry and whitespace checks. Initial ignored/stdin lint
invocations were not counted as passes; the final check used explicit file paths.

The primary checkout's existing iOS diff retained SHA-256
`ced833e62632461e00ebae6ae34bfaf9e0028c4fcbe1da3ebdb1fd78799782ed` throughout.

## Delivery validation

The request was refreshed onto Minih main
`329e01882c65ba0dfadca2076a9d5b47599831b4` (1.2.0) before delivery. The task does
not change that version. All JavaScript suites passed: 5,825 package/app tests
plus 5,053 Desktop tests, with four platform-conditional skips and no failures.
Workspace package builds, all four app typechecks, Desktop/Remote Web/docs
production builds, repository lint, architecture/agent-policy/style/contrast
guards, 35 static-gate tests and Rust formatting passed. The main agent reviewed
the complete task diff without a blocking finding.

The pnpm fast-gate wrapper refused the reused dependency layout before its build
step. Its checks were run through the existing tools directly; only that optional
local pre-push wrapper is skipped for delivery. No remote protection is bypassed.
Exact-commit task-candidate and PR-integration E2E remain separate delivery stages
and their actual tested revisions/results belong in the PR and delivery report.

## Limits and delivery state

This maintenance is not a release or deployed application. Local checks do not
imply Windows/Linux native execution, real Gemini service acceptance, Rust Host
storage acceptance or installed-app verification. The Host persistence boundary
is mocked in the runtime probe; no storage code changed in this task, so native
Rust tests were not rerun. Builds retain existing large-chunk/docs-highlighter warnings.

The primary checkout remains on `main`, and its pre-existing iOS
`Package.resolved` modification is outside this task. Do not merge upstream/main
or any old-history branch. Delivery retains this independent history boundary
and must satisfy the repository's applicable gates.
