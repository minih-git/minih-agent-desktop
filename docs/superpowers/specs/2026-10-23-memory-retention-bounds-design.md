# Memory retention bounds design

- Status: Draft (stage 0 of the memory-retention work)
- Date: 2026-10-23
- Baseline: `origin/main` at `ab26e39c9`
- Worktree: `.worktree/memory-retention-bounds` (`fix/memory-retention-bounds`)
- Measurement harness: `scripts/perf-memory-soak.mjs`,
  `scripts/e2e/heap-snapshot.mjs`, `pnpm test:perf:memory-soak`
- Related: ADR 0120 (bounded session history windows), ADR 0130 (bounded
  mounted transcript window), ADR 0137 (retained session panes),
  `02-architecture/05-remote-agent-control.md` §8

## 1. Problem

An installed 0.25.0 kept running for about ten hours and was measured with
`vmmap -summary`:

| Process | Role | Physical footprint |
|---|---|---|
| Renderer (main window) | UI | 2.4 GB (peak 3.4 GB) |
| Electron Main | orchestrator | 1.2 GB (peak 1.6 GB) |
| Agent sidecar (`ELECTRON_RUN_AS_NODE`, `sidecar.js`) | runtime | 732 MB |
| host-core (Rust) | storage | 180 MB |

Those numbers are a symptom, not a diagnosis: the app has several structures
that retain unbounded data for as long as the process lives. This document
records what the code actually does, what the isolated harness measured on
`main`, and the bounds each stage adds. Nothing here changes persisted data,
IPC/RACP contracts, or user-visible behaviour.

## 2. Verified current behaviour

Lifetimes below were re-read in the worktree at the baseline commit; the
line references are the ones a later stage must change.

### 2.1 Main process: durable event streams are created and never released

- `packages/agent-host/src/event-log.ts`: `EventHub.streams` is a
  `Map<sessionId, EventStream>` with no delete path. `stream(sessionId)`
  creates on first use, and `publish()`/`subscribe()` both call it.
- Each `EventStream` keeps `durable` events bounded only by
  `retention = { maxEvents: replayWindowEvents, maxAgeMs: replayWindowMs }`,
  i.e. 10 000 events and 24 h (`packages/shared/src/racp.ts:660-661`).
- Eviction runs only from `EventStream.append()` (`evict()`), so a stream
  belonging to a session that is no longer used never re-examines its age:
  the 24-hour bound is not enforced for idle sessions.
- Durable events include `item.completed` with the full message and tool
  result, bounded per frame by `boundPayload()`/`maxFrameBytes`
  (`packages/agent-host/src/agent-host.ts:1384`). Streaming deltas are
  ephemeral and never retained (`racp.ts` durable-kind list).
- `AgentHost.states` (`agent-host.ts:229`) is `Map<sessionId, SessionState>`
  and also never shrinks; `SessionState` carries up to `MAX_TURNS_PER_SESSION`
  (200) turn records plus `activeItems`.
- `packages/agent-host/src/agent-host.ts` is always constructed at startup
  (`bootstrap/startup.ts`), so all of this is retained with no remote client
  connected.
- Session deletion does not tell AgentHost: `session-ipc.ts` `sessionDelete`
  calls host-core, drops the outbox, clears sidecar bindings and disposes the
  pi session, but leaves `EventHub.streams` and `AgentHost.states` in place.
  The mobile delete path goes through the same IPC (`remote-backend.ts`), so a
  second call site is not needed.

### 2.2 Cursor, epoch, and `revision` semantics (needed before dropping state)

- A cursor is `{ epoch, sequence }`. `EventStream.epoch` is generated when the
  stream object is created (`ids.next("ep")`), and `EventHub.stream()` is the
  only place a stream is created. Dropping a stream and letting it be
  recreated therefore yields a **new epoch**: a client presenting the old
  cursor gets `resync { reason: "epoch" }`, which the spec already defines
  (`05-remote-agent-control.md:509`). Sequence pairs are never reused because
  the epoch differs.
- `SessionState.revision` is a per-session optimistic-concurrency counter, not
  an event sequence. It is bumped for durable events
  (`agent-host.ts:1355`), guards compare-and-set writes (`expected !==
  state.revision` → `CONFLICT`, `agent-host.ts:552`), stamps approvals
  (`revision + 1`), and is returned by item pages and snapshots. `state()`
  lazily creates a state with `revision: 0` (`agent-host.ts:1602`).
- Consequence: forgetting a `SessionState` and later recreating it resets
  `revision` to 0. A client holding an older, larger expected revision would
  get `CONFLICT` rather than a wrong write, but that is still a behaviour
  change for a session that was merely idle. A Host restart already resets
  every revision, so the spec does not require cross-process monotonicity —
  but within one process we can keep it for free.
- **Decision:** `forgetSession` keeps the last `revision` per session in a
  small bounded map (`sessionRevisions`, capped, LRU) and seeds a recreated
  state from it. Event streams are dropped wholesale; state objects are
  dropped except for that number. Stage 1 implements this and covers it with
  a test (recreate after forget → revision does not go backwards).

### 2.3 Renderer: session caches and the mounted window

- `apps/desktop/src/stores/runtime/session-runtime.ts`: `sessionTranscriptCache`
  is bounded only by `SESSION_TRANSCRIPT_CACHE_LIMIT` (20 sessions); there is
  no byte budget. `loadFullSessionMessages` and `syncTranscriptProjection`
  write full, untruncated history into the same map that the bounded read path
  fills with `contentLimit`-truncated messages (ADR 0120 cap, 64 KiB).
- `features/chat/transcript/hooks/useTranscriptScroll.ts`: `windowSize` grows
  on every top reach (`reachTop` → `growTranscriptWindow`) and is persisted
  with the reading position; it never shrinks after the reader returns to the
  bottom, and up to three panes stay mounted (ADR 0137).

### 2.4 Sidecar runtimes and user MCP connections

- `packages/agent-runtime/src/sidecar.ts`: `runtimes` is released only on
  config mismatch or `agent.disposeSession`; each runtime holds full history
  with base64 attachments. A rebuild path already exists (history and
  compaction are restored on the next prompt), so idle collection is safe.
- `apps/desktop/electron/main/user-mcp.ts`: stdio connections are keyed by
  service + working directory, capped at 64, with no idle timeout. A single
  MCP server was observed open seven times.

## 3. Measurement harness (stage 0 deliverable)

`scripts/perf-memory-soak.mjs` reproduces the retention pressures in a
throwaway profile:

1. A local SSE "model" (`/v1/chat/completions`) answers every turn with one
   large plain-text message. Tool calls are deliberately left out: built-in
   tool results are capped at 50 KB by the runtime, so a 500 KB tool result as
   seen in production comes from MCP/plugin tools; the harness seeds those
   payloads into the durable history instead (§3 step 2).
2. Before Electron starts, a real host-core process seeds N sessions, each
   with seeded user/tool/assistant triples whose `toolResult` carries the
   configured payload size (default 500 000 bytes).
3. Electron is started with `--user-data-dir` and `MINIH_AGENT_DATA_DIR`
   inside the artifact directory and driven over CDP. Each round visits every
   session: real turns through the real sidecar, scroll to the top in
   viewport-sized steps (so `reachTop` grows the mounted window and then loads
   older pages), scroll back to the bottom, switch to the next session. Half
   way through, part of the sessions are deleted through the real IPC.
4. After every round it records per-process RSS (`ps`), the renderer's
   `Runtime.getHeapUsage`, and optionally `vmmap -summary` physical footprint
   for main/renderer/sidecar/host-core. At the end it captures one Renderer
   heap snapshot over CDP `HeapProfiler` and summarizes the top retainers.

`scripts/e2e/heap-snapshot.mjs` is the analyzer: it rebuilds the strong
reference graph, computes the dominator tree (Cooper–Harvey–Kennedy over
postorder numbers), derives retained size per node, aggregates by constructor,
groups strings by leading text (so "the same 500 KB payload stored 180 times"
is visible), and walks retainer chains that include the edge name
(`toolResult`, `messages`, `projection`, …) so the retaining structure is
identifiable after minification. It can also run standalone against a saved
snapshot.

Safety: no user profile, no running app, no real provider. Measured builds
come from `--app <tree>`; `main` baseline was measured against the primary
checkout build of `ab26e39c9`, since the worktree has no `node_modules`.

### 3.1 Baseline on `main` (`ab26e39c9`)

Command: `node scripts/perf-memory-soak.mjs --app <primary checkout>` with
8 sessions × 6 × 500 KB seeded results, 4 rounds, 1 turn per session per
round, 6 scroll steps, 2 sessions deleted in round 3. Runtime 64 s, 38
provider requests. RSS in MB per process, from `summary.json`; the window
renderer is the one CDP is attached to, and a second, flat renderer (136 MB)
is reported separately rather than merged:

| Sample | main | window renderer | other renderer | sidecar | host-core | heap `used` | heap `total` |
|---|---|---|---|---|---|---|---|
| baseline | 352 | 173 | 136 | — | 148 | 8.9 | 18.5 |
| round 1 | 352 | 325 | 136 | 248 | 148 | 62.7 | 116.3 |
| round 2 | 369 | 414 | 136 | 194 | 163 | 91.2 | 158.5 |
| round 3 (after 2 deletions) | 318 | 499 | 135 | 209 | 169 | 95.1 | 208.3 |
| round 4 | 332 | 545 | 135 | 212 | 171 | 127.8 | 245.8 |

`gpu` (104–107 MB) and `utility` (218–220 MB, 4 processes) are flat and are
not part of this work. The baseline row has no sidecar sample because that
measurement is taken right after CDP attaches, before the first prompt starts
the sidecar.

Reading the series: the window renderer grows monotonically 173 → 545 MB
(+215 %) over four rounds *and keeps growing after two sessions are deleted*,
its JS heap grows 18.5 → 245.8 MB total, and main/host-core/sidecar each lose
what they gained around the deletions but never return to the baseline. This
is the shape the work has to flatten, and it is reproducible on `main` in
about a minute.

Renderer heap snapshot at the end of the run: 60.4 MB file, 676 963 nodes,
3 371 014 edges, retained root 51.8 MiB. Top retainers:

| Retained | Count | Group |
|---|---|---|
| 153.9 MiB | 125 374 | `object:Object` (overlapping sums; DevTools-style) |
| 51.8 MiB | 1 | GC roots |
| 28.1 MiB | 108 | `system / Context / scope` |
| 16.3 MiB | 33 823 | `closure` |
| 11.3 MiB | 180 | string starting `large tool output:` (the seeded payload) |
| 8.4 MiB | 10 416 | `system / Map` (object shape) |
| 5.2 MiB | 8 997 | `object:UI` (React elements) |
| 5.2 MiB | 2 863 | `system / Code` |
| 2.7 MiB | 51 758 | `object:Array` |
| 1.9 MiB | 988 | `blink::PhysicalBoxFragment` |

What the snapshot actually says:

- The renderer holds **180 copies of the seeded payload at ~64 KB each**, not
  48 copies at 500 KB: every display copy is already truncated by ADR 0120's
  `contentLimit`, and each message's truncated form exists about 3.75 times
  over. The retainer chains name the sites: `Object ⟨toolResult⟩ ← Array ⟨[]⟩
  ← Object ⟨visible⟩ ← Object ⟨projection⟩ ← WeakMap ⟨table⟩`, `… ← Object
  ⟨messages⟩ ← UI ⟨pendingProps⟩ ← UI ⟨alternate⟩` (React fiber props), and
  `… ← Object ⟨tools⟩ ← Object ⟨parts⟩`.
- So the JS heap is dominated by *many copies of cached messages plus their
  React props*, not by one stuck giant string, which matches the unbounded
  cache-count and mount-window diagnosis in §2.3.
- The datum that does not fit a pure JS-heap story: `usedHeap` grows 8.9 →
  127.8 MB while the renderer process grows 173 → 545 MB. Roughly three
  quarters of the growth is outside the JS heap — DOM, layout fragments,
  decoded images and other renderer-side native allocations. A heap snapshot
  alone would therefore under-report this leak; RSS and `totalHeap` are both
  part of the acceptance series.
- Markdown/Shiki artifacts, detached DOM and plugin code are not top
  retainers in this workload: DOM appears only as
  `blink::PhysicalBoxFragment` (1.9 MiB) and `HeapVectorBacking<FragmentItem>`
  (1.1 MiB). If a later, larger run flips that ordering, stage 2 gets the
  targeted follow-up described in §5.
- Main-process RSS moves 352 → 369 → 318 → 332 MB around creation and
  deletion; host-core climbs 148 → 171 MB and sidecar 248 → 212 MB. None of
  them comes back to baseline, which is what stage 1 and stage 4 target.

Limits of this baseline (stated so later stages do not over-read it):

- Scale is ~20× smaller than the reported production footprint: 8 sessions,
  ~24 MB of seeded tool payloads, 4 rounds. It reproduces mechanisms, not the
  production magnitude; the knobs allow larger runs.
- The soak exercises the bounded read path. It does **not** drive
  `loadFullSessionMessages` or an edit/retry, so this snapshot cannot
  confirm or refute the "full read writes untruncated history into the bounded
  cache" branch of §2.3. Stage 2 adds that interaction and re-measures.
- `vmmap -summary` physical footprint is unreliable for Electron 43 here:
  macOS cannot resolve PartitionAlloc zones of the framework
  (`sandbox_extension_issue_file_to_process`, dyld shared cache), so
  `physicalFootprint` is often absent or understated. RSS from `ps` is the
  series to trust; footprint is recorded only when asked for
  (`PI_MEMORY_SOAK_VMMAP=1`, on by default on macOS, and unset for the runs
  recorded above because it is noisy).
- Stage 1 changes main-process retention, whose effect is not visible in a
  renderer snapshot. The harness therefore records main RSS per round today;
  stage 1 additionally needs the AgentHost to report stream count and bytes
  (§5), measured through a main-process inspector target
  (`--inspect` in the soak launch, opt-in), not through a new product IPC.

## 4. Goals and non-goals

Goals: after long use (repeated session switches, long tool outputs, scrolling
back through history, session deletion) each process memory series stops
climbing and settles; no change to persisted data, reading-position restore,
edit/retry, or mobile reconnect.

Non-goals: lowering `--max-old-space-size`, changing the process model,
touching Rust host-core, collecting long-lived background processes started by
the agent through Bash, switching replay retention to reference+refetch,
production memory telemetry.

## 5. Stage invariants and budget defaults

Each stage must preserve the listed invariants; the numbers are defaults,
constants at the point of ownership (not scattered literals).

### Stage 1 — AgentHost release (P0)

Invariants: a client that reconnects with a cursor from a dropped stream gets
`resync`; a live turn, subscription, pending approval/input, or queued turn
keeps its stream and state; `revision` never moves backwards within one Host
process; a session delete releases its stream and state.

Work:

1. `EventHub.dropSession(sessionId)` → delete the stream, close/clean its
   subscriptions (closed subscriptions follow the existing resync semantics).
2. `AgentHost.forgetSession(sessionId)` → drop `states`, `turnIndex`,
   `runtimeAliases`, `startingQueuedTurns`, idempotency entries and the event
   stream for that session, keeping the last `revision` per §2.2. Call it from
   `session-ipc.ts sessionDelete` after success, exposed through
   `agentHostBridge`.
3. Idle sweep owned by `AgentHost` (timer cleared on `stop`/dispose):
   `EventHub.sweep(now)` applies `maxAgeMs` eviction to *every* stream, not
   only on append, and drops a whole stream when the session has no active
   turn, no subscription, no pending approval/input, an empty queue, and has
   been idle for `idleStreamDropMs` (default 30 min).
4. Byte budgets: per stream `streamDurableBytes` (default 8 MiB) and global
   `totalDurableBytes` (default 64 MiB), evicting oldest durable events first.
   Byte size is estimated at append time from the already `boundPayload`ed
   JSON; the cost of that estimate is measured before it ships. An evicted
   cursor keeps returning `resync: evicted`.
5. Diagnostic: `AgentHost.eventStreamStats()` (count, retained events,
   bytes) for the harness; no product IPC surface without its own review.

### Stage 2 — Renderer cache and mounted window (P1)

Invariants: a background-running session still merges its streaming tail;
edit, retry and Stop still fetch full history when they need it
(`prepareTranscriptAction`); a "suspicious empty window" is never cached
(issue #795); reading position restore (E2E-071g) is unchanged.

Work: trim a session's cache to a bounded tail window when it is neither
active nor retained-pane; keep full reads transient; add a cache byte budget
(default 48 MiB, LRU, active and retained panes excluded) alongside the
existing 20-session cap; shrink `windowSize` back to `TRANSCRIPT_WINDOW_MIN`
once the reader is pinned at the bottom again, and persist the enlarged window
only while unpinned.

### Stage 3 — User MCP idle release (P1, small)

Invariants: an in-flight call, a connecting client, or a pending status
refresh is never closed; the next call reconnects lazily.
Work: close and remove stdio connections with `activeCalls === 0`,
`lastUsedAt` older than `idleCloseMs` (default 15 min), timer cleared on
manager dispose.

### Stage 4 — Sidecar runtime idle release (P2, separate PR)

Invariants: a running turn, delegation, pending askTool/permission, in-flight
checkpoint or pending steering keeps the runtime; the next prompt rebuilds
history and compaction through the existing `session.get` path.
Work: periodic sweep disposing non-native-pi runtimes idle for
`runtimeIdleMs` (default 30 min), plus an idle-count cap (8) with LRU. ADR
records the trade-offs (learned-memory re-capture, provider prompt-cache
misses, non-resumable finished delegation chains) and
`03-runtime/02-agent-runtime.md` is updated. Electron bookkeeping
(`agent-extensions`, `sessionProjects`) must not keep state pointing at a
disposed runtime.

## 5.1 Stage results (PR1)

Clean numbers for the same scenario as §3.1 (8 sessions × 6 × 500 KB, 4
rounds, 2 deletions), renderer heap sampled after a forced collection.

### Stage 1 — AgentHost release: measured

| Sample | streams | durable bytes (MB) | main RSS (MB) | main heap used (MB) |
|---|---|---|---|---|
| baseline (no release) | 8, 8, 8, 8 | 0.9 → 2.4 | 255 → 229 → 221 → 209 | 8.0 → 39.9 |
| with release | 8, 8, **6, 6** | 0.9 → 2.9 | 196 → 157 → 175 → 158 | 27.7 → 43.0 |

Deleting two sessions now takes their streams with them (8 → 6) instead of
leaving them until the process exits, and the byte counters stay inside their
bounds. In this scenario the main process did not climb in either build — its
RSS fell in both runs — so the measured effect of stage 1 is the stream count
and a lower level, not the removal of a slope. The stage-1 run also carries the
main-process inspector, so RSS is comparable in trend rather than in absolute
value; the renderer numbers — which stage 1 does not touch — stayed on the same
trajectory in both runs, which is the control.

The replay-window bounds (per stream 8 MiB, total 64 MiB) are not reached by
this workload — 250 events totalling ~3 MB — so their effect is proven by unit
tests (eviction order, `resync: evicted`, the global budget taking the stalest
stream first) rather than by the soak.

### Stage 2 — Renderer: bounds added, not solved

Implemented: identity reuse of unchanged rows on the read path, a 48 MiB cache
byte budget with tail trimming for off-screen sessions, and a mount window that
shrinks back to `TRANSCRIPT_WINDOW_MIN` when the reader is pinned at the bottom
again.

Measured outcome, stated plainly:

- **Message reuse did not reduce the copy count in this workload**: the heap
  still shows 180 copies of the seeded 64 KiB tool text (48 rows × ~3.75)
  before and after the change. Reuse is proven by test
  (`reuseIdenticalMessages` keeps one object across reads and never replaces a
  changed row with a stale object), so the mechanism works — but the measured
  duplicates are not produced by repeated reads. The retainer chains point at
  the projection (`Object ⟨toolResult⟩ ← Array ⟨[]⟩ ← Object ⟨visible⟩ ← Object
  ⟨projection⟩`), at React fiber props (`⟨messages⟩ ← UI ⟨pendingProps⟩ ← UI
  ⟨alternate⟩`) and at the pane snapshot: objects the projection layer builds,
  which identity reuse cannot collapse. Collapsing them needs the projection to
  hand back the cached row object instead of rebuilding it — a separate change
  with its own risk (the delta path must stay free of historical content
  reads, see below).
- The cache byte budget and the tail trim never fire in the seeded scenario:
  six rows per session and 24 MB of payload are far below 48 MiB. They are
  covered by unit tests (`estimateMessageBytes`, `trimTranscriptTail`) and by
  the off-screen trim rule, not by the soak.
- The mounted window does stay bounded with a long transcript: 300 seeded rows
  per session, 100 loaded by the initial page, and the post-scroll row count
  settles at 61 instead of growing with every top reach.

One constraint discovered while wiring the budget, now part of the invariants:
the live delta path may not walk cached rows, because an existing test asserts
that a tool-partial frame performs **zero** content reads over history. The
byte budget is therefore enforced from the read path only; the delta path only
writes.

### Stage 3 — User MCP idle release: tested, not observable in the soak

Implemented and covered by four unit tests (idle connection closed and
reconnected, in-flight call protected, connecting client protected, dispose
closes everything and stops the sweep). The soak profile configures no MCP
server, so it cannot show this path.

### Supplementary measurement (review follow-up)

The review asked three things: whether the identical heap series was a typo,
what the window renderer actually does in RSS, and whether a long-session
scenario moves anything. Both builds (`main` d4283101 and this branch) were
compiled in their own worktree and run back to back on the same machine with
the same knobs; `main` was run twice so run-to-run noise is visible.

Long scenario: 3 sessions × (2 × 500 KB tool results + 300 short rows),
4 rounds, 8 scroll steps per visit, no deletions. Window-renderer RSS in MB,
then the renderer's JS heap and the mounted rows measured after scrolling back
to the bottom:

| Round | main (pass A) | main (pass B) | this branch |
|---|---|---|---|
| baseline | 159 | 161 | 157 |
| 1 | 229 | 231 | 197 |
| 2 | 259 | 211 | 227 |
| 3 | 262 | 216 | 236 |
| 4 | 265 | 225 | 243 |

Heap used / total for the same rounds, main → this branch:
`7.9/8.8 → 27.9/30.0 → 31.3/34.3 → 33.3/36.3 → 35.0/37.5` versus
`7.9/9.0 → 28.0/29.0 → 31.3/34.5 → 33.3/36.3 → 35.1/38.0`. Mounted rows after
returning to the bottom: 60 in every run of both builds.

What this does and does not show:

- The identical heap series is **not a typo**: the scenario feeds identical
  bytes, and the JS heap after a forced collection is deterministic to 0.1 MB.
  Both builds produce the same heap because stage 2 changed bounds, not what a
  rendered transcript holds.
- RSS is **noisy on this machine**: `main` alone ranged 211–265 MB across two
  passes while the heap moved 0.0 MB. Every point of this branch sits inside or
  below main's range, so there is no evidence of a regression — and no basis for
  claiming an improvement from RSS either.
- The mounted-row count is 60 in both builds, i.e. the scripted scroll never
  grew the window, so the shrink-on-re-pin path is **not exercised end to end**
  here. It is covered by the source test in `transcript-window.test.mjs` only.
- The long scenario still shows the shape the bounds are for: the renderer heap
  climbs 8 → 35 MB while visiting three long sessions, and the per-session cache
  now has both a row window and a byte budget above it.
### Still open

The remaining renderer duplication is the largest single item this PR does not
remove: the projection rebuilds row objects the cache already holds. It needs
its own measurement (the identical-content string count should fall) and its
own guard against historical reads in the delta path.

## 6. Spec and documentation changes

- `02-architecture/05-remote-agent-control.md` §8: replay window is bounded by
  events, age **and bytes**, and an idle session's stream may be dropped; a
  cursor from a dropped stream resyncs by epoch.
- `06-delivery/04-e2e-test-plan.md`: new scenarios for
  `E2E-RACP-idle-stream-is-dropped-and-resyncs` and
  `E2E-TRANSCRIPT-cache-trims-to-tail-window-and-shrinks-mount-window`, plus
  the harness entry when it becomes part of the delivery story.
- ADR 0120/0130/0137: note that cached history outside the visible panes is a
  bounded tail window with a byte budget, and that the mounted window shrinks
  when the reader is pinned again.
- MCP spec note for idle release; new ADR for stage 4.

## 7. Verification

Development gate per stage: build the affected packages, run the tests that
cover the change (`pnpm --filter … test`, `node --test apps/desktop/test/…`),
eslint the changed files, and run `pnpm test:perf:memory-soak` to compare
against the baseline in §3.1. Push gate once before the PR: `pnpm build:js`,
`pnpm typecheck`, `pnpm lint`, `pnpm -r --if-present test`,
`node scripts/check-architecture.mjs`, `pnpm check:agent-policy`, the relevant
E2E suites, and `pnpm check:pr-base`.

Soak acceptance: over several rounds the per-process series stop climbing
(`usedHeap` and RSS both), and after the deletions the main process reports
fewer streams and fewer retained bytes. No absolute GB target is promised.