# ADR: Preserve macOS glass with a restart-bound opaque preference

- Status: Accepted for implementation
- Date: 2026-10-21
- Source: PI-Desktop final tree `494b5f7c8f908aaf1f04bd5e86572dd32ec15167`

## Context

Native sidebar vibrancy over a transparent Electron window can increase the
macOS compositor's work. Removing it by default changes the shipped Minih
appearance. Electron fixes the transparent option at window creation; a live
background colour change is not equivalent to an opaque native window.

## Decision

Keep glass by default. An optional boolean in the existing Host-owned settings
JSON selects an opaque main window only when explicitly false. Read before
window creation, hold applied state for that process, and report it through the
existing window state response. The macOS-only Appearance row compares stored
and applied state for its restart hint. The row shows read/save errors and
keeps its switch busy until saving settles.
Do not change tint, sheen, layout, other platforms, or Minih identity. This
additive optional setting follows existing settings extension semantics and
needs no database schema migration.

## Consequences and alternatives

Users can choose appearance versus compositor cost without losing the existing
default. Switching requires relaunch. No numerical performance promise follows
from upstream measurements; local hardware needs its own controlled comparison.
A silent opaque default and pretending to toggle transparency live are rejected.
Regression tests cover default/off/on, pending-restart reversal, theme, startup
and invalid input; isolated UI/native tests validate the actual user path.
