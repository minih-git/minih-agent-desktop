# Selected upstream provider-error fixes: 2026-11-03

## Scope and provenance

Implemented in `fix/upstream-provider-errors-20261103`, based on Minih main
`8f3997b958f9d63222c77b791ada6eddaa9f3b34`. Source repository:
https://github.com/vastsa/PI-Desktop. Reviewed monitoring interval:
`9d86fc95b17780a820fec1890fabcabb1d0fa788..3f39884edf376b01f9190e7735c98a3d03d943b3`.

| Upstream revision | Selected content | Original author |
| --- | --- | --- |
| `405a396caf54875798939e28ff21a3327e0e03f8` | Classify 5xx-wrapped context overflows as terminal | xpeng5278-web |
| `5476e54691048f09b0a6370cc54573d292ab7706` | Classify explicit HTTP 400/422 API-key rejection as unauthorized | xpeng5278-web |

This is selective content adaptation, not an ancestry merge or complete import.
The complete imported baseline remains
`0d235a91a7718c8b7c0b1b485dc603c2840d5645`. Monitoring checkpoints mean analyzed,
not imported. No old upstream history is attached. Startup videos, scheduled-task
copy/test changes and plugin-only updates are excluded. Original contributors
retain attribution; this record does not claim their work as new original code.

## Behavior and preserved invariants

- A 5xx whose message reports context overflow without throughput-limit wording
  becomes terminal `CONTEXT_TOO_LARGE`. This includes Ollama MLX's parenthesized
  token-count wording. Ordinary outages and rate-limited 5xx stay retryable
  `PROVIDER_ERROR`; 429 keeps its separate rate-limit behavior.
- On 400/422, only explicit API-key rejection becomes
  `PROVIDER_UNAUTHORIZED`. Context overflow still wins; bare `unauthorized` or
  `permission denied` remains a malformed-request `PROVIDER_ERROR`. Statusless
  credential detection retains its existing broader policy and now recognizes
  `API_KEY_INVALID` too.
- Preserve Stop, local request provenance, TLS/certificate diagnostics,
  adapter-refused options, account/credit exhaustion, error redaction, structured
  status precedence and bounded details. No retry budget or backoff changes.
- Preserve Minih packages, branding, Router presets/fallback, permissions,
  persistence and runtime lifecycle. Existing local-session Settings guidance
  consumes the corrected auth code; remote-session action restrictions do not
  change. No renderer source changes are needed.
- These changes correct error classification and repeated-request admission;
  they do not add automatic compaction recovery for wording pi-ai does not know.
- No dependency upgrade, version bump, schema migration, public protocol or
  persisted-format change. The two fixes remain in the existing classifier;
  no new abstraction or parallel error-classification path is introduced.

## Development verification

- Before the production change, the new 28-case classifier suite reproduced
  10 failures and passed 18 controls on the old code.
- After adaptation, all 163 tests in five targeted suites passed:
  `provider-error-classification.test.ts`, `agent-errors.test.ts`,
  `provider-retry.test.ts`, `provider-recovery-flow.test.ts` and
  `provider-transport-recovery.test.ts`.
- Task-local shared and agent-runtime TypeScript builds passed, reusing host
  third-party dependencies without installing or rewriting shared dependencies.
- `node scripts/e2e-upstream-runtime-reliability.mjs` passed all ten reported
  scenarios. Five new real HTTP scenarios cover API-key rejection on 400/422
  and wrapped overflow on 500/502/503: each sends exactly one request, emits
  one terminal error with the expected code/status and reaches `agent_end`.
  Existing CJK request budgeting, terminal 402, compaction file aliases,
  Task-resume content and Minih runtime-reuse diagnostics also passed.
- The E2E exercises the built production sidecar, Agent and provider adapter
  against a local HTTP fixture. Host storage is mocked. It neither starts the
  installed Desktop nor uses a real provider, user database or paid API.
- Changed-file Biome `noUnusedVariables` checks passed for all three code/test
  files using an explicit scratch configuration; no files were silently ignored.
  The E2E script syntax check and `git diff --check` passed. Documentation checks
  verified 87 English/Chinese pairs and 629 pages, with existing ADR notes only.

## Delivery validation

- All 14 workspace builds and 13 typechecks passed, including Desktop, Remote
  Web and the docs site. The workspace suites passed 10,924 tests with four
  platform/conditional skips; 40 static-gate tests passed separately.
- Repository lint, changed-file lint, architecture/agent-policy/contrast checks,
  Rust formatting, release-docs, locale/link checks and whitespace checks passed.
- The optional pnpm gate entry could not run with the reused root dependency
  symlink. Its checks were invoked through existing tools instead; no install
  or lockfile change was made. A stale host dependency link was avoided with
  task-local package links and a prerequisite racp build. Gateway tests passed
  after using a short alias to scratch for macOS Unix sockets. Docs tests passed
  after moving task-created dependency links out of the scanner's tree.
- These environment-only failed attempts remain recorded and are not counted
  as passes. Exact-commit sidecar E2E and PR-integration evidence are recorded
  in the delivery PR rather than inferred from these working-tree checks.

## Delivery state and limits

The initial development checks above ran on the uncommitted working tree based
on the main revision above. The user later separately authorized commit,
push and integration into main. Exact task-candidate and PR-integration
revisions, their validation results and the merge outcome are recorded in the
delivery PR. This authorization does not include release or installation.

Real Gemini/Ollama service compatibility, native Windows/Linux behavior and
installed-app acceptance were not run. No UI changed, so no Desktop interaction
or visual acceptance is claimed. No Rust persistence code changed.

The primary checkout remains on main. Its existing iOS `Package.resolved` change
is outside this task. Do not merge upstream/main or an old-history branch.
