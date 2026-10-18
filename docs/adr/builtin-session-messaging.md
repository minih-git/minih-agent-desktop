# ADR: Built-in session messaging tools

- Status: Accepted
- Date: 2026-10-18
- Decision: D663
- Amends: ADR 0165, ADR 0239 (D409), ADR 0240 (D410)
- Design: [Built-in session messaging design](../superpowers/specs/2026-10-18-builtin-session-messaging-design.md)

## Context

Users regularly hand work from one Agent session to another existing session,
for example asking a dedicated review session to review the change just made in
an implementation session. Today they copy the prompt between sessions by hand.

ADR 0165 (D326) withdrew the A2A broker and the `A2A` / `Peer` tools. ADR 0239
(D409) then reintroduced durable cross-session communication as a deliberate
plugin-mediated exception: Rust host-core owns the session collaboration ledger
(`session.collaboration.*`), and Electron Main's collaboration service admits
mutations only from an authenticated plugin Agent tool invocation
(`services/session-collaboration.ts`, `invoke()` rejects any caller whose
`source` is not `plugin`).

As a result the reviewed ledger ships in every installation, but an Agent can
reach it only after the user installs the marketplace plugin
`pi.session-orchestrator`. That plugin is community trust, unverified, and asks
for broader powers (spawn, supervise, wait polling, cancel) than the common
"send this to that session" need. D660 already established the precedent of
replacing a plugin with a narrower built-in when the capability is core to the
desktop workflow.

## Decision

Add three built-in, on-demand Agent tools — `SessionList`, `SessionSend`, and
`SessionResult` — implemented as Electron Main local tools that call the
existing collaboration service through a new trusted built-in entry point. The
host ledger, its schema, and its invariants are reused unchanged.

1. **Sender identity is host-derived.** The source Session ID is the
   `sessionId` the sidecar attaches to the local tool invocation, and the
   source turn is the `turnId` that same invocation declared — it must still be
   the session's active turn, the exact rule the plugin path applies. Tool
   arguments never supply or override either. A call without an active turn, or
   from a turn that has since ended, fails with `PERMISSION_DENIED`; stopping a
   turn retracts its pending approval.
2. **Reserved owner.** Built-in deliveries are recorded with the owner value
   `builtin:session-messaging` in the ledger's existing `plugin_id` column. Main
   constructs this value only on the built-in path, and the plugin path rejects
   any plugin context that presents it. The value cannot match an id produced by
   the plugin devkit (`PLUGIN_ID_PATTERN` has no `:`), but host-core does not
   enforce that pattern at install time, so the explicit rejection is required.
3. **Normal approval path.** Local tools bypass host-core's permission
   boundary, so all three tools first pass host-core's `tools.execute` gate,
   the pattern `GenerateImages` uses. `SessionSend` is `High` risk;
   `SessionList` and `SessionResult` are `Low` risk. In Ask mode a send
   therefore shows an approval card; Auto proceeds. The gate runs before the
   local-tool deadline starts, so a slow approval cannot time the send out
   after the user approved it.
4. **Narrow availability.** The tools exist only in Agent mode. Plan and Goal
   deny them (the sidecar's local-tool Plan fence and host-core's contract-mode
   allowlist). They are not assignable to `Task` subagents, not exposed through
   the MCP control catalog, and are on-demand (ToolSearch) rather than core.
5. **Narrow scope.** Version one sends `task` or `message` deliveries to
   existing sessions only, with `notifyOnCompletion` defaulting to true. Both
   kinds start or queue the target turn; the kind only frames intent. It does
   not create sessions (`spawn`) or cancel deliveries. Name-to-session resolution
   is done by the model through `SessionList`; an ambiguous match must be
   confirmed with the user rather than guessed. Reads are limited to deliveries
   the calling session made: another sender's task text is not readable this way.
6. **Reused invariants.** Target must be an Agent-mode session; the target's
   effective permission mode must not exceed the sender's; at most eight queued
   deliveries per target; the autonomous hop budget; idempotency; transcript
   provenance as a session message rather than human input; at-most-once
   completion callbacks; the restart fence. None of these change.
7. **Coexistence.** The plugin path is unchanged. Owner checks keep the plugin
   and built-in deliveries from cancelling each other.

## Consequences

- Cross-session hand-off works without installing a plugin, while keeping the
  ledger's provenance, permission ceiling, callback, and restart guarantees.
- In Auto mode the model can start turns in other sessions and spend model quota
  without a per-call approval. The hop budget, the eight-delivery inbox, the
  permission ceiling, and the labelled transcript provenance bound and expose
  this; Ask mode keeps per-call approval.
- ADR 0165's withdrawal of built-in cross-session coordination is narrowed, not
  reversed: the A2A broker, `Peer`, and sibling-delegate messaging stay
  withdrawn, and `Task` / `TaskWait` / `TaskList` / `TaskStop` are unchanged.
- Rust changes are limited to the tool risk table, a gate arm in
  `tools.execute`, and making the send approval abortable. There is no
  storage schema, migration, or protocol version change.
- Specs that describe session collaboration as first-party-plugin-only must be
  updated together with the implementation.

## Alternatives

- **Keep the plugin-only path.** Rejected: it leaves a core workflow behind a
  community plugin with broader powers than the workflow needs.
- **Bundle `pi.session-orchestrator` as a built-in plugin.** Rejected: it is
  maintained outside this repository, carries spawn / supervise / polling
  behaviour this workflow does not need, and would make a community package part
  of the application's release surface.
- **Restore `A2A` / `Peer`.** Rejected for the reasons recorded in ADR 0165.
- **Send through the MCP control server's `agent/prompt`.** Rejected: the
  delivery would appear as human input without session-message provenance or a
  completion callback.
