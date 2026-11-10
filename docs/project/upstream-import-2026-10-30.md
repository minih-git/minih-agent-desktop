# Selected upstream fixes: 2026-10-30 interval

## Scope and provenance

Implemented in `fix/upstream-selected-20261030`, based on Minih main
`487824059e722c796baa84c18b42e41c3c94e91f`. Source: PI-Desktop reviewed interval
`454cca2e149eabf85cbba516bb6a11de5f19780e..97cc04debf261a423987a9d3ced4036d80073c5b`.
The approved scope contains seven non-plugin fix groups. This is selective
content adaptation, not an ancestry merge or complete import. The complete
imported baseline remains `0d235a91a7718c8b7c0b1b485dc603c2840d5645`.
The monitoring checkpoint means analyzed, not imported.

| Source revision | Selected change | Upstream author |
| --- | --- | --- |
| `d2f18b29d3126cd380304a5bf547e1894d07a67e` | Include cached request occupancy in the context usage anchor | FuYukiH |
| `5244493c8fe1471b42fa9c182fd1e36851da49d3` | Read-only Stop does not wait for the abort acknowledgement | FuYukiH |
| `1c339e1f5cd8ce4e454afc652d1301a7059dcbd1` | Measure stream idle time per active provider attempt | FuYukiH |
| `01712462eefd1c7d122a627ed03eca19d4ead0d8` | Collect file operations from the summarized folded tail | xpeng5278-web |
| `39ab73b9afaaaf201f108e01e1fd2f75735d110e` | Match summary chunk reserve to the prompt guard estimate | xpeng5278-web |
| `0fe89caf9203e9b45bbdcfa1fd111ff8b178162b`, `1a8996a10b1d7d15cf186bb397ac3e8c1615b947`, `3b38677b56e2f53ea30d03ecf6c2fd6a3713d01a`, `e7643cf134d37233866e6b02a1a46299d687c491` | Final global capability scope, visible/resettable overrides and collection-generation ownership | liuzixiang |
| `0029d0148f19a2a5e9ba242bc245a1a7941afc3a` | Localized SSH Host install/start failure summary | afsuyadi |

## Minih adaptation boundaries

- Keep Minih branding, Router routes, Pi 1.1.0 and all existing dependency
  patches, side notes, permissions, transcript reading and model-switch behavior.
  No dependency upgrade, SQL migration or plugin feature is imported.
- Shared request occupancy counts input/output/cache buckets once; reasoning is
  already in output. The runtime takes the larger of the bucket sum and reported
  total without changing billing aggregation. Preserve hosted-search validation
  and invalidation of usage anchors older than the active checkpoint.
- Read-only Stop uses `ToolExecutionCancellation.canAbandonWait`; writes and
  external operations still retain Host settlement ownership. Late read or abort
  failures cannot affect another turn. No broad cancellation policy replacement.
- Idle clocks and stall abort controllers belong to individual provider attempts.
  Backoff retains user cancellation and the shared retry budget. Keep
  `MINIH_AGENT_STREAM_IDLE_TIMEOUT_MS`, stream tracing, request affinity and usage.
- Add file operations to copied sets only when a tail is actually folded into the
  summary. Preserve the model-switch `recent_window` branch and its verbatim tail.
  Carried summaries use the existing 3.5-character estimator in chunk reserves.
- Global MCP/Skill controls read/write defaults without project scope; project
  effective rows expose legacy mismatches and reset through the existing Host
  state contract. The override map rides in accepted collection data. Unlike
  blindly copying the upstream final snapshot, settled toggles reload effective
  state too, so changing a default cannot leave stale override badges.
- SSH adds a key to the existing Minih error map and localized summaries. Preserve
  all existing mappings and the remote/local failure-message boundary. The change
  does not fix the connection failure or disclose raw stderr.

## Development verification

- Before production fixes, real runtime tests reproduced three blocked read-only
  Stops, two retry-backoff accounting failures, four cached/compaction failures
  and the missing folded file list. Behavior-preserving extraction of the old
  reserve formula reproduced a 10,600-token chunk under a 10,000-token guard.
- Runtime focused/adjacent suites: 497 passed across twelve files, including
  complete runtime tests and the existing seven model-switch user paths.
- Production sidecar bundle built from this worktree. Ten isolated child-process
  scenarios passed: Read/Glob/Grep Stop followed by another prompt, Write
  settlement, cached usage, partial bucket totals, normal usage, Stop during
  retry wait, Retry-After and a real silent request without overlap.
- Shared usage regressions: 12 passed, including billing identity/deduplication
  and cache occupancy. i18n catalog/copy/renderer-key tests: 32 passed.
- Desktop focused tests: 53 passed, including real MCP/Skills components with
  controlled API edges for default scope, override reset, post-toggle mismatch
  refresh and stale project rejection; the real SSH form produces the specific
  summary without stderr. Existing market-owner, remote/local error-boundary
  and row-busy regressions also passed (12 tests). Screenshots remain in session
  scratch as `upstream-scope-mcp.png`, `upstream-scope-skills.png` and
  `upstream-scope-ssh.png`; no screenshot is committed.
- Affected workspace builds and Desktop typecheck passed after completing all
  nine locale catalogs. The initial locale build failure and an incorrectly
  invoked Node i18n test run were corrected; they are not counted as passes.

## Final development checks

- Final Desktop run: 65 passed with no skips. This combines the 53 focused
  cases and 12 adjacent cases above; these are not additional counts. Both
  settings pages also retire a pending-write refresh after unmount.
- Changed-file unused-variable lint: 35 source/test files passed without fixes.
  Style-token checks, whitespace checks, 87 English/Chinese documentation pairs
  and 626 documentation pages passed.
- Tested task base: `487824059e722c796baa84c18b42e41c3c94e91f` plus this
  uncommitted working diff. Runtime E2E used its task-local production bundle;
  UI E2E used real bundled components with controlled API edges and isolated
  Electron profiles. No installed user application was started.
- During implementation another task advanced local main to
  `abc432922d6fb3acbedd04a27022d8861ed4c238` through the 1.1.4 release PR.
  Its committed delta was inspected (release versions, changelogs and catalog),
  but it was not rebased, merged or copied into this uncommitted candidate.
  Refreshing against that main and PR integration validation remain delivery
  steps, not results claimed by this development run.

## Environment and delivery limits

Dependencies are reused through task-local link layers. Internal package aliases
point to this candidate; stale primary aliases are not changed. No install or
second runtime environment was created. Build outputs are task-local.

A UI delegate briefly wrote three task files and one mapping line into the
primary checkout. The delegate was stopped; the verified task files were moved
into this request worktree and the one mapping line was removed from primary.
Primary was rechecked to retain only its pre-existing iOS `Package.resolved`
modification. No other user changes were reverted.

This record covers an uncommitted local implementation candidate. Commit, push,
PR integration, release packaging, installation, user-profile migration, real
providers/SSH and Windows/Linux native acceptance are not performed or claimed.
No upstream commit graph is attached to Minih main.
