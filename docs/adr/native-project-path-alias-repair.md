# ADR: Native project alias repair and stored ownership

- Status: Accepted implementation candidate
- Date: 2026-11-09
- Scope: selective PI-Desktop b55628bf4/e89807ba0 adaptation
- Amends: ADR 0251; existing project-path persistence behavior

## Context

A native case-insensitive filesystem can resolve historical path spellings to
one directory while SQLite still stores separate projects. Removing one spelling
could leave another project's sessions behind. Conversely, resolving a stored
symlink after it is retargeted can select a different project's data. Minih's
v28 keep-warm and v29 archive migrations already occupy upstream's version range.

## Decision

Use a backed-up v29-to-v30 repair in Rust's database domain. Native resolution
must confirm aliases; case folding alone never decides ownership. Keep one row
with session ownership first, then latest opening and lowest id; rebind all
sessions and schedules before deleting duplicate project rows. Preserve original
pinned-memory records and reuse the learned layer's scope merge for notes,
forgetting evidence and extraction cursors. Do not rewrite transcript bytes.

Repeat reconciliation on listing, upsert and removal for roots becoming available
later. Destructive operations prefer a selected stored spelling before following
its fallback canonical target. Their schedules and memory use the same selected
identity. Remote project ids stay opaque. Case-sensitive directories and
unavailable roots do not become aliases without native proof.

No process, database ownership, permission, RPC signature or protocol-version
change. The explicit removal confirmation and busy-session/task refusal remain.

## Consequences

A platform-wide lowercase rule would conflate distinct case-sensitive roots.
Deleting duplicate rows without rebinding would orphan durable data. The selected
repair instead runs atomically with a verified pre-upgrade backup and can be
retried after failure. Older builds refuse schema v30; rollback requires the
pre-upgrade backup rather than opening repaired data with an older build.

Executable behavior and verification are recorded in the
[storage spec](../spec/03-runtime/04-data-storage.md) and
[selected adaptation](../project/upstream-import-2026-11-09-reliability-path-scroll.md).
