# ADR 0337: The html fence preview

- **Status**: Accepted (D677)
- **Date**: 2026-10-21
- **Related**: ADR 0165 (Mermaid diagrams) · ADR 0104 / D246 (plugin work-panel
  views) · [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [05-security/01-security](../spec/05-security/01-security.md)

## Context

A completed `mermaid` fence in assistant prose renders as a diagram, but a
completed `html` fence stays a plain code block. A model that answers with
markup therefore hands the reader a wall of source with no way to see the
result.

The host can already render an HTML file: the `BrowserPreview` tool opens one in
the work-panel browser, a main-process `WebContentsView` with `sandbox: true`,
`contextIsolation: true`, and its own partition. That path needs a file on disk
and a second surface, so it does not answer "show me this markup".

## Decision

A completed `html` fence in answer prose renders in place through a sandboxed
`srcdoc` iframe.

- `srcdoc` feeds the frame, so it inherits the app CSP. No `frame-src`, no new
  scheme, and no widened `connect-src` is needed.
- The default sandbox token list is empty, which gives the frame an opaque
  origin. The transcript document cannot read into it, and it cannot read the
  transcript.
- Scripts stay off until the reader enables them for that one block. Fence
  content is model output, so the default must not execute it. Enabling scripts
  rebuilds the frame with `allow-scripts`; a changed source returns the block to
  the default.
- The frame carries no preload bridge. The main window leaves
  `nodeIntegrationInSubFrames` off, so no preload runs in a frame and
  `window.minihAgent` does not exist inside it.
- A fence longer than 100,000 characters fails closed to the source view, like
  an oversized diagram.
- Thinking prose keeps `html` fences as source, because it already renders with
  `renderDiagrams={false}`.

## Consequences

- An answer can show markup where it is written, with no file and no second
  surface.
- The residual risk is bounded but real. A frame with scripts enabled still
  reaches what the CSP allows (`'self'`, `localhost`, `plugin-renderer:`), so a
  hostile fence can talk to a local service. That is why scripts default to off.
- The preview frame has a fixed height. The host cannot measure a cross-origin
  document, so a taller page scrolls inside the frame.
- An iframe has no partition of its own (D246), so this is weaker isolation than
  the work-panel `WebContentsView`. The trade is accepted only because the frame
  holds an opaque origin, carries no preload bridge, and starts script-free. A
  preview that later needs host capabilities should move to the work-panel
  browser instead.
