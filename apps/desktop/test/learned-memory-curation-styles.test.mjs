import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadStylesSync } from "./helpers/styles.mjs";

/*
 * Every class the automatic-curation surfaces put on an element must be painted
 * by the renderer stylesheet.
 *
 * This shipped broken once: `LearnedMemoryCuration.tsx` named twelve classes —
 * the block, its disclosure head, the batches, each batch, its head, the rows,
 * the before/after/reason layers, the empty state — and no stylesheet defined
 * any of them, so "Recently curated" rendered as a column of bare text with an
 * undo that did not look like a button. Typecheck, lint and the behaviour tests
 * cannot see that: a class name is a string.
 *
 * The stylesheet is read through `loadStylesSync`, i.e. the cascade
 * `globals.css` actually loads, not every file in `styles/`: a rule in a
 * partial nobody imports paints nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");

/** The files that own the "Recently curated" markup. */
function scannedFiles() {
  return [
    join(srcRoot, "components", "LearnedMemoryCuration.tsx"),
    join(srcRoot, "components", "LearnedMemoryDialog.tsx"),
  ];
}

const LITERAL = /className="([^"]*)"/g;
const TEMPLATE = /className=\{`([^`]*)`\}/g;
const INTERPOLATION = /\$\{[^{}]*\}/g;

/** Every class name a scanned file puts in a `className`. */
function classNamesFrom(source) {
  const found = new Set();
  const add = (value) => {
    // Dynamic segments are expressions, not classes: drop them and keep the
    // literal words around them (`learned-memory-curation ${open ? …}` still
    // owns `learned-memory-curation`).
    const text = value.replace(INTERPOLATION, " ");
    for (const token of text.split(/\s+/)) if (token) found.add(token);
  };
  for (const match of source.matchAll(LITERAL)) add(match[1]);
  for (const match of source.matchAll(TEMPLATE)) add(match[1]);
  return found;
}

/** Whether the stylesheet has any selector naming this class. */
function styled(styles, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(styles);
}

test("every automatic-curation class is painted by the stylesheet", () => {
  const styles = loadStylesSync();
  const unstyled = [];
  const seen = new Set();
  for (const file of scannedFiles()) {
    const source = readFileSync(file, "utf8");
    for (const className of classNamesFrom(source)) {
      if (!className.startsWith("learned-memory-curation")) continue;
      seen.add(className);
      if (styled(styles, className)) continue;
      unstyled.push(`${relative(join(here, ".."), file)}: .${className}`);
    }
  }
  assert.deepEqual(
    unstyled.sort(),
    [],
    `These classes have no rule in src/styles, so they render unstyled:\n  ${unstyled.sort().join("\n  ")}`,
  );
  // The scan must actually see the block's own classes: an empty set would let
  // the assertion above pass for a component that stopped naming them.
  for (const required of [
    "learned-memory-curation",
    "learned-memory-curation-head",
    "learned-memory-curation-empty",
    "learned-memory-curation-batch",
    "learned-memory-curation-before",
    "learned-memory-curation-after",
    "learned-memory-curation-reason",
  ]) {
    assert.ok(seen.has(required), `the component must still name .${required}`);
  }
});