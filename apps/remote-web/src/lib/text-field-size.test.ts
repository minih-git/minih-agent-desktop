/**
 * Every text control is at least 16px, or iOS zooms the whole page.
 *
 * WebKit on iOS enlarges the page when a focused input's font-size is under
 * 16px, and a WebView does not always restore the zoom afterwards: the user is
 * left with a page that is bigger than the screen and can be dragged in both
 * directions on every screen. The browser build never shows this, so it has to
 * be caught by reading the source.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** Every `.tsx` under `src/`, except the tests themselves. */
function componentFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...componentFiles(path));
      continue;
    }
    if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) found.push(path);
  }
  return found;
}

type Control = { file: string; tag: string; className: string };

/** The attribute text of a tag that starts at `from`, or null when it never closes. */
function openingTagAttributes(source: string, from: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ">" && depth <= 0) return source.slice(from, index);
  }
  return null;
}

/**
 * The opening tag of every `<input>` / `<textarea>`, with its own `className`.
 *
 * Handlers hold `=>`, so a tag cannot end at the first `>`: walk it and stop at
 * the `>` that sits outside braces and quotes. A control without a `className`
 * inherits one; the app never does that for a text field, so an absent class is
 * reported as its own problem rather than silently ignored.
 */
function textControls(source: string, file: string): Control[] {
  const controls: Control[] = [];
  const start = /<(input|textarea)\b/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(source)) !== null) {
    const attributes = openingTagAttributes(source, start.lastIndex);
    if (attributes === null) continue;
    // A hidden, file, or non-text input cannot be focused into a zoom.
    if (/type="(?:file|hidden|checkbox|radio|submit|button)"/.test(attributes)) continue;
    const className = /className=\{?[`"]?([^`"]*)/.exec(attributes)?.[1] ?? "";
    controls.push({ file, tag: match[1] ?? "input", className });
  }
  return controls;
}

/** The font size a utility class names, in px. Only `text-[Npx]` is used for fields. */
function fontSizeOf(className: string): number | null {
  const match = /text-\[(\d+(?:\.\d+)?)px\]/.exec(className);
  return match ? Number(match[1]) : null;
}

describe("text fields on iOS", () => {
  it("are at least 16px, so focusing one does not zoom the page", () => {
    const tooSmall: string[] = [];
    for (const path of componentFiles(SRC)) {
      const source = readFileSync(path, "utf8");
      for (const control of textControls(source, path.slice(SRC.length))) {
        const size = fontSizeOf(control.className);
        if (size === null) {
          tooSmall.push(`${control.file}: <${control.tag}> has no explicit font size`);
          continue;
        }
        if (size < 16) tooSmall.push(`${control.file}: <${control.tag}> is ${size}px`);
      }
    }
    expect(tooSmall).toEqual([]);
  });
});
