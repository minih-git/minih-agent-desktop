# ADR session-create-model-and-role: The AI picks the model and a role for a session it creates

- Status: Accepted for implementation
- Date: 2026-11-23
- Supersedes: ADR [session-create-tool](session-create-tool.md) decision 2 ("The
  model is the user's choice, never the model's") and its rejected alternative
  "Require the `availableForSubagents` model flag".
- Amends: ADR [persisted-session-origin](persisted-session-origin.md) (the
  sidebar tag gains the role), ADR [subagent-model-opt-in](subagent-model-opt-in.md)
  (a second caller of the same opt-in boundary), ADR
  [0270](0270-builtin-subagents-can-be-disabled.md) (a switched-off builtin is
  not a role either).

## Context

`SessionCreate({ title })` created every session on one model,
`settings.sessionCreateModel`, and D672 made that a rule: an Agent hand-off must
not spend a model the user never named for it. The rule answered the spend
question and created a different problem. A hand-off is work the model
understands better than the settings row does — "review this diff" wants the
reviewer's model, "fix this test loop" wants the fixer's — and the person asking
for the hand-off in chat had no way to say so. The only way to change it was to
leave the conversation, open Settings, switch the global row (which then applied
to every later hand-off), and come back.

Users also reported the AI picking the wrong subagent. The builtins differ
mainly by what they can touch — `explorer` and `test-runner` have a shell,
`code-reviewer` deliberately has none, `fixer` and `ui-designer` write files —
and that difference lived only in prose inside each description, including a
warning that had to be written as "Has NO Bash". Prose that must be kept in sync
by hand drifts, and a model reading two descriptions that disagree picks by
vibes.

## Decision

### 1. `SessionCreate({ title, model?, agent? })`

Two optional arguments join the title, and nothing else does: the sender, the
project and the permission ceiling stay host-derived, so the model still cannot
forge an identity.

**Priority.** `model` → the named role's own pin →
`settings.sessionCreateModel` → `MODEL_NOT_CONFIGURED`. Omitting both arguments
reproduces the previous behaviour exactly, which is what the earlier regression
tests now pin.

**The model argument.** `model` must name a model the user enabled for AI
delegation — the same `availableForSubagents` set `Task.model` obeys, resolved
by Main, refused with `PERMISSION_DENIED` before any session exists. D672
rejected that flag because it governs delegation, not hand-off; the two are now
one decision, because both are the AI spending a model it chose. Three keys are
not an override, and each is the same "spelled out, not widened" rule the Task
path already has:

- the named role's own default (repeating a definition pin);
- the exact model the dispatching session already runs on;
- the session-creation model the user configured (naming the settings row's own
  value).

A key that resolves to no ready conversation model fails with
`MODEL_UNAVAILABLE`, using the same offer list the settings row shows (ready
chat models minus the image models the page excludes).

### 2. A role, stored on the row

`agent` names one enabled subagent definition — a builtin the user has not
switched off (ADR 0270) or one of their own documents — and the created session
records that handle in a new nullable `sessions.agent_name` column (schema v45).
An unknown or switched-off handle fails with `INVALID_ARGUMENT` listing the
handles that are valid, because creating a session that quietly acts as nobody
is worse than a refusal the model can act on.

**It is a prompt section, not a persona.** Unlike an employee's `botPersona`,
`agentName` narrows nothing. The session keeps its own tool catalog and its own
permission mode; the definition's prompt is appended to the system prompt as one
role section, resolved from the launch's definitions at every turn start. A role
therefore cannot be used to hand a conversation a capability its person did not
give it, and restricting tools to the definition's `tools` is explicitly
rejected: the created session is a real conversation in the sidebar that its
person can open, type into and take over, and a session whose tools silently
differ from its own mode is a permission bug the ADR does not want.

**Permission never widens.** The created session inherits the dispatching
session's ceiling as its row value (`inheritPermissionFromSessionId`), so an
`inherit` parent keeps following the global default exactly as before. A role that
declares its own `permission` narrows it further: `session.create` compares that
request against the parent's **effective** mode — what `inherit` resolves to right
now — and stores the request only when it is strictly narrower; otherwise the
parent's row value stays. The comparison is deliberately against the effective
mode and not against a rank of the stored value: ranking `inherit` as narrowest
would read "the global default" as "the strictest", so a role's `ask` on a global
`auto` machine would be stored as `inherit` and the role session would run at
`auto`. Naming `inherit`, or naming the mode that is already effective, is
inheritance spelled out and changes nothing. That clamp is the one behavioural
change to `session.create`, and it applies equally to the plugin spawn path
(which passes both fields).

**Thinking level.** The role's `thinkingLevel` → `sessionCreateModel.thinkingLevel`
→ the source session's level, clamped by the runtime against the chosen model
exactly as before.

**Resolution, and its failure.** The handle is resolved against the definitions
the launch carries, so editing, deleting or switching off the definition takes
effect on the next turn with no relaunch. A handle that no longer resolves
removes the section and reports one `agent_role_missing` diagnostic — never a
failed turn, because the session is still the conversation it is.

**Trust.** Only Electron main writes the column: the renderer's IPC handler drops
`agentName` alongside the origin keys, the RACP `session/create` builds its own
field list, and a plugin's `session/create` goes through the same main-only
channel. `session.fork` does not copy it, for the same reason it does not copy
the origin: a branch is the person's own conversation. The sidebar's Agent tag
tooltip names the role when the row carries one.

### 3. One delegate catalog, printed by both tools

`Task` and `SessionCreate` reach the same definitions, so one generator produces
the table both descriptions print: name, the one-line purpose, capability columns
derived from the definition's own `tools` / `inheritTools` (`read-only`, `Bash`,
`writes files`, `browser`, `inherits parent tools`) and its default model. The
same module owns the decision rule printed in both — `Task` when the result is
consumed in this turn or the work is parallelizable or short, `SessionCreate` +
`SessionSend` when the person will follow or take over, the work is
long-running, or it needs its own model or visible progress.

The capability sentences the builtin descriptions used to carry by hand are
removed where the table now states them, and a test pins every builtin's
description to the Settings preset that shows the same definition.

## Consequences

- The "hand this to a session — make one if there is none" flow can now hand it
  over the way the work needs: the reviewer's model for a review, a fixer role
  for a fix. The settings row becomes the fallback rather than the only answer.
- A person can see why an AI-created session behaves differently: the row's tag
  tooltip names the role, and the row still belongs to them.
- The two tool descriptions now share one table, which costs prompt tokens twice
  per session. That is the price of the tools not disagreeing; the previous
  hand-written catalogs cost the same in a worse form.
- Schema v45 adds one nullable column with a backup, no rebuild and no backfill.
  A database written by a newer host and reopened by an older one simply reads
  no role, which is the same thing as no role.
- Accepted residual risk: a role's prompt is user-authored text that reaches
  another session's system prompt. That is the trust boundary delegation already
  has — a definition a person installed is a definition their Agent may run —
  and the role adds no capability to it.
- Accepted residual risk: nothing bounds how many sessions one turn creates, or
  how many of them carry a role. The approval card in Ask mode, or the user's
  Auto setting, remains the only lever.
- Specs updated with the implementation: `03-runtime/02-agent-runtime.md` §5f.4a,
  `03-runtime/03-tools-and-permissions.md` (Session messaging),
  `03-runtime/04-data-storage.md` (§4.19f, sessions DDL),
  `04-ux/06-settings-ia.md` (the models page row is the fallback),
  `06-delivery/04-e2e-test-plan.md` (`E2E-SESSION-create-picks-model-and-role`).

## Alternatives

- **Keep the model the user's exclusive choice and add only the role.**
  Rejected: it addresses the wrong complaint. The model is what a hand-off gets
  wrong most often, and the role without its pin would still run the review on
  the session-creation model.
- **Let `model` name any configured model.** Rejected: it is exactly the spend
  the user never authorized, and it would make `SessionCreate.model` a wider
  gate than `Task.model` for the same kind of AI-driven choice.
- **Fall back to the app default model when `sessionCreateModel` is unset.**
  Rejected, as before: an Agent hand-off must not spend a model the user never
  named for it. `model` is the way to name one.
- **Give the role the definition's tool ceiling.** Rejected: the created session
  is a conversation the person can take over. Its permissions come from its own
  mode and the inherited ceiling, not from a label recorded at creation; a
  silently narrower tool set would be a bug they cannot see or undo.
- **Store the resolved prompt instead of the handle.** Rejected: it would freeze
  the definition as it was on the day of creation, so fixing a delegate's
  instructions would never reach the sessions it created.
- **Reject a create whose role definition is later deleted, or edit the row.**
  Rejected: the row keeps history that a person can still read. The definition
  going away is a runtime condition, not a reason to fail a turn or rewrite
  provenance.