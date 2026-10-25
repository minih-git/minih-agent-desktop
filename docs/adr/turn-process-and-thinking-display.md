# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-10-17, 2026-10-23
- Issues: #510, #461, #1806
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer, while one flat process
container still leaves long tool/search sequences difficult to scan. Some
readers also need a thinking indicator without rapidly changing reasoning text.

## Decision

One unified turn-process presentation applies to every loaded assistant-turn
entry: it projects the entry into chronological collapsible process segments plus
its trailing answer. Thinking, tools and intermediate assistant text keep their
original order across those segments. A trailing assistant text stays visible
while streaming; if later tool or thinking activity follows, that text moves into
the process without changing the stored message. There is no semantic
final-answer marker in `UiMessage`, so the renderer does not guess intent from
wording. User/system messages and compaction dividers retain their existing turn
boundaries.

The process is segmented rather than one flat container. Non-Bash activity forms
ordinary activity groups: one contiguous tool/search/thinking segment between
progress paragraphs or Bash rows, appearing only when at least two items are
visible under the current thinking preference. A singleton uses its item
disclosure directly; hidden thinking does not create a redundant wrapper.
Existing Task topology remains its segment's container and is not duplicated
inside an ordinary activity group.

Bash and run aliases are excluded from every process disclosure — neither a
turn-level process disclosure nor an ordinary activity group — and render as
standalone rows that stay visible even when every group is collapsed. Adjacent
Bash rows each remain standalone, and a Bash row's detail stays closed until the
user opens it. Other operations between progress paragraphs still form
chronological collapsible activity groups.

Group folding defaults are density-specific and do not depend on the thinking
preference. `standard` folds the completed process behind one header; opening
it shows the narration and one line per step, and no group is force-opened.
`detailed` folds nothing. `compact` starts the ordinary group that owns the
active execution segment open; after completion, an untouched ordinary group
with at most four visible items stays open, a larger ordinary group starts
closed, and a Task topology group stays open. In every density an untouched
active group containing any recorded failed or denied tool stays open through
later recovery and is reconsidered at completion. Bash rows remain visible
regardless of any group's collapsed state.

The thinking preference is a boolean `showThinking`. When it is false, the live
thinking indicator stays visible, while completed thinking rows and excerpts are
hidden and empty thinking-only containers are omitted; the stored reasoning is
retained, so turning the preference back on restores the completed rows and
excerpts. Hidden thinking never creates an empty group wrapper.

The leaf default that an earlier decision first introduced was later removed.
Except for the compact Thinking default below, item payloads never open
themselves: a tool-call, hosted-search or plan row stays a header row until the
user opens it, wherever it sits in the group, and this holds regardless of the
thinking preference. Opening a closed ancestor still exposes the retained item
choices without opening all descendants.

In `compact`, a visible Thinking row is open by default when `showThinking` is
true, and the user may collapse each row independently; the other densities
keep their existing detail defaults. Only `compact` indents a group's child
rows by 12px below the group header. The group's collapse rail sits in that
gutter, invisible at rest, a 2px bar on hover or focus, and collapses the group
when clicked. `standard` and `detailed` add no indentation layer.

A successful Write/Edit that has a review snapshot renders as one tool-level
review row: the file header is the only disclosure header, its diff body sits
directly beneath it, and the body adds a copy action while retaining rollback,
failure reporting, search targeting and the density's detail default. No
duplicate generic tool row is rendered. The main transcript, a followed
subagent transcript and the detail view use the same row. The running marker is
a real flex sibling of the running label, so the header's existing alignment
centres it and the label keeps its truncation; reduced-motion support remains.

Each header toggles only its own level. Parent and child states are independent:
closing a parent preserves descendant choices, reopening restores them, and
sibling groups do not form an accordion. An explicit choice belongs only to its
own level. Focus and selection temporarily hold that level and its ancestors open;
leaving releases the hold without recording a choice. Running-turn groups and
groups with visible reasoning stay open by default; settled plain-tool groups use
the four-row default. Minih density-specific item defaults remain unchanged.
Manual choices survive streaming, completion, preference changes, reparenting,
row remounts and pane eviction in renderer memory. Session deletion or renderer
restart releases that memory; nothing is stored in messages or host settings.

Search/navigation reveals the ancestor path its target needs: the process segment
and the activity group that own the named message. Item-level targeting is not
part of this change, so each row's own details stay behind its own disclosure.
Replaying the same request does not repeatedly override a later manual close.
Reasoning hidden by the preference stays hidden until the user turns
`showThinking` on. Assistant errors, stopped trailing partial answers,
permission/question/plan/goal decisions, and any other pending action surface
remain outside hidden process content and reachable without expanding it.

Settings → AI → Defaults exposes a `Show thinking` boolean that persists as the
optional `showThinking` `AppSettings` field. Absent and non-boolean values fall
back to the legacy `thinkingDisplayMode` field: an explicit `compact` hides
reasoning while `detailed`, an unknown value, or an absent field shows it. The
legacy field is retained for persisted-settings compatibility and is no longer
exposed in the UI. The preference changes presentation only; it does not alter
provider thinking levels, runtime/model context, stored reasoning, export,
permissions, execution, or copy payloads, and it does not control process-segment
or activity-group folding. Process headers use recorded timing, direct tool/search
counts, running state, and issue counts; they do not double-count delegated child
work or treat a failed child as a failed assistant turn. Timing is computed from
the chunk's own parts, so each segmented chunk reports its own span rather than
the whole turn's. A folded completed chunk also previews the most recent progress
text inside it, so a collapsed header still says what the model reported; a
chunk without narration previews nothing, and an active or open chunk shows the
live tail instead of the preview.

The presentation is chosen by one setting, `transcriptDensity`. Narration is
never folded away in any density: the model's progress text is the reading
spine, and what changes is only how much of the work between two narration
paragraphs is shown.

- `standard` — the default — keeps the process open while the turn runs and
  folds it behind one header when the turn finishes; the header states the
  turn's duration, and the final answer stays outside, so a finished turn reads
  as the conclusion. Opening the header shows the narration paragraphs and one
  line per step: the action only ("Ran", "Read", "Searched"), without echoing
  the command or the argument summary, because opening the row itself shows
  that. Bash and run aliases are ordinary steps inside that fold, which
  supersedes the always-visible Standalone-Bash rows of D662: a command-heavy
  turn is exactly the case that has to fold, and the step line keeps what ran
  reachable. Task fan-out keeps its card, because a delegation result is not a
  step the reader scrolls past.
- `detailed` puts every tool, reasoning and run row in the flow with its
  command or argument summary, and opens tool details and completed reasoning
  from the start; it folds nothing.
- `compact` keeps the segmented folding described above, where each
  chronological segment folds on its own, Bash rows stay standalone, and
  ordinary groups state their own step counts. A completed ordinary group with
  at most four visible items stays open; a larger group starts closed, while a
  Task topology group stays open. Visible Thinking rows start open and can be
  collapsed one at a time, and only this density applies the 12px group indent
  with its hover/focus collapse rail.

Chronological part order and the trailing answer never depend on the density,
and the density changes only visibility: it never alters model context, stored
messages, copy payloads, or execution. An absent or unknown value resolves to
`standard`, so an older settings file can never hide a turn's narration. A
density change applies to turns already on screen, and the preference
synchronizes as a portable application field. In every density the turn footer
states the turn's wall-clock span (first recorded part to last recorded end,
tool execution and waits included, not the summed model streaming time) and
counts only the rows the reader can see, so hidden reasoning rows are not
counted as steps.

## Consequences

- Chronological collapsible process segments keep the final answer and actionable
  interruptions reachable, and Bash/run rows stay visible even when every group is
  collapsed.
- Group folding is density-specific: `standard` folds a finished turn behind one
  header, `detailed` folds nothing, and `compact` keeps small completed groups
  (at most four visible items) and Task topology open while larger groups start
  closed. Explicit disclosure choices are preserved regardless of the thinking
  preference.
- A reviewed Write/Edit is one tool-level row with its file header as the only
  disclosure header and its diff body directly beneath it; the diff body can be
  copied, and rollback and failure reporting are unchanged. Only `compact`
  applies the 12px group indent and rail, so `standard` and `detailed` gain no
  extra hierarchy layer.
- When `showThinking` is false, the live indicator stays visible while completed
  reasoning rows and excerpts are hidden. The stored reasoning is retained and
  reappears when the preference is turned back on.
- Bash and run aliases stay standalone rows outside every process disclosure, so
  shell-heavy turns remain scannable without folding adjacent commands together.
- Disclosure memory is pane-owned presentation state with stable turn, group,
  and item identities; it is neither a persisted transcript contract nor a
  central workflow-store concern.
- This groups loaded transcript entries only; it does not reconstruct unloaded
  history or join turns across compaction boundaries.

## Validation

For the 2026-09-20 amendment, the request explicitly limits validation to static
checks and compilation. The linked E2E scenarios describe intended behavior for
source and design review; no unit, component, integration, browser, Electron, or
E2E tests are added or run for this amendment. See
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
For the 2026-09-27 amendment, `apps/desktop/test/turn-process.test.mjs` covers
the default selection, and `pnpm test:e2e:transcript-disclosure` exercises
active-to-completed collapse and user-open retention in real Chromium.
For the 2026-10-16 amendment, `apps/desktop/test/thinking-visibility.test.mjs`
covers the `showThinking`/legacy `thinkingDisplayMode` resolver precedence, and
the i18n catalog tests cover the new `settings.showThinking` copy. The UI,
resolver, and E2E scenarios are validated on the integration candidate; see
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
For the 2026-10-17 amendment, `apps/desktop/test/turn-process.test.mjs` covers
per-chunk timing and the narration preview selector, and the turn-process probe
in `pnpm test:e2e:transcript` asserts both behaviors in real Chromium.
For the same day's density amendment, `apps/desktop/test/transcript-density.test.mjs`
covers the resolver, folding/detail helpers, and settings validation; the
turn-process probe asserts the flat `standard`, opening `detailed`, and folding
`compact` presentations in real Chromium, and the disclosure-anchor and
long-history probes pin `compact` because they assert the folding contract
itself. The review follow-up adds in-place density switching to the turn-process
probe, `turnElapsedMs`/`visibleStepCount` unit tests, pluralized footer copy,
and the config-sync portable-field assertions in host-core. The conclusion-first amendment keeps
`apps/desktop/test/transcript-density.test.mjs` covering the resolver and the
per-density fold choice, and the same probe asserts that a finished turn folds
behind one header stating its duration, that the conclusion stays outside, that
opening it reveals the narration and one line per step without the command echo,
and that `detailed` folds nothing; the probes that assert the segmented folding
contract itself pin `compact`.

For the 2026-10-23 amendment, the request combines documentation with the
implementation in one task and explicitly does not pre-fill test results. The
compact small-group and Thinking defaults, the compact-only 12px grouping, the
single reviewed-edit row with diff copy, and the centred running marker are
documented for E2E-CHAT-turn-process-and-thinking-display and the related
transcript probes; this record does not claim that a new test has run.

## 2026-10-24 visual amendment

Adapt transcript-edge hairlines and compact duration/tool-count metadata without
adopting the upstream display-mode system. Existing Minih density, narration,
thinking, issue, Bash, search and user-owned disclosure semantics above remain.
Missing recorded timing remains absent.

A turn-usage capsule adds the already-normalized parent's input/output/cache-read/
cache-write composition beside existing model/time/step metadata. Reasoning is
already in output and delegated spend is not added. Its exact-count popover is
focus/pointer reachable, above-first and main-pane-constrained, with cleanup on
scroll/resize/session change/unmount. This does not alter usage storage, billing
or the latest-request context inspector. The owning component spec and focused
tests define behavior; actual development results live in the selected-import
source record, not in this design decision.
