# ADR 0335: Plugins may show a local file in the work-panel Browser view

- Status: Accepted
- Date: 2026-10-21
- Related: ADR 0104 (plugin-contributed work-panel views), ADR 0263 (project folder roots)

## Context

The Browser view is host-owned and session-keyed. `pi.browser.navigate` therefore
requires the view to be the visible work-panel tab **and** a session of the
caller's: `browser.reveal` resolves the session from the tool call in flight. A
plugin surface that is not a tool call — a reply card drawn through a renderer
slot, or a button in the plugin's own panel — has no session, so it can never
satisfy that rule and always falls back to opening the file in the OS browser.

The renderer, however, knows which session the window is showing, and it already
handles `browser:event:preview` by opening a Browser tab for that session. The
missing piece was a caller that can ask for it.

## Decision

Add `pi.browser.openInPanel({ path })`, gated by the existing high-risk
`browser.cdp` permission.

- The host validates the request before emitting anything: absolute path, existing
  regular file, and resolved inside the open project's folder roots, a session
  scratch directory, or the calling plugin's own data directory. Other paths fail
  with `INVALID_ARGUMENT`.
- The host emits the existing `browser:event:preview` IPC with an empty
  `sessionId`; the renderer substitutes its active session and opens the tab. No
  new IPC channel, no new permission, no change to existing payloads (an empty
  `sessionId` was never emitted before).
- `navigate` keeps its behavior; `openInPanel` is additive.

## Consequences

- A plugin can put a rendered page in front of the user even when the Browser
  panel is closed, which is what an "open the page I just made" button needs.
- The allowed-root check is the security boundary: the panel never shows a file
  from a path the plugin chose outside those roots. A plugin that wants its own
  storage must use the data directory it is given.
- Reusing `browser.cdp` keeps the permission surface unchanged, at the cost of a
  slightly wider reading of that permission: "control the browser" now also means
  "show this file in it". A narrower permission can be split out later without
  changing this API.
