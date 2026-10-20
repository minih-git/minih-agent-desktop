import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  SELECTION_QUOTE_GAP,
  SELECTION_QUOTE_MARGIN,
  codeFenceFor,
  intersectSelectionQuoteRect,
  normalizeSelectionMarkdown,
  placeSelectionQuote,
} = await import("../src/lib/selection-quote.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [source, overlay, transcript, composer, styles] = await Promise.all([
  read("../src/lib/selection-quote.ts"),
  read("../src/features/chat/transcript/SelectionQuoteButton.tsx"),
  read("../src/features/chat/transcript/ChatTranscript.tsx"),
  read("../src/components/Composer.tsx"),
  read("../src/styles/overlays.css"),
]);

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

test("a fence outgrows the backticks inside the quoted snippet", () => {
  assert.equal(codeFenceFor("plain"), "```");
  assert.equal(codeFenceFor("a ``` fence"), "````");
  assert.equal(codeFenceFor("inline", 1), "`");
  assert.equal(codeFenceFor("a `b` c", 1), "``");
});

test("rendered whitespace collapses back to source-like text", () => {
  assert.equal(normalizeSelectionMarkdown("  a\r\n b \r\n"), "a\n b");
  assert.equal(normalizeSelectionMarkdown("a\u00a0b"), "a b");
  assert.equal(normalizeSelectionMarkdown("a\n\n\n\nb"), "a\n\nb");
  assert.equal(normalizeSelectionMarkdown("\n  \n"), "");
});

test("a fenced block keeps its blank lines and trailing spaces", () => {
  // Two blank lines and an indented line are the content of the program; only
  // the text around the fence is collapsed.
  const source = [
    "before  ",
    "",
    "",
    "```python",
    "def f():",
    "    a = 1  ",
    "",
    "",
    "    b = 2",
    "```",
    "",
    "",
    "after",
  ].join("\n");
  assert.equal(
    normalizeSelectionMarkdown(source),
    ["before", "", "```python", "def f():", "    a = 1  ", "", "", "    b = 2", "```", "", "after"].join("\n"),
  );
});

test("a fence that is still open at the end keeps every line verbatim", () => {
  assert.equal(
    normalizeSelectionMarkdown("```\na\n\n\nb  "),
    "```\na\n\n\nb  ",
  );
});

test("a tilde fence follows the same rule, and a longer closing run closes it", () => {
  assert.equal(
    normalizeSelectionMarkdown("~~~\na\n\n\nb\n~~~~\nafter  "),
    "~~~\na\n\n\nb\n~~~~\nafter",
  );
});

test("a selection scrolled half out of its container anchors to what is visible", () => {
  const bounds = { left: 0, top: 100, right: 400, bottom: 300 };
  assert.deepEqual(intersectSelectionQuoteRect(rect(50, 120, 100, 20), bounds), {
    left: 50,
    top: 120,
    right: 150,
    bottom: 140,
    width: 100,
    height: 20,
  });
  // Partially scrolled out: only the visible strip is left.
  assert.deepEqual(intersectSelectionQuoteRect(rect(50, 80, 100, 40), bounds), {
    left: 50,
    top: 100,
    right: 150,
    bottom: 120,
    width: 100,
    height: 20,
  });
  assert.equal(intersectSelectionQuoteRect(rect(50, 40, 100, 20), bounds), null);
});

test("the overlay floats above the selection, centered on it", () => {
  const placement = placeSelectionQuote({
    anchor: rect(100, 200, 120, 20),
    size: { width: 200, height: 30 },
    bounds: { left: 0, top: 0, right: 800, bottom: 600 },
  });
  assert.deepEqual(placement, {
    top: 200 - SELECTION_QUOTE_GAP - 30,
    left: 160 - 100,
    maxWidth: 800 - SELECTION_QUOTE_MARGIN * 2,
  });
});

test("the overlay is clamped into its bounds on both axes", () => {
  const bounds = { left: 40, top: 100, right: 360, bottom: 300 };
  // A selection against the right edge slides left instead of escaping.
  const atRight = placeSelectionQuote({
    anchor: rect(340, 200, 20, 20),
    size: { width: 200, height: 30 },
    bounds,
  });
  assert.equal(atRight.left, bounds.right - SELECTION_QUOTE_MARGIN - 200);
  assert.ok(atRight.left + 200 <= bounds.right - SELECTION_QUOTE_MARGIN);

  // A selection at the top of the bounds keeps the pill inside them.
  const atTop = placeSelectionQuote({
    anchor: rect(100, 102, 100, 20),
    size: { width: 200, height: 30 },
    bounds,
  });
  assert.equal(atTop.top, bounds.top + SELECTION_QUOTE_MARGIN);

  // Bounds narrower than the pill cap its width instead of overflowing.
  const narrow = placeSelectionQuote({
    anchor: rect(40, 200, 20, 20),
    size: { width: 200, height: 30 },
    bounds: { left: 0, top: 0, right: 150, bottom: 300 },
  });
  assert.equal(narrow.maxWidth, 150 - SELECTION_QUOTE_MARGIN * 2);
  assert.equal(narrow.left, SELECTION_QUOTE_MARGIN);
});

test("the bounds are the scroll container, capped above the docked composer", () => {
  // The composer floats over the transcript, so the scroller's own bottom is not
  // the visible bottom (ADR 0334).
  assert.match(source, /export const COMPOSER_DOCK_SELECTOR = '\[data-composer-dock="docked"\]'/);
  assert.match(source, /bottomBoundaryTop/);
  assert.match(composer, /data-composer-dock=\{variant\}/);
  // Every clipping ancestor counts, as in the reference overlay.
  assert.match(source, /new Set\(\["auto", "clip", "hidden", "overlay", "scroll"\]\)/);
  assert.match(source, /style\?\.overflowY/);
  assert.match(source, /node = node\.parentElement/);
});

test("the pill only owns a selection that lives in one row of one transcript", () => {
  assert.match(source, /startRow !== quotableRowFor\(live\.endContainer\)/);
  assert.match(source, /if \(!scrollRoot\.contains\(startRow\)\) return null/);
  // A drag that leaves the row is clamped back to it instead of quoting the
  // next row.
  assert.match(source, /clamped\.compareBoundaryPoints\(Range\.START_TO_START, contents\) < 0/);
  assert.match(source, /clamped\.compareBoundaryPoints\(Range\.END_TO_END, contents\) > 0/);
});

test("a formula quotes as TeX through the module the clipboard uses", () => {
  // KaTeX's source lives in the MathML annotation; the visual tree is a copy.
  // One fence-width and padding rule serves both readings of a formula.
  assert.match(source, /from "\.\/selection-tex"/);
  assert.match(source, /KATEX_TEX_SELECTOR/);
  assert.match(source, /KATEX_DISPLAY_SELECTOR/);
  assert.match(source, /replaceWithText\(display \?\? katex, texSource\(tex, Boolean\(display\)\), doc\)/);
  // A partial selection is expanded to the whole formula before cloning.
  assert.match(source, /wrapper\.append\(expandRangeToWholeKatex\(range\)\.cloneContents\(\)\)/);
  assert.doesNotMatch(source, /annotation\[encoding="application\/x-tex"\]/);
});

test("a quoted table keeps one line per row and a fence keeps its language", () => {
  assert.match(source, /querySelectorAll\(":scope > th, :scope > td"\)/);
  assert.match(source, /\.join\(" \| "\)/);
  assert.match(source, /querySelectorAll\("\.code-block"\)/);
  assert.match(source, /querySelector\("pre code"\)/);
  // Selecting the code itself leaves the language rail as a sibling, so the
  // fence has to look there too.
  assert.match(source, /function fenceLanguage\(element: Element\)/);
  assert.match(source, /previousElementSibling\?\.querySelector\("\.code-block-lang"\)/);
  assert.match(source, /fencedBlock\(code, fenceLanguage\(pre\)\)/);
});

test("list items are separated by one newline, not by a blank line", () => {
  assert.match(source, /next\.nodeType === Node\.TEXT_NODE && !\(next\.nodeValue \?\? ""\)\.trim\(\)/);
});

test("quote chrome is dropped but file-reference chips keep their text", () => {
  assert.match(source, /\.message-actions/);
  assert.match(source, /button\.replaceWith\(\.\.\.Array\.from\(button\.childNodes\)\)/);
  assert.doesNotMatch(source, /querySelectorAll\("button"\)\)\s*\{\s*node\.remove/);
});

test("tool rows, process disclosures, run rows and meta chips are never quoted", () => {
  // They live inside the same row as the answer text, so the row attribute
  // alone cannot separate them from what the user read.
  for (const selector of [".turn-process", ".turn-run-row", ".tool-row", ".message-meta"]) {
    assert.ok(
      source.includes(`"${selector}"`),
      `${selector} must be unquotable`,
    );
  }
  // A gesture that starts there floats nothing.
  assert.match(source, /if \(unquotableAncestor\(live\.startContainer\)\) return null/);
  // A gesture that starts in the answer and runs into one of them keeps only
  // the answer: the same regions are dropped from the clone.
  assert.match(source, /function removeChrome[\s\S]*?UNQUOTABLE_SELECTOR,/);
});

test("formulas and code are reduced before chrome is dropped", () => {
  const order = [
    "replaceKatex(wrapper, ownerDocument)",
    "replaceCodeBlocks(wrapper, ownerDocument)",
    "replaceInlineCode(wrapper, ownerDocument)",
    "removeChrome(wrapper)",
    "replaceTables(wrapper, ownerDocument)",
  ].map((step) => source.indexOf(step));
  assert.ok(order.every((index) => index > -1), "every reduction step is present");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps run in order");
});

test("the overlay follows the selection instead of disappearing on scroll", () => {
  assert.match(overlay, /document\.addEventListener\("selectionchange", schedule\)/);
  assert.match(overlay, /window\.addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/);
  assert.match(overlay, /if \(!row \|\| !\(node instanceof Node\) \|\| !node\.contains\(row\)\) return/);
  for (const event of ["dblclick", "keyup", "pointerup", "pointercancel", "resize"]) {
    assert.match(overlay, new RegExp(`addEventListener\\("${event}"`), event);
  }
  assert.match(overlay, /requestAnimationFrame\(sync\)/);
  // Pressing anywhere else is a new gesture: the pill waits for it to settle.
  assert.match(overlay, /pressedRef\.current = true/);
  assert.match(overlay, /if \(pressedRef\.current\) return/);
  assert.match(overlay, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("the overlay is placed from a measurement, not from a guessed size", () => {
  assert.match(overlay, /pillRef\.current\?\.getBoundingClientRect\(\)/);
  assert.match(overlay, /placeSelectionQuote\(\{ anchor: target\.anchor, size, bounds: target\.bounds \}\)/);
  // Hidden until measured, so the first painted frame is already final.
  assert.match(overlay, /visibility: "hidden"/);
  // It is a body-portaled popover, so the transcript's own clipping cannot cut
  // it and a hidden retained pane does not show one.
  assert.match(overlay, /portalToBody\(/);
});

test("the overlay consumes its own selection and keeps the reference alive", () => {
  assert.match(overlay, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
  assert.match(overlay, /data-testid="selection-quote"/);
  assert.match(overlay, /className="selection-quote"/);
});

test("the pill is one rounded action row in the portaled popover layer", () => {
  assert.match(styles, /\.selection-quote \{[\s\S]*?position: fixed/);
  assert.match(styles, /\.selection-quote \{[\s\S]*?z-index: 60/);
  assert.match(styles, /\.selection-quote \{[\s\S]*?border-radius: var\(--radius-full\)/);
  assert.match(styles, /\.selection-quote-action \{/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.selection-quote \{\s*animation: none;/);
});
