# Selected upstream reliability import: 2026-10-23

## Scope and provenance

Source repository: https://github.com/vastsa/PI-Desktop. The reviewed range is
`eb74d68e3b82496513da970164e0942798f5c711..9f313c8f855ef6f8311622ad63dd7e6583cef2d7`.
This is a selective content import, never a merge of upstream ancestry. The
complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. Original contributors retain
attribution through the source revisions below.

The approved plan recorded local Minih main
`ea21e6b5ca23657d6900280b3f9ac4c67402e600`. As approved, the task fetched the
fork's own `origin/main` and created `fix/upstream-reliability-20261023` from
`109a3b9951bc014ffc7da946ec27eb52e4a91e7b`, which already contains the
2026-10-22 selected import. This task did not move the primary checkout or
local main; other sessions may advance them independently.

The 2026-10-22 reading-position changes remain in force: an unpinned bookmark
owns a warm reveal, Minih's actual-bottom sampling is unchanged, and the new
fallback adds the saved absolute offset when the bookmarked row is outside the
mounted window. Nothing in this import reverts that geometry or its tests.

## Imported revisions

| Source revision | Selected content |
|---|---|
| `68b30b8d65081f84bb690e94a1a782e9d9484714` | A stop no longer waits for tools host-core cannot cancel |
| `984367febf6fbd242ea47d8f22f88f42ac059192` | `abort()` drives in-flight tools directly |
| `9538222594b66b8c6d18cc46d2807109fd228bcd` | Typed cancellation before permission; read-only waits may be abandoned; mutations settle |
| `c1f81eec73d08ea578d2fa32f1f21b7352bc7df5` | Provider-reused tool ids keep distinct executions and results |
| `c82490ce7e6ff0967fa768273d838d1cc1c4675f` | Output cap is sized from the folded request transcript |
| `f5b35021b82d22f45caadee7084cf4d1b330a73f` | Expired system trust anchors are skipped while merging the CA set |
| `36c1d159d4ac987d1b5f06311e3fff1071dbec21`, `6b227560da1ab99b8ff671a89b8cb6cda16bcc10` | Empty assistant rows are dropped; one Host-verified completion reply is retained |
| `fb81b1fc83607c4707e371a0fdfc227af0f3943b` | Positioned and ambiguous chat file references parse safely |
| `b6863ae2b` | AskTool drafts survive a session switch in renderer memory |
| `18a416b26`, `e0cedc300` | Reading fallback uses the saved offset; history lookup completes first |
| `5aa66e2c8`, `8f07fad13` | Market keeps the last successful list on failure, with time and source badges |
| `4d5bb44cd` | Gemini work setup uses its Schema subset and reports protocol failures once |
| `45a73f276` | Settings segmented controls size to their content and wrap as a whole |
| `399dd26e5`, `55dac23e4` | The active tab's close control stays inside the strip after narrowing |
| `986212f64` | Small completed activity groups and Thinking rows stay open |
| `c11f8ab6a` | One reviewed-edit row, diff copy, and the compact group hierarchy |
| `8956de008`, `09534c5c6` | The running marker is a real, centred flex element |
| `f30a994d0`, `2ec8c55e0` | Toasts avoid the docked work panel and keep deterministic focus tests |
| `24c0894bd` | Recovery always-on-top is macOS-only |
| `ee2f4fd0c` | The launch-resolver test expects the native scratch separator |
| `caa76f224` | Not applicable: the fork has no equivalent native-session symlink fixture; no EPERM suppression or session discovery was added |
| Models.dev snapshot in the range | Only the two Kilo GLM Flash output limits are corrected |

Test-only commits above are carried with the behavior they protect, not as
independent features.

## Minimal design and preserved behavior

- **Stop and side effects.** `tools.abort` accepts an optional `toolName`;
  older callers remain compatible. Host-core registers cancellation before
  permission evaluation, so a pending approval or queued admission cannot start
  after Stop. `Bash` and `GenerateImages` keep process cancellation and a
  bounded 10-second partial-output grace. Local `Read`/`Glob`/`Grep` may end the
  runtime wait immediately, with the Host discarding a late result; the
  read-only blocking worker may drain. Started writes, MCP, plugin and session
  delivery calls, including remote Write/Edit receipts, are awaited so Stop
  cannot hide a side effect. `abort()` drives the handlers. Cancellation state lives
  in `tool-execution-cancellation.ts` and Rust `tool_cancellation.rs`; no generic
  execution framework is introduced. Minih's SessionSend/SessionCreate pending
  approval cancellation, remote tools and background Bash semantics are kept.
  A background Bash approval is cancellable, and an admitted background task
  survives the turn Stop as a Host-owned process.
- **Tool identity.** The runtime assigns fresh local identities before Pi
  journals a response whose wire id was reused. The parent seeds the set from
  the restored transcript; delegates keep it across model fallback. The final
  request guard distinguishes an incomplete duplicate snapshot from an
  independently completed pair. Minih's 64-character limit, Responses composite
  ids and cross-provider normalisation stay.
- **Output budget.** The request estimator and pi-ai receive the same folded
  instruction projection when a model does not support mid-conversation system
  messages. Context calibration and compaction keep their existing basis.
  DeepSeek fixed declarations, lazy activation, CJK and hosted-search estimates,
  and Router endpoint/fallback logic are unchanged. Pi stays at `1.1.0`; no
  upgrade, lockfile change or extra patch is part of this import.
- **TLS and persistence.** System-store certificates whose validity has ended
  are excluded from the macOS merge; bundled and inherited extra CAs keep their
  rules, and no OS store is modified. Event persistence drops ordinary assistant
  rows with no text and no stored reasoning, regardless of status, retaining
  tool rows, structured errors, steering placeholders and the single trusted
  completion reply. No schema or database migration is introduced.
- **File references.** A trailing `:line`, `:line:column`, `:line-range` or
  `#Lline[-Lend]` is parsed; a range opens at its start. A shorthand resolves
  only when its complete suffix uniquely names one safe file; ambiguity opens
  nothing and never degrades to a shorter suffix or another root. Folder
  references, scratch/project markers, `~/` expansion and realpath containment
  remain. The short system-prompt formatting guidance is adopted; no tool or
  permission is added.
- **Interaction.** AskTool keeps the open question and answers by `requestId`
  across a session switch, drops them on resolve/dismiss/completion, and does
  not persist them across restart. The market snapshot is scoped to its query
  and shows its capture time and real source badges. Gemini schema/diagnostic
  changes stay in Main. Settings segmented controls wrap whole options. The
  active tab scrolls its wrapper with reserved close-button width.
- **Transcript and notification.** Minih's `standard` / `detailed` / `compact`
  densities and defaults stay; the upstream display-mode system is not
  imported. In `compact`, a completed ordinary group with at most four visible
  items stays open, a larger group starts closed, Task topology stays open, and
  visible Thinking rows start open and collapse individually. Only `compact`
  gets the 12px grouped indent and hover/focus rail. A reviewed Write/Edit is
  one file header plus diff body with Copy, rollback and failure reporting
  retained. The running marker is a real centred flex element with
  reduced-motion support. Toasts keep their right slide, sticky rules and
  newest-first order, anchored to the live main-pane right edge with a
  window-right fallback and observer cleanup.
- **Platform.** macOS keeps its temporary recovery pin and watchdog; Windows
  and Linux recovery stays at the normal window layer. The scratch-path test
  uses the native separator. The conditional symlink EPERM adaptation is not
  applicable, so no native Pi session discovery or error suppression is added.

## Catalog: corrected and skipped

The reviewed range contains 62 metadata differences that are price-only, plus
Kilo/OpenRouter output-limit changes. Most directory changes were already
implemented equivalently in the fork and are not applied again. Only these two
values change, because the official GLM publisher in the same snapshot still
publishes `131072` while the reseller record says `943718`:

- Kilo `z-ai/glm-5.3-flash`: `943718` → `131072`
- Kilo `~z-ai/glm-flash-latest`: `943718` → `131072`

Not adopted: the Kilo/OpenRouter Beam output limit raise to `943718`, all other
price differences, and any earlier upstream snapshot overwriting a later fork
refresh. A static catalog price is not Router billing. Router account model
sources, presets, control-plane prices, protocol selection and API addresses are
unchanged. The complete catalog is therefore not claimed to be synchronized.

## Preserved Minih identity

Minih branding, package/channel/update identity, application version, data
paths, Router account and project behavior, remote connections, side notes,
subagent roster/dock, notification cards and the port-to-tray behavior are
unchanged. Pi remains `1.1.0`. No dependency upgrade, plugin content, upstream
release identity or upstream version number is imported.

## Implementation and validation: 2026-10-23

The specs and ADRs were prepared before implementation validation. The final
candidate is the uncommitted task worktree on base
`109a3b9951bc014ffc7da946ec27eb52e4a91e7b`, not a release or a merged commit.
All checks below used that worktree, reused installed compatible dependencies,
and isolated mutable test state. No user profile, live provider, OS trust store,
monitoring checkpoint, installation or running Desktop was used or changed.

A scoped source review found that the remote relay still discarded a started
Write/Edit result after Stop. Four Main regressions and one Host regression
failed before the correction, then passed after both sides retained the actual
completion receipt. Remote read-only and Bash cancellation behavior remains.

| Check | Actual result |
|---|---|
| Shared, i18n, Agent Runtime, Host Runtime, Voice Runtime build and typecheck | PASS |
| Desktop production build and typecheck | PASS; existing large-chunk warnings remain |
| Agent Runtime approved 11-file Vitest selection | PASS, 483 tests, including request HTTP fixtures and main/subagent identity paths |
| Host Runtime launch-resolver and fs-index | PASS, 10 tests |
| Voice Runtime live protocol | PASS, 7 tests |
| Host filters: `remote_tools`, `tools_abort_`, `tool_cancellation`, `background`, `permission_cancellation`, `shutdown_cancels` | PASS: 12 / 6 / 4 / 10 / 2 / 1 respectively; filters overlap |
| `cargo build -p host-core --locked` and `cargo fmt -p host-core -- --check` | PASS; newly built task binary used below |
| `cargo clippy -p host-core --locked --all-targets` | PASS with 7 pre-existing warnings in unchanged files |
| Main, persistence, Live, catalog, window and remote-relay Node regressions | PASS, 196 tests |
| UI workflow Node selection | PASS, 186 tests |
| Transcript, review and toast Node selection | PASS, 117 tests; overlaps the workflow selection |
| Real Host `e2e-tool-stop.mjs` | PASS: pending Write cannot be approved or written, typed cancellation is isolated, detached Bash survives turn Stop |
| Isolated Electron AskTool, reading-position, market-retry, settings-scroll, file-ref-line-scroll and work-panel-tab-close fixtures | PASS |
| Isolated Electron transcript-render, notification-cards and question-notification fixtures | PASS, including density changes, diff copy, safe-area geometry, keyboard/focus and narrow layouts |
| Local TLS client-certificate fixture and child-exit guard | PASS; no OS trust modification |
| Changed-file Biome with repository lint rules | PASS for 102 files; 5 unchanged baseline unused-variable diagnostics remain in 3 test files |
| Architecture budgets plus explicit untracked TS/Rust source-size guard | PASS |
| Pi dependency and patch guards | PASS: 1.1.0 and all 3 audited patches retained |
| Catalog structural comparison | PASS: exactly the 2 approved output caps changed; every other JSON value is unchanged |
| Documentation locale/link guards | PASS: 87 language pairs and 608 pages |
| `git diff --check` | PASS |

The rebuilt task Host binary SHA-256 is
`6cac9f813d70f614d84f3c04c43d99d5870c047b560e0a7b436eed0965bf38e3`.
Builds and test logs remain in session scratch, not tracked release outputs.

### Limits and explicitly unrun work

- Windows/Linux native execution was NOT RUN on this macOS host. Platform
  recovery branches have fixture coverage, which is not native acceptance.
- Twelve density screenshots and light/dark wide/narrow notification screenshots
  were captured by isolated fixtures. Their interaction and geometry assertions
  passed; manual inspection in the built-in Browser was ENVIRONMENT-BLOCKED
  because the calling session's Browser view could not become visible.
- The 5 Biome diagnostics were reproduced on the unchanged task base:
  `chat-review-entry.test.mjs`, `thinking-ui.test.mjs`, and `runtime.test.ts`.
  They were not silently fixed or counted as a clean all-file lint result.
- Original new Host approval/admission tests did not rebuild the old Host
  baseline; their old-code failure was inferred. Runtime/Main regressions and
  the added remote-mutation Host regression did record actual failure runs.
- No repository-wide suite, `verify:ui:*`, live/paid service, native provider
  call, commit, push, PR, merge, package, release, installation or app restart
  was performed. The task worktree is retained for inspection.