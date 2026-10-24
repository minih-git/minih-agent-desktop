# ADR: Browser execution outlives presentation

- Status: Accepted
- Date: 2026-10-24
- Amends: [retained pages](retained-browser-pages-per-tab.md)

## Context

A Browser tool must continue working for its conversation while another chat is
visible or the renderer reloads. Tying page lifetime or navigation to renderer
tab creation loses hidden work and can route an operation to the visible chat.

## Decision

Electron Main owns live pages keyed by session/tab. The renderer owns selection,
bounds and presentation. A lazy invisible sandboxed backing window hosts parked
views and is released when its final surface is removed. Showing a page reuses
its existing view. No second visible browser window is introduced.

Trusted invocation session identity selects the connected page. Closing that
page makes later operations fail until explicit navigation/preview reconnects;
never silently substitute another tab or conversation. Navigation and validated
local preview establish/load the Main-owned page before notifying presentation.
Hidden work does not reopen a panel or take focus.

Renderer reload detaches presentation only. Session-filtered `browser/getPages`
restores missing tabs without replacing selection; stale restoration replies are
discarded. Pointer/capture operations use page-relative coordinates and a per-page
viewport queue, restoring bounds/throttling after success, failure or timeout.
Explicit closure, surface disposal, window destruction and shutdown release pages,
watchers and debugger resources. Guest crashes/restarts do not guarantee DOM recovery.

## Alternatives and consequences

Retaining only URLs cannot preserve live DOM/JavaScript. A visible browser window
or automatic panel reopening would steal focus. Persisting arbitrary DOM is not
a reliable substitute for retained WebContents.

Memory follows open pages until explicit cleanup. Existing URL/file-root checks,
cookie partitions, local/remote boundaries, permission checks, CDP allowlists and
deadlines remain authoritative. Unscoped UI calls retain their visible-page
boundary. Existing transport plumbing changes only to carry trusted ownership;
no unrelated extension API, permission, storage schema or startup replay is added.
