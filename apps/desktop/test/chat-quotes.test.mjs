import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_QUOTE_CHARS,
  quoteExcerpt,
} from "../src/lib/chat-quotes.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [overlay, sink, composer, transcript] = await Promise.all([
  read("../src/features/chat/transcript/SelectionQuoteButton.tsx"),
  read("../src/features/chat/composer/hooks/useComposerQuoteSink.ts"),
  read("../src/components/Composer.tsx"),
  read("../src/features/chat/transcript/ChatTranscript.tsx"),
]);

const read2 = (path) => readFile(new URL(path, import.meta.url), "utf8");
const pasteHook = await read2("../src/features/chat/composer/hooks/useComposerAttachments.ts");

test("a quote normalizes line endings and trims the excerpt", () => {
  assert.equal(quoteExcerpt("  first\r\nsecond  \r\n"), "first\nsecond");
  assert.equal(quoteExcerpt("   "), "");
});

test("a long excerpt is cut once and marked with an ellipsis", () => {
  const excerpt = quoteExcerpt("x".repeat(MAX_QUOTE_CHARS + 500));
  assert.equal(excerpt.length, MAX_QUOTE_CHARS + 1);
  assert.ok(excerpt.endsWith("…"));
});

test("a cut never splits a surrogate pair", () => {
  // The bound lands between the two halves of the astral character, so the
  // excerpt must drop the lone high surrogate instead of emitting it.
  const excerpt = quoteExcerpt(`${"a".repeat(MAX_QUOTE_CHARS - 1)}😀tail`);
  assert.equal(excerpt.length, MAX_QUOTE_CHARS);
  assert.doesNotMatch(excerpt, /[\uD800-\uDBFF]$/);
});

test("the pill hands the excerpt to the composer's paste path and never sends", () => {
  assert.match(overlay, /quoteIntoComposer\(excerpt\)/);
  assert.match(overlay, /quoteExcerpt\(target\.markdown\)/);
  assert.match(overlay, /t\("chat\.quoteSelection"\)/);
  assert.match(overlay, /showToast\(t\("chat\.quoteUnavailable"\)/);
  assert.doesNotMatch(overlay, /sendPrompt\(/);
  assert.doesNotMatch(overlay, /enqueuePrompt\(/);
  // The chip path is async: the pill waits for the paste round-trip.
  assert.match(overlay, /await quoteIntoComposer\(excerpt\)/);
});

test("the sink persists the excerpt through the composer's paste path", () => {
  // Same channel as a large pasted text, so the result is the same chip.
  assert.match(sink, /api\.pasteFiles\(sessionId, \[/);
  assert.match(sink, /mimeType: "text\/plain"/);
  assert.match(sink, /quoted-text-/);
  // The chip lands at the editor's caret with the existing references kept.
  assert.match(sink, /editorSelectionRange\(editor\)/);
  assert.match(sink, /nextChipToken\(\)/);
  assert.match(sink, /snapshotReferences\(sourceSessionId \?\? ""\)/);
  assert.match(sink, /writeComposerDraft\(sessionId,/);
  // A blocked composer reports failure instead of silently dropping the quote.
  assert.match(sink, /if \(current\.inputBlocked \|\| inFlight\) return false/);
  // A home draft materializes into a session, and the stale home snapshot is
  // dropped rather than resurrected on top of the chip.
  assert.match(sink, /deleteComposerDraft\(HOME_DRAFT_KEY\)/);
});

test("the composer lends itself to the quote with its paste machinery", () => {
  // The quote hook receives the same draft controller members the paste path
  // itself uses, and stays registered for the whole composer's life.
  assert.match(composer, /useComposerQuoteSink\(\{ \.\.\.draft, inputBlocked \}\)/);
  assert.match(pasteHook, /pasteClipboardFiles = async/);
});

test("the transcript mounts the overlay for the visible pane only", () => {
  assert.match(
    transcript,
    /paneVisible && !veilCovering \? \(\s*<SelectionQuoteButton scrollRef=\{scrollRef\} \/>/,
  );
});
