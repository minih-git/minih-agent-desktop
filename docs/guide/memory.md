---
title: Learned memory
description: Ask the agent to remember something, review what it kept, and turn learning off.
---

# Learned memory

Minih-Agent-Desktop keeps three kinds of durable context apart:

- **Project instructions** (`AGENTS.md` and friends) are rules the agent must
  follow. They are files in your workspace.
- **Project memory** (the pinned editor in the project menu) is the full text you
  curate yourself. It is loaded at every session start.
- **Learned memory** is a set of short, dated notes: preferences, feedback, facts
  and references that earlier conversations produced. A new session starts with a
  bounded index of them, and the agent can search the rest on demand.

## Ask the agent to remember something

Say what you want kept — "remember that I want terse Chinese replies", "note that
this gateway deploys on Fridays". The agent calls `MemoryRemember`, which asks for
your approval first, and the conversation shows a receipt with what was saved and
whether it applies to this project or to you across every project.

The receipt offers two actions:

- **Edit** changes the wording. If something else changed the same note first,
  you are told and the list reloads instead of overwriting it.
- **Undo** deletes the note. Deleting is not a hide: the text is erased, and the
  agent cannot be talked into recreating it — not by asking, and not by anything
  written inside a file it reads. If you do want it back, the receipt of the
  deleted note offers **Remember it again**; only you can press it.

A note applies from the **next** session. The conversation you are in keeps the
memory snapshot it started with, so asking the agent to remember something never
disturbs what it already has.

Notes that look like credentials — API keys, tokens, private keys, passwords in a
URL — are refused, and the refused text is not stored, logged, or echoed back.

## Review and clean up

Open **Learned memory** from a project's row menu in Settings → Project archive,
next to **Project memory**. Settings → AI carries the same manager for the notes
that apply to you across every project.

The manager lists the notes of one scope, filters by kind and status, and lets you
edit, archive, restore, or delete each one. Archiving hides a note without
forgetting it, so it can come back; deleting is permanent. When a note came from a
conversation, the manager can open that conversation.

The pinned memory editor is a separate surface and still works the same way; the
two link to each other.

## What this device has used

The foot of the manager shows how learned memory is doing **on this device**: the
size of the index the last session started with, how many suggestions you kept or
discarded and at what rate, how often a delete stopped a write, and what
extraction has spent today. These numbers are local. They are not uploaded
anywhere and they do not travel with config sync, so another device shows its
own.

## Turn it off

- **Settings → AI → Use learned memory** hides the session-start index and every
  learned-memory tool. Nothing is deleted, and turning it back on restores them.
  The switch travels with config sync, so your devices agree.
- **Session menu → Don't learn from this conversation** keeps this conversation
  out of extraction, including runs already waiting to start.
- **Settings → AI → Learn automatically** is off by default, and it cannot be turned on
  until you choose a **Learning model**. Every run spends that model's quota, so
  the switch is yours to make; the warning next to it says so.

## Learn automatically (optional)

When learning is on, the app reads your own messages after a conversation
settles (ten idle minutes) or after it compacts, and asks the chosen model for
notes worth keeping. Nothing else travels: tool results and the agent's replies
are never sent, and the request is capped at 16 KiB of your own words plus the
latest compaction summary.

What comes back is a **suggestion**, never a memory. Open the manager: the
**Suggestions** tab shows each proposal with its kind, scope, and the sentence of
yours it came from. **Keep** makes it memory; **Discard** erases it and records
that this evidence was rejected, so it is not proposed again. The tab carries a
quiet count and never interrupts you.

Each run costs tokens from the model you chose. **Daily token budget** caps that,
and **Used today** shows where you stand; when the ceiling is reached, learning
pauses until tomorrow and the line says so. Learning settings are per device:
another machine picks its own model and its own budget.

## Sync

Learned memory travels with **Settings → Cloud sync** when the opt-in **Memory**
category is on, exactly like pinned project memory: the notes you kept, in both
scopes, and the deletes that keep a forgotten note from coming back. Suggestions,
the learning cursor, and the counters above stay on the device that made them. A
delete you make here is enforced there, so the same sentence cannot be learned
again from the same conversation on another machine.

Two devices that wrote the same note end up with one note rather than two, because
a note's identity is its own text and not the device that stored it. Two devices
that each wrote a different note keep both: notes are merged one by one, so
syncing never asks you to choose between two sets of notes.

**Every device of a vault must run this version or newer.** A device on an older
build cannot read a revision that carries learned memory, so it stops syncing —
and restoring — until it is updated. Update all your devices before you turn the
memory category on.

Two things to know about the order and the volume. A delete and a note are
ordered by the time each device wrote them, so a computer whose clock is far off
can order a delete and an edit the wrong way; keep device clocks reasonably in
sync. And at most 500 notes of one scope travel per sync: a project with more
notes syncs its newest 500, and the rest stay on the device that has them.

## What the agent can do with it

Besides the short index it starts with, the agent has three tools:

- `MemorySearch` reads the notes that apply to this project and to you.
- `SessionHistorySearch` looks through this project's earlier conversations and
  returns short snippets. Reading another project's conversations is a separate,
  approved action.
- `MemoryRemember` saves a new note.

All three present what they return as dated context, not instructions: the agent
is expected to check anything about code or the environment against the current
workspace before relying on it, and to follow your current request over an older
note.
