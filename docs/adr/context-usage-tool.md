# ADR: Model-facing context usage report

- Status: Accepted
- Date: 2026-10-25
- Decision: D684
- Amends: [0064 Codex-parity context compaction](0064-codex-parity-context-compaction.md)

## Context

ADR 0064 gave the model `new_context` and noted that "the model cannot know how
much room is left, so the tool is only useful together with the budget
reminders". Those reminders fire once, inside the last tier before compaction,
so a model that wants to plan earlier — finish a step before compacting, write
a handoff, choose targeted reads over a broad sweep — has nothing to plan with.

The model also cannot work the number out from what users see. The composer
ring divides occupancy by the full context window, while compaction starts at
90% of `hardLimit` (window minus request headroom). With output headroom capped
at 25% of the window, compaction commonly starts near 67.5% of the window, so
"plenty of room left" on the ring and an imminent compaction are both true.

The first-tier reminder's own figure had the same skew: it reported the
distance to `hardLimit`, about 10% of that budget past the point where
compaction actually starts.

## Decision

1. **`ContextUsage`, a parameterless read.** A sidecar-side runtime tool that
   changes nothing and reports the budget the compaction guard decides on,
   measured over the live loop messages so the current turn's tool results
   count: estimated tokens in use, the model window, request headroom,
   `hardLimit`, the automatic trigger, tokens left before it (before
   `hardLimit` when automatic compaction is disabled), whether the count is
   anchored on a provider-reported usage, and whether `new_context` is queued.
   It is computed from the same `context-budget.ts` functions as the guard, so
   the report cannot disagree with when compaction happens.
2. **Core and available in every mode.** It is a fixed declaration like
   `new_context`, allowed in Plan and Goal, and needs no permission card. It
   stays registered while automatic compaction is disabled, because the hard
   limit still applies. `plan_mode_allows` lists it so both sides of the bridge
   agree, as it does for `new_context`.
3. **Denied to delegates.** It reports the parent runtime's budget, which a
   delegate does not run under (ADR 0299 derives the child's budget
   separately), so it joins `SUBAGENT_INHERIT_DENY_TOOLS`.
4. **The reminder states the distance to the trigger.** The first-tier
   reminder still fires on the same `hardLimit`-based tier, but its figure is
   now the distance to the automatic trigger.

## Consequences

- Thresholds, compaction timing, and the composer display are unchanged; only
  the model gains a read and one reminder figure is corrected.
- One more parameterless core declaration is sent with every request.
- The report is an estimate before the first provider usage of a window and
  says so; afterwards it is anchored on the reported usage.
