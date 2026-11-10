# ADR sidebar-layout-recovery: Recover sidebar layout independently of Chromium storage

- Status: Accepted for this implementation
- Date: 2026-11-08
- Amends: ADR 0016 and the sidebar preference storage contract
- Source: PI-Desktop `b7d03c6576aee0eeede77dca775fd35edb2cc2f8`

## Context

The retained project list and organization exist only in renderer localStorage.
A fresh Chromium profile can hide retained projects while Host projects and
sessions remain intact. Minih additionally retains manual conversation titles
and host-owned logical project groups; recovery must preserve both.

## Decision

Main keeps a private, atomic `sidebar-preferences.json` backup in the selected
application data root. Only the trusted Main top frame can read or replace it
through additive `minih-agent-desktop/sidebar/preferences/get` and `/set` IPC.
Rust still exclusively owns the database, projects, groups, sessions and active
workspace. The renderer cache remains a first-paint optimization.

Restore before bootstrap persists its selected project. The application backup
wins over a cache. Without a backup, migrate valid legacy preferences, including
an explicitly empty retained list. Only when both are absent or invalid may
recovery list registered Host projects. An unreadable backup is never permission
to overwrite it with an empty startup snapshot. Restore generations reject late
results from superseded bootstraps; user changes outrank in-flight recovery.

Backups retain existing path-keyed presentation and `manualTitle` semantics.
Storage relocation remaps internal retained paths and project metadata keys,
never external project paths or display labels. There is no SQLite migration,
plugin capability, remote IPC, credential or transcript backup in this change.

## Consequences and alternatives

Writes are limited to 2 MiB, flushed and atomically renamed with private file
permissions. Disk failures retain the renderer cache and are logged; a failed
backup read disables replacement until a successful restore. Lost pin/name data
cannot be reconstructed when both copies are gone. Keeping localStorage alone
would leave the original failure; moving presentation into project tables would
unnecessarily change authoritative data ownership and database compatibility.
