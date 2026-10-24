# ADR: Retain a host-owned browser page per resource tab

- Status: Accepted
- Date: 2026-09-26
- Supersedes: ADR 0170 clause 6 (singleton guest)

## Context

Browser resource tabs initially retained addresses but shared one guest. Switching
reloaded pages and discarded form/scroll/JavaScript state. Mixing session-only
navigation with tab addresses also allowed BrowserPreview to overwrite the active
tab, background navigation to lose its destination, and empty tabs to expose old
state. The requested behavior is to keep each open tab's live page.

## Decision

Electron Main's BrowserHost owns pages keyed by session id and tab id. Each page
owns its BrowserPane, CDP state, navigation generation, and current browser state.
Only the selected page is attached to the measured browser hole; hidden pages
retain their WebContents and use Chromium background throttling. The browser
partition and existing URL, permission, file-root and CDP allowlists stay intact.

Amended 2026-10-24: Main establishes and loads the session/tab page before
BrowserPreview notifies the renderer. Hidden-session navigation executes without
depending on a renderer tab or reopening its panel. Parked views use an invisible
backing host. Trusted agent operations target their connected page and fail if it
was explicitly closed, until navigate/preview reconnects; no other visible tab is
substituted. Bundled chrome requests remain session/tab-scoped.

Closing a tab releases its page and CDP state. Session deletion, plugin disposal,
window destruction and shutdown release corresponding pages. Renderer reload
detaches presentation only; session-filtered `browser/getPages` restores missing
tabs with stale-reply protection. See [lifecycle amendment](browser-execution-presentation-lifecycle.md).
This iteration does not automatically evict pages or persist their DOM across
application restarts. Navigation/reload can still reset state as on a normal
browser, and page crashes do not promise preservation of unsaved form data.

## Alternatives

Keeping one guest and saving only URLs cannot preserve live page state. Saving
and restoring arbitrary DOM/JavaScript state is not a reliable substitute for a
retained WebContents. Automatic suspension with serialized navigation state is
possible later, but needs explicit recovery and unsaved-input handling.

## Consequences

Normal tab switching preserves forms, scroll position and per-tab navigation
history without issuing another load. Memory usage grows with open pages; users
release that memory by closing tabs. No database schema or plugin permission is
added. Independent page ownership prevents stale work from changing another tab.
