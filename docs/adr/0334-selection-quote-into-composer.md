# ADR 0334: Quote a transcript selection into the composer

- **Status**: Accepted (D674; supersedes ADR 0268 item 2)
- **Date**: 2026-10-20
- **Supersedes**: ADR 0268 item 2 (selection overlay and the composer quote path)
- **Preserves**: ADR 0268 items 1, 3, 4, 5 (no Quote action in the action row, no
  annotations, no annotation prompt block, no renderer-owned side chats)
- **Related**: [04-ux/08-component-spec](../spec/04-ux/08-component-spec.md) ·
  [04-ux/09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md) ·
  [06-delivery/04-e2e-test-plan](../spec/06-delivery/04-e2e-test-plan.md) ·
  ADR 0268 · D619 (`lib/selection-tex.ts`)

## Context

ADR 0268 removed the floating selection overlay, the Quote action, and the
composer's quote prefill, and rested that removal on the OS clipboard being the
substitute: quoting "has an exact substitute in the OS clipboard and the
composer". Reading a long answer and then re-typing the sentence the question is
about is the everyday version of that substitute, and it is worse than the
gesture it replaced: copying leaves the passage behind, and a paste into the
composer cannot say which part of the conversation it came from.

The Codex client keeps the gesture: select a passage in the conversation and one
action puts it into the prompt box. Users coming from it ask for the same thing
here. Nothing about the send path, the transcript, annotations, or side chats is
implicated; only the two pieces ADR 0268 deleted for this entry point are.

The reason ADR 0268 gave for deleting them was size and second serializations,
not that the gesture was wrong. Both concerns are answerable now, because a
later decision (D619) added `lib/selection-tex.ts` as the one place a rendered
selection is read back as Markdown source:

- The quote path no longer needs its own formula reduction. A quoted formula is
  read through the same module the clipboard uses, so there is one reading of
  `$…$` / `$$…$$`, one fence-width rule, and one padding rule.
- The composer needs no new store state and no prefill channel. A quote is
  written straight into the mounted composer's draft, at its caret, through a
  registered sink; per-session drafts, chips and Smart Stop keep their existing
  owners.

## Decision

1. **Selection overlay.** Selecting text inside one transcript row floats one
   pill above the selection, centered on it, clamped into the visible band of
   the scroller and below the docked composer's top edge. The pill is portaled
   to `document.body` and positioned in viewport coordinates, so it never
   enters the transcript's layout or scroll extent, and a hidden retained pane
   renders none (`PortalVisibilityContext`). It follows the selection while the
   thread scrolls instead of dismissing. A selection that starts in one row and
   ends in another, or that lies outside this transcript, is not owned.
2. **One action.** The pill carries a single action: put the selection into the
   message box. No Copy button (the OS clipboard and the existing hover Copy
   already do that), no annotation entry point, no side chat, and no message
   action row item — the action row keeps exactly what ADR 0268 left it.
3. **Selection → Markdown.** The selection is reduced from rendered DOM back to
   source before it becomes draft text: formulas through `lib/selection-tex.ts`
   (`annotation[encoding="application/x-tex"]`, `texSource`), code blocks as a
   fenced block that keeps its language and outgrows any backtick run inside,
   tables as one `a | b` line per row, task checkboxes as `[x]` / `[ ]`, list
   items and headings with their markers when the selection spans them (a block
   that is the range's own ancestor contributes only its text), and the row's
   own chrome dropped while file-reference chips keep their text: action bars,
   code-block headers, the turn's process and tool disclosures, standalone run
   rows, and the meta chips under an answer (model, duration, token counts). A
   fence keeps the language rail a drag over the code leaves as a sibling of the
   `pre`, and a fence's own body is reduced verbatim — its blank lines and
   trailing spaces are the code, so they are never collapsed. The read happens
   when the pill appears, because the DOM under it can change while it stays on
   screen.
4. **Draft write.** The excerpt is capped at 2000 characters (cut on a code point
   boundary and marked with an ellipsis) and written as a Markdown blockquote,
   separated from what the user already typed by one blank line, at the draft's
   caret, with the chips already in the draft preserved. A successful action
   consumes the selection and focuses the composer; when no composer is taking
   input the pill says so through the toast host and leaves the selection alone,
   which is still the clipboard fallback.
5. **One write path.** `features/chat/composer/quote-sink.ts` holds the single
   registered composer handle; `useComposerQuoteSink` lends the live editor and
   draft and writes through `applyEditorDraft`. The transcript never reaches
   into store state to place text, and the composer keeps no quote-specific
   state of its own.
6. **Boundaries.** No new IPC channel, no permission, no host protocol or storage
   schema change, and no Rust change. The composer, the transcript, the plugin
   draft bridge, and the send path keep their contracts. Quoting never sends,
   never creates a session, and writes nothing to the transcript.
7. **Identifiers.** Decision IDs `D-LOCAL-message-quotes`, `D-LOCAL-selection-overlay`
   and E2E IDs retired by ADR 0268 stay retired. This decision is referenced as
   ADR 0334, and its scenario is
   `E2E-CHAT-selection-quote-into-composer`.

## Consequences

- A reader can carry a passage into the next prompt without leaving the
  conversation and without losing the reading position; the transcript gains one
  floating pill and about 900 lines of renderer code, tests included.
- A quote is a draft edit like typing: it is undoable with the draft, and it can
  be sent, edited, or discarded. Nothing about it reaches the host before send.
- A gesture that starts in a tool row, a process disclosure, a run row, or the
  meta chips floats no pill — that is not conversation text — and a gesture that
  starts in the answer and runs into one of them quotes the answer alone, with
  those regions stripped. A selection over two rows floats nothing either; the
  OS clipboard still covers both cases, exactly as before.
- The annotation and side-chat surfaces stay gone; this ADR revives one gesture,
  not the three surfaces ADR 0268 removed.

## Alternatives considered

### Restore the historical implementation verbatim

Rejected: the deleted overlay carried three actions (add to chat, ask in side
chat, copy), an annotation branch, and its own KaTeX reduction. Two of the three
actions belong to surfaces ADR 0268 removed, and the third duplicates the OS
clipboard; keeping the private KaTeX reduction would restore the second reading
of a formula that D619 removed.

### Deliver the store-prefill path again

Rejected: `appendComposerDraftText` read the *cached* draft and replaced the
whole draft through `composerPrefill`. Drafts are serialized lazily (on switch,
blur, or unmount), so a quote could silently drop text the user had just typed,
and it always moved the caret to the end. The registered sink reads the live
editor, keeps its caret and its chips.

### Put the action in the message action row instead of a floating pill

Rejected: the end of a long answer is the wrong end of the message to reach for,
which is the whole reason the gesture is selection-anchored. The row's vocabulary
also stays what ADR 0268 left it.

## Amendment (D681, 2026-10-24)

The quote lands as an attachment chip, not as blockquote text. The composer
never rendered draft blockquotes — the excerpt reached the draft as one raw
`> ` run, and the promised "visually distinct" rendering did not exist — so the
quote and a large pasted text looked nothing alike. The pill now hands the
excerpt to the same paste path a large clipboard text takes (`api.pasteFiles`
into the session scratch), and the draft gains the same compact chip that
expands back to text on click. Everything else in this ADR stands: the overlay,
the single action, the 2000-character excerpt cap, the Markdown reduction, the
async sink registration, and never sending or writing the transcript. The
change is renderer-only; the paste path's own materialization of a home draft
applies, and a persistence failure is reported through the toast host while the
selection survives as the clipboard fallback.
