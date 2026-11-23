# ADR persisted-session-origin: A session records how it was created

- Status: Accepted
- Date: 2026-11-23
- Issues: #1291
- Supersedes: the derived-only ownership that hid automation transcripts (issue
  #1291); `scheduledRun` stays as a compatibility field.

## Context

Every session looked the same in the sidebar. The built-in `SessionCreate` tool,
a plugin's spawn, an employee's task and a scheduled run all reached
`session.create`, and none of them left a trace on the session row, so a person
could not tell a conversation they opened from work an agent handed off.

The two places a creator *was* implied both fail as provenance:

- `session_collaboration_links` records a plugin worker, but it is also the
  permission parent chain and the worker-limit ledger. Writing it for the other
  creators would change who may do what.
- `task_runs.session_id` identifies an automation transcript, but retention
  keeps only the newest 100 runs per task, so an `interval` task loses the marker
  of its oldest transcripts and those rows silently change meaning.

`scheduledRun` (issue #1291) was derived from `task_runs` on every read and used
to *hide* those rows from the sidebar and search, because their only entry point
was the Scheduled page. That was the wrong answer for two reasons: the hiding
broke as soon as a run was pruned, and it left every other creator invisible.

## Decision

Store the origin on the session row. Three columns, added in schema v44:

```sql
origin            TEXT NOT NULL DEFAULT 'user'
                  CHECK (origin IN ('user', 'agent', 'plugin', 'task', 'scheduled'))
origin_session_id TEXT   -- the session that created this one
origin_task_id    TEXT   -- the scheduled task of a run transcript
```

The origin is a host-side decision. It is written only by trusted creators:

| Creator | origin | reference |
| --- | --- | --- |
| A conversation the person opens, and every branch/fork | `user` | — |
| Built-in `SessionCreate` tool | `agent` | the dispatching session |
| Plugin spawn and plugin import | `plugin` | the parent session, when one exists |
| Employee task session | `task` | the employee |
| `scheduled.run` transcript | `scheduled` | the task |

`session.create` accepts the three fields as a validated struct, and Electron
main is the only caller that sets them: the renderer's IPC handler drops the
keys from any payload, the RACP `session/create` builds its own field list, and a
plugin's `session/create` goes through a main-only channel where main stamps the
origin and the parent from the invocation it recorded. A branch is the person's
own conversation, so it never inherits its parent's creator.

The column is written once and never edited: deleting the task or the creator
session leaves the origin and the id behind, and the read resolves the id to a
title (or to "unavailable" once that session is gone). A migration backfills the
existing rows from the evidence the old schema still holds — link row, task role,
run row — in that precedence order.

The sidebar renders the origin as one faint label before the title, in the same
vocabulary as the Pi and remote labels, and offers a multi-select filter beside
the archived switch (`sessionView.origins`, persisted with the other sidebar
preferences, missing or invalid read as all).

Automatic transcripts are listed now. One scheduled task folds into a single row
that opens its newest run, keeping the earlier runs one disclosure away, and the
`定时` tag says what the row is. The desktop tray keeps hiding them: an OS menu
row has one line and no place for the tag.

## Consequences

- The sidebar and search can describe a session's creator for as long as the row
  exists, independent of run retention or of a plugin's permission ledger.
- `scheduledRun` stays in the contract. It is a compatibility field for older
  hosts and the tray's own filter; nothing in the listing path reads it.
- The `sessions` table gains three columns and a CHECK. The migration is
  additive (no rebuild), backed up before it runs, and idempotent.
- A creator session that is deleted keeps its id in `origin_session_id` and no
  longer resolves to a title, so the tag's tooltip has a "deleted session"
  wording rather than an empty name.
- The origin is display metadata, not authorization: nothing reads it for a
  permission decision, so a row with an unexpected origin (a newer host's value
  on a downgraded database) reads as `user` and fails closed to "no creator".
- Out of scope: choosing a model or role for `SessionCreate`, any change to
  subagent/task ownership, the Pi-native badge (a different concept), and a
  Scheduled page redesign.

## Alternatives

- Derive the origin on read from links and run rows. Rejected: both sources are
  prunable and one of them carries authorization semantics.
- Reuse `sessions.source`. Rejected: it already means the *import* source
  (`claude-code`, `codex`, …) and the Pi-native transcripts, and the sidebar
  reads it for a different badge.
- Keep hiding automation transcripts and only tag the agent/plugin/task rows.
  Rejected: the person can reach those transcripts from the Scheduled page
  anyway, and a listed session with a tag is more honest than a hidden one.