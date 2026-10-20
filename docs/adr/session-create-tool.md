# ADR: Agent-created sessions for a hand-off with no target

- Status: Accepted
- Date: 2026-10-20
- Decision: D672
- Amends: [Built-in session messaging](builtin-session-messaging.md) (D663)

## Context

D663 added the built-in, on-demand Agent tools `SessionList`, `SessionSend` and
`SessionResult` so a user can hand work to another session without installing a
plugin, and deliberately stopped short of creation: "Version one sends `task`
or `message` deliveries to existing sessions and does not create sessions
(`spawn`)". The hand-off a user actually asks for is often the one where the
target does not exist yet — "let a session review this" with no review session
in the list — and there the flow stopped at the first step: the model could
only report that it cannot create a session, and the user had to leave the
conversation, create one by hand, and repeat the request.

The host already owns session creation (`session.create`, used by the desktop's
own new-session path), and the plugin path already had a wider `spawn` that
creates a linked worker and delivers a task in one transaction. Neither was
reachable from the built-in tools.

## Decision

1. **A separate creation tool.** Add `SessionCreate({ title })` as a fourth
   built-in, on-demand Agent tool, implemented as an Electron main local tool on
   the same trusted entry point as the other three. It creates exactly one
   ordinary Agent-mode session and returns its Session ID; it starts no turn,
   sends nothing, and never renames or reuses an existing session. The model
   then delivers with `SessionSend`, which keeps one meaning per tool: creation
   is creation, delivery is delivery.
2. **The model is the user's choice, never the model's.** The created session
   runs on `settings.sessionCreateModel` (`{ providerId, modelId }`), a new
   entry in AI settings. While it is unset, `SessionCreate` fails with
   `MODEL_NOT_CONFIGURED`; while the pairing is not one the picker offers, it
   fails with `MODEL_UNAVAILABLE`. That offer list is one rule on both sides: a
   provider that is enabled, credentialed and configuring at least one model,
   minus every image model the settings page excludes — the stored
   `imageGenerationModels` candidates merged with the active `imageGeneration`
   default through the shared image helper, which is the whole set both sides
   resolve. The settings row and `SessionCreate` therefore
   cannot disagree: a pairing the row shows as currently unavailable never
   creates a session. There is no fallback to the app default model — the same
   stance the plugin spawn path takes, for the same reason: an Agent hand-off
   must not spend a model the user never named for it.
3. **Host-derived context, one argument.** Only `title` (1–80 characters) comes
   from the call. The new session inherits the sending session's project,
   thinking level and permission mode (`inheritPermissionFromSessionId`) and is
   created in `agent` mode, so a created session can neither work in a project
   nor hold a permission mode the session it came from did not have.
4. **The same gate as the other session tools.** `SessionCreate` passes
   host-core's `tools.execute` gate as `High` risk (Ask shows an approval card,
   Auto proceeds), is Agent-only, is denied in Plan and Goal, is never handed to
   a `Task` subagent, is absent from the MCP control catalog, and is abortable —
   stopping the turn retracts its pending approval. It stays on-demand
   (ToolSearch) rather than core.
5. **An ordinary session, not a worker.** Creation uses `session.create`, so the
   new session carries no `session_collaboration_links` row and no plugin
   ownership. It may create sessions itself under the same gate, and any work it
   does still starts only when a delivery arrives, so the existing autonomous hop
   budget and the eight-delivery inbox remain the bounds on what a chain of
   Agent-created sessions can spend. Creation alone starts no turn and spends no
   quota.
6. **Local, not portable.** `sessionCreateModel` is a per-machine capability
   choice: it stays out of `PORTABLE_APPLICATION_FIELDS` like the other
   non-portable settings, and host-core validates its shape on `settings.set`.
7. **Nothing else moves.** `SessionSend` keeps its contract, its `High` risk and
   its refusal to create. `SessionList`'s empty answer now points at
   `SessionCreate` instead of saying that creation is impossible.

## Consequences

- The "hand this to a session — make one if there is none" flow completes inside
  the Agent. The created session appears in the session list through the
  existing `sessionsChanged` event, runs on the model the user configured for it,
  and can be renamed, archived or deleted like any other session.
- In Auto mode the model can add sessions to the user's list without a per-call
  approval. Those sessions are visible, deletable, and inert until a delivery
  arrives, and their work stays inside the delivery budget; a hand-off chain
  cannot spend quota by creating sessions alone.
- Accepted residual risk: nothing bounds how many sessions one turn may create
  beyond the approval card and the model's own judgement. The plugin spawn
  path's worker limits (4 active per parent, 16 per owner) are not reused,
  because the built-in path deliberately creates ordinary sessions rather than
  linked workers. If a runaway is observed in practice, a per-turn creation cap
  is the next step; it is not added speculatively.
- Specs updated with the implementation: `03-runtime/02-agent-runtime.md` §5f.4,
  `03-runtime/03-tools-and-permissions.md` (Session messaging, §10.2),
  `04-ux/06-settings-ia.md` (the models page rows), `06-delivery/04-e2e-test-plan.md`.

## Alternatives

- **Extend `SessionSend` with a new-session form.** Rejected: one tool with two
  target shapes makes the model-facing contract ambiguous, and the user asked
  for creation as its own step.
- **Match a target by title and create only on zero matches.** Rejected: titles
  are not unique, and delivering work to the wrong session is a worse failure
  than one extra tool call; the ADR keeps "confirm an ambiguous target with the
  user" as the rule.
- **Reuse the plugin path's `session.collaboration.spawn`.** Rejected: spawn
  always delivers a task in the same transaction and marks the session as a
  plugin-owned worker with plugin fan-out bounds, which is not what a
  user-visible session created on the user's own instruction is.
- **Require the `availableForSubagents` model flag.** Rejected: that flag governs
  AI-driven delegation to delegates. The user chose an explicit session-creation
  setting instead, which keeps delegation opt-ins and hand-off opt-ins separate.
