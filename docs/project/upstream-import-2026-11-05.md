# Selected upstream priority changes: 2026-11-05

Status: selected content adaptation prepared on `fix/upstream-priority-20261105`
for integration into Minih main. The request starts at
`df53e198d1b5fa938fe73e1a1cd7b5f4ce7be019`; Git/PR history records its landing.

This is selective content adaptation, not an ancestry merge or complete import.
The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. The monitoring checkpoint at
`b4430db052e85c4535ad8c919f9e3f7933b015dc` means analyzed, not imported.
No upstream/archived branch is merged into Minih's independent snapshot history.

## Scope and provenance

Source repository: `vastsa/PI-Desktop`, reviewed through upstream main
`b4430db052e85c4535ad8c919f9e3f7933b015dc`.

| Adaptation | Source revisions | Minih integration |
| --- | --- | --- |
| Shared first-input session creation | `86fe1e5db5a2ca19b44fd82e5a1d6086cfcab782`, `03f2c462ed4f9e6033978c0bd43a78f39049482d` | Pending creation resolves its exact id or null. Keep isolated task scope, model inheritance, remote capability checks and navigation ownership. |
| Initial Host handshake retry | `f3a8828ad06139a3d130ed2d0aa5e0ed590895a6` | Retry only the first exact handshake timeout, once, after child disposal and outside shutdown. Keep Minih app naming. |
| Terminal Zen quota exhaustion | `a6b7acf7c63a48ee1420941d5e5ac692e73205ce` | `FreeUsageLimitError` is terminal even on 429; retain the original message and genuine throughput retries. |
| Review scroll containment | `816888010661657f26f14365ce56bbd234a8cab4` | Move only the list, preserving required session id/messages and keyboard focus without ancestor scrolling. |
| History anchors and latest navigation | `3fcdcbbae837e08a4835ac9ace4c8503fa2fa66d`, `e64d06f00cb1880fe30be759de743db90865220e`, `bb25eb01347bdb28641b9ec85c5fdb0ad2257acd` | Adapt their required paging-owner/message-anchor foundation from upstream tip. Keep Minih actual-bottom sampling, canonical-tail staleness, bounded panes and opaque remote cursors. |
| Lazy directory paste | `ee51582b9264e85cf5a7baa0aa80d82b56fd9b2d`, `d3f968ce1855f6336a4270a66bf32875299d042c`, `b2c11b5f1400ada0865a62c4fa2ebc9bf9fb789d`, `dc6f53f83b8ea4a31353b76da3af255692472f6e`, `2d799f918ddd46d247d8f7f9563acf64028bf08c` | Native metadata and sender-bound import tokens; lazy escaped directory markers; draft/history/attachment chain. Preserve session targets, Minih conversation links and remote restrictions. |

Plugin changes, native Computer, native Review history and settings restructuring
are excluded. No SQL schema, provider preset, Router endpoint, model configuration
or application version changes are included.

## Pending release notes

- New Task and its first input share one durable conversation, including isolated
  tasks in the current project. Superseded creation cannot send to another chat.
- Cold startup retries one initial Host handshake timeout; explicit quota
  exhaustion stops without retrying an unchanged request.
- Returning to latest is interruptible and cannot be reclaimed by an old history
  page or search alignment. Older-history loading retains the readable message.
- Review file navigation scrolls only its list and retains keyboard focus.
- Pasted folders remain removable local directory references; their contents are
  read only as the task needs them, with no recursive copy on paste or send.

These notes describe source changes, not an installed or released version.

## Verification

Regression tests were added before implementation. Old-code failures included
wrong turn-vs-message anchors and restored offsets, missing latest preparation,
duplicate first-input sessions, stale-session fallback, missing handshake retry
and retrying `FreeUsageLimitError`.

Development verification is recorded here as it completes. No user profile,
paid provider or installed Desktop is a test environment. Dependency/runtime
resources reuse the primary checkout; generated shared/runtime output and
Electron profiles remain task-local or in scratch. No dependency installation.

- Session/queue/startup/reading/Review targeted Node regressions: 464 passed.
- Clipboard/directory/draft/history/send targeted Node regressions: 84 passed,
  including home-to-session edits while mixed file import waits and after a
  session switch. The old candidate failed both new ownership cases; fixed.
- Provider classification/retry: 114 passed. Shared Composer/IPC contracts:
  58 passed. i18n catalogs/renderer keys/copy: 32 passed.
- MCP control/channel exclusion and Minih session-target compatibility:
  35 targeted Node regressions passed.
- Shared, i18n and agent-runtime TypeScript builds: passed. Desktop typecheck
  and Electron/Vite build: passed; the existing large-chunk warning remains.
- Isolated Electron Composer runner: passed four first-input/cancel races,
  directory metadata/card/remove, ordinary text/file/image regressions and
  cross-process input-history restart. No host clipboard is modified.
- Isolated Electron reading runner: passed bookmarks, canonical-tail
  invalidation, continuation and seven priority checks, including late layout,
  ahead input, empty-page retry, interruptible latest/search ownership, hide,
  and Review scroll/focus containment. New fixtures use production components.
- Scoped Biome `noUnusedVariables` (same rule as repository config): 68 files
  passed using a scratch config, because the normal config excludes worktrees.
  Style tokens, architecture, Agent policy, and `git diff --check`: passed.

Merge preparation (2026-11-06): all workspace builds (including Desktop and
documentation) and all 13 package typechecks passed using installed tools
directly. pnpm 12 wrappers refused reused/symlinked runtime directories; no
dependency installation or lockfile update was needed. Task-local workspace
aliases were repaired to point at this checkout rather than deleted worktrees.
Repository-scope Biome lint covered 416 files; style tokens, contrast, Pi patch
and dependency checks, documentation pairs/links and script regressions passed.

The complete 14-target JS test run initially reported two failures: an obsolete
history-render wiring assertion and a documentation scan following task-created
workspace links into a concurrently removed test profile. The assertion now
covers the current paging hold, the unnecessary documentation aliases were
removed, and both failed files passed targeted reruns (19 and 13 tests). Across
that run and the repaired cases, 10,976 tests passed and 4 were conditionally
skipped. No Rust source was changed; full Rust validation was not run locally.

The adapted isolated-task creation additionally joins the newest matching
pending scope, rather than always choosing isolation; both creation orders have
regression coverage. Main checkout changes remain untouched.

Screenshots were captured for the directory card, its removal and Review focus.
Native Windows/Linux file-list implementations have fixture coverage only;
physical Finder/Explorer clipboard actions and installed-app acceptance were
not run. Release packaging and installed-app acceptance are outside this change.

The development checks above ran on the task tree. Merge-time JS checks and
commit-specific Electron candidate validation are tracked in the request PR;
they do not advance the complete upstream-import baseline.
