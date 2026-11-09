# Selected upstream adaptation: Scheduled loading and user-only minimap

Date: 2026-11-09

This is selective content adaptation on Minih main
`33f07dc0b7194e04494d87a1936e99e28de8727e`, not an ancestry merge or a
complete import. The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. Monitoring checkpoints only
mean analyzed, not imported.

## Scope and provenance

Source: `vastsa/PI-Desktop`, reviewed at
`5f847fa865427ee40594895374dd42d1554bc7b9`.

| Adaptation | Source revision | Minih invariants |
| --- | --- | --- |
| Independent Scheduled reads and route-return snapshot | `dda598c6f7e4fa341b8cf469ccb4acb73312a67e` | Keep live follow-up turns, provider display names, delete confirmation and task-owned execution settings. Cache is renderer-lifetime display data, not execution admission. |
| Recover pending editor options after Host invalidation | `7d5abca832a61b4aed7b6727b3db87fca1f83ee8` | The next normal poll replaces a stale read even if it never settles; failures stay retryable and old results cannot overwrite recovered options. |
| User-message-only conversation minimap | `5caa0c227b27720ac877861d05a53ec2b9c9963d` | Preserve bounded previews, earlier-history entry, current viewport anchoring and the existing jump/follow ownership behavior. |

Review focus session isolation is already equivalent in Minih and is not
imported. The upstream bulk-disclosure and syntax changes were withdrawn
within the analyzed range and are not introduced. Plugin changes are excluded.
No provider preset, Minih Router, branding, IPC/RPC, schema, persistent format,
permission or scheduler execution contract changes are made.

## User-visible changes

- Task definitions no longer wait for run summaries or project options.
- Returning to Scheduled immediately shows the last successful in-memory
  snapshot and task/run selection while refreshing.
- Pending and failed run reads do not masquerade as never-run tasks. Failed
  history refresh retains known rows; Run now/Delete wait for known status.
- Create/Edit loads project options on demand, exposes retry on failure and
  recovers pending options after Host invalidation without reopening the page.
- The conversation outline marks user messages only; assistant/tool bodies
  no longer create navigation markers or assistant previews.

## Validation

The new hook and minimap regressions failed against the old production
implementation: 13 failures and 6 passes. Development validation is recorded
below as completed; no user profile or paid provider is a test environment.

- Targeted Node regressions: 82 passed (loading, workspace, return, runner,
  session fanout, minimap, transcript projection and interaction performance).
- Workspace dependency compilation and desktop TypeScript check passed using
  the already installed compiler and host dependency links.
- Desktop Electron-Vite build passed; existing large-chunk warnings remain.
- Native Scheduled Electron E2E passed: task create/edit, project/permission/
  model and reasoning selection, weekdays, pause/resume, manual and automatic
  local-model runs, result conversation/return, delete and Agent task CRUD.
  The script now waits for lazy editor options, follows the existing model
  search layout/provider label, and waits for test-process teardown.
- Native minimap React/Chromium E2E passed: exactly 12 user markers, no
  assistant markers, user hover preview, jump to the first user row at 24px
  from the viewport top, and no follow-mode rebound. Screenshot captured.
- Child-exit escalation helper regressions: 3 passed.
- Changed-scope Biome lint, architecture guard, script syntax, provenance link
  and `git diff --check` passed.
- Merge-time JS workspace and script tests: 11,096 passed and 4 platform-gated
  tests skipped. The CLI packaging test initially exceeded its 5-second budget
  under file concurrency; both isolated-file and full serial package reruns
  passed without source changes (82 passed, 1 skipped for that package).
- All 13 workspace typechecks, full applicable lint, agent policy, contrast,
  patch/gate tests, architecture guard and Rust formatting passed.

Development candidate: the request worktree based on
`33f07dc0b7194e04494d87a1936e99e28de8727e` (`origin/main` at preparation).
Both Electron suites used this worktree's built renderer, isolated profiles
under session scratch and the existing host environment. No production model
was called. Merge-time checks and the tested commit are recorded in the PR;
development checks alone do not claim PR integration validation.

The worktree reuses the primary checkout's third-party dependencies. Local
workspace package links resolve to this task's build outputs. Package-manager
automatic dependency preparation was rejected by its symlink safety checks;
no dependency installation was completed, and direct installed-tool builds
were used instead. No dependency versions or lockfile contents were changed.

The subsequent merge request authorizes committing, publishing and integrating
this selective adaptation through the repository's main-branch protection.
It does not authorize a release or advance the complete imported baseline.
