# ADR 0330: Durable Reminders for Interactive Prompts

- Status: Accepted
- Date: 2026-10-18
- Related: D117, D295, D350, ADR 0107, ADR 0187, D663,
  E2E-CHAT-interactive-prompt-reminder-survives-a-missed-toast

## Context

An interactive request — an `ask` question, a tool permission, or a plan
approval — blocks the turn until the user answers. The app surfaced it three
ways: the in-app card in the transcript, a toast, and an Electron native banner.

Each surface had a hole.

- The toast auto-dismissed after eight seconds. A user reading another window,
  scrolling the transcript, or simply away from the keyboard lost the only
  always-visible reminder.
- The native banner is suppressed for the exact visible focused session
  (D350 / ADR 0187). That is correct — the user can answer immediately — but it
  means the most common case has no native surface at all.
- Interactive prompts wrote nothing to the durable inbox. D117 created that
  inbox for task outcomes, and D295 narrowed its list to failures; an
  interactive prompt was explicitly excluded.

Together those three choices produced a real failure: a request could be missed
with no durable trace anywhere, and the session stayed blocked until the user
happened to open that conversation again.

## Decision

Record interactive prompts in the durable host inbox, and keep the toast until
the request is resolved.

1. **Two new row families.** The existing `notifications` table (host-core,
   schema v25) accepts `prompt.ask`, `prompt.permission`, and `prompt.plan`
   alongside the task outcomes. A prompt row stores the session-title snapshot,
   the tool name (permission only), the blocked `turn_id`, and the runtime
   `request_id`. It never stores the question text or tool arguments: those
   already live in the transcript, and the inbox is a pointer to it.
2. **Exactly-once by `request_id`.** The v24 table made `turn_id` `NOT NULL
   UNIQUE`, which cannot key a prompt (one turn may ask several times). Schema
   v25 rebuilds the table: `turn_id` becomes nullable, `request_id` is added,
   and two partial unique indexes keep each family unique on its own key — the
   `turn_id` index is limited to the task kinds, so a prompt row records the
   turn it blocks without taking that turn's terminal dedupe key. The migration
   copies every existing row with its id, kind, title, turn, error code, and
   read state.
3. **A new host contract.** `notification.recordPrompt({ sessionId,
   requestId, kind, toolName?, turnId? })` inserts the row and returns it, or
   returns `notification: null` for a replay, an unknown kind, a blank request
   id, or an unknown session. Electron forwards the new allowlisted IPC invoke
   and pushes the accepted row to the renderer on `notification.changed`, so the
   bell and the taskbar badge update without a refetch.
4. **A sticky toast.** The reminder toast uses `duration: 0` and carries its
   `promptRequestId`, so answering (or declining) the request removes exactly
   that toast and marks exactly that row read.
5. **No outcome semantics.** Prompt rows never contribute a session outcome
   badge: `latestSessionOutcomes` skips anything that is not `task.*`. The bell
   lists them because the user must act; the sidebar does not pretend the work
   finished.
6. **Unchanged native policy.** Whether a native banner may appear is still
   D350's decision. The durable row is what survives a suppressed or missed
   banner, not a replacement for it.

## Consequences

- `notifications` is now a two-family table with a rebuild migration
  (schema v24 → v25, with the standard pre-migration backup). Downgrading to a
  pre-v25 build is not supported by the schema, as with every prior version bump.
- Protocol consumers see a wider `AppNotification` `kind` union and two new
  optional fields (`requestId`, `toolName`); `turnId` becomes optional. Readers
  that branch on `kind` must treat `prompt.*` as "needs the user", not as an
  outcome.
- The inbox list rule becomes "failures plus unread prompts". Successful
  completions stay durable-only, as before.
- Prompt retention shares the existing 200-row budget. A pending prompt is the
  newest row when it is written, so it survives normal pruning.
- Nine locales gain `notifications.promptAskTitle` / `promptAskBody`; the
  permission and plan rows reuse the existing banner copy.
- The plan-approval path reports `proposalId` as the request id. A planning
  event without a proposal id records nothing rather than inventing a key.
