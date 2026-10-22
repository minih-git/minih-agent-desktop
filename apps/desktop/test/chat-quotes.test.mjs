import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_QUOTE_CHARS,
  insertQuoteIntoDraft,
  quoteBlock,
  quoteExcerpt,
} from "../src/lib/chat-quotes.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [overlay, sink, composer, transcript] = await Promise.all([
  read("../src/features/chat/transcript/SelectionQuoteButton.tsx"),
  read("../src/features/chat/composer/hooks/useComposerQuoteSink.ts"),
  read("../src/components/Composer.tsx"),
  read("../src/features/chat/transcript/ChatTranscript.tsx"),
]);

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

test("the excerpt becomes one blockquote, blank lines included", () => {
  assert.equal(quoteBlock("one\ntwo"), "> one\n> two");
  assert.equal(quoteBlock("one\n\ntwo"), "> one\n>\n> two");
});

test("a quote lands in an empty draft unchanged", () => {
  assert.deepEqual(
    insertQuoteIntoDraft("", { start: 0, end: 0 }, "> quoted"),
    { text: "> quoted", caret: 8 },
  );
});

test("a quote is separated from what the user already typed", () => {
  assert.deepEqual(
    insertQuoteIntoDraft("do this:", { start: 8, end: 8 }, "> quoted"),
    { text: "do this:\n\n> quoted", caret: 18 },
  );
  // One blank line is enough; a second one is not added.
  assert.deepEqual(
    insertQuoteIntoDraft("do this:\n\n", { start: 10, end: 10 }, "> quoted"),
    { text: "do this:\n\n> quoted", caret: 18 },
  );
  // A single trailing newline only needs its pair.
  assert.equal(
    insertQuoteIntoDraft("do this:\n", { start: 9, end: 9 }, "> quoted").text,
    "do this:\n\n> quoted",
  );
});

test("the caret sits after the quote, before the text that followed it", () => {
  const result = insertQuoteIntoDraft("before after", { start: 7, end: 7 }, "> quoted");
  assert.equal(result.text, "before \n\n> quoted\n\nafter");
  assert.equal(result.text.slice(result.caret), "after");
});

test("a selection in the draft is replaced by the quote", () => {
  assert.deepEqual(
    insertQuoteIntoDraft("keep drop", { start: 5, end: 9 }, "> quoted"),
    { text: "keep \n\n> quoted", caret: 15 },
  );
});

test("the pill writes one draft and never sends", () => {
  assert.match(overlay, /quoteIntoComposer\(quoteBlock\(excerpt\)\)/);
  assert.match(overlay, /quoteExcerpt\(target\.markdown\)/);
  assert.match(overlay, /t\("chat\.quoteSelection"\)/);
  assert.match(overlay, /showToast\(t\("chat\.quoteUnavailable"\)/);
  assert.doesNotMatch(overlay, /sendPrompt\(/);
  assert.doesNotMatch(overlay, /enqueuePrompt\(/);
});

test("the composer lends itself to the quote and keeps its chips", () => {
  assert.match(sink, /registerComposerQuoteSink\(/);
  assert.match(sink, /insertQuoteIntoDraft\(draft, selection, quote\)/);
  assert.match(sink, /editorSelectionRange\(element\)/);
  assert.match(sink, /\[\.\.\.current\.fileReferencesRef\.current\]/);
  // A blocked composer reports failure instead of silently dropping the quote.
  assert.match(sink, /if \(current\.inputBlocked\) return false/);
  assert.match(composer, /useComposerQuoteSink\(\{ \.\.\.draft, inputBlocked \}\)/);
});

test("the transcript mounts the overlay for the visible pane only", () => {
  assert.match(
    transcript,
    /paneVisible && !veilCovering \? \(\s*<SelectionQuoteButton scrollRef=\{scrollRef\} \/>/,
  );
});

