# ADR 0338: A linked local page renders in the answer surface

- **Status**: Accepted (D680)
- **Date**: 2026-10-23
- **Related**: ADR 0337 (the html fence preview) · ADR 0163 / ADR 0262 (chat file
  references open in the file view) · [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [05-security/01-security](../spec/05-security/01-security.md)

## Context

ADR 0337 made a completed `html` fence readable in place, but a page is not
always written as a fence. `/answer-me-with-html` builds a full one-page
explainer with its CLI, writes it to a file, and ends the reply with
`[打开页面 · 标题](file:///…/page.html)`: pasting a 127 KB page back as a fence
would exceed the 100,000-character preview cap and spend answer tokens on
something already on disk.

ADR 0163 and ADR 0262 then decide what that link does — a `.html` reference in
the transcript is "a page to run", so a click opens it in the work-panel
browser. The phone client goes further: `apps/remote-web` renders the linked
page inline, and the host inlines the file content into the RACP item it
projects there. The desktop transcript renders only the link, so the same
answer is a page on the phone and a click target on the desktop.

## Decision

In an answer surface, a chat link that names a local `.html` page renders that
page in place, through the frame ADR 0337 already defines.

- The surface gate is the existing `renderHtml` flag, set only by assistant
  answer prose, plus the session's local-tool capability — the same capability
  a click on the link already needs. A file preview, a plugin README, a side
  note, a subagent reply, and a session that may not touch local files keep the
  plain link they rendered before.
- The renderer never reads the file. It asks the host for the path with the
  session id through the existing `fs/read` IPC, so allowed roots, remote
  workspaces, the binary check, and the 512 KB text cap stay where they are.
  No IPC channel, permission, or CSP entry is added.
- Only `text` content within the 100,000-character cap becomes a page. A
  binary, missing, empty, unreadable, or oversized file leaves the link, and a
  rejected read is not an error state the reader has to clear.
- The page renders in the ADR 0337 frame: `srcdoc`, an empty `sandbox` by
  default, scripts off until the reader enables them for that block, and the
  same size cap.
- The card keeps one action the fence does not have: open the same page in the
  work-panel browser, which is what a click on the link did before.
- The Markdown renderer rewrites a `file://` destination before a component sees
  it — the scheme is dropped and the rest arrives percent-encoded — so link
  detection accepts both the encoded file destination and an absolute path
  written directly. A relative link (`./page.html`) keeps its existing
  destination rather than becoming an inline page.

## Consequences

- An answer that links a page shows the page, matching the phone client.
- Each rendered link costs one host read per distinct path and session. The
  read is local and bounded, and the effect is keyed by both, so a re-render
  does not re-read.
- The page is not updated after it renders: a link that appeared before the file
  was readable keeps its link form until the row remounts. The link still opens
  the page, so the fallback is never a dead end.
- The document is model output, so the security posture is ADR 0337's, not a
  new one. The added surface is that a reply can now pull a local `.html` file
  the host already allows into a transcript frame without the reader clicking;
  scripts inside it still start off.
- The frame height stays fixed and the host cannot measure a cross-origin
  document, so a tall page scrolls inside the card.