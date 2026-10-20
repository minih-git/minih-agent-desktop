/**
 * Selection overlay geometry and selection → Markdown recovery for message
 * quotes (ADR 0334).
 *
 * Mirrors the Codex client's selected-text overlay: one pill floats
 * *above* the selection, horizontally centered on it, inside the bounds of the
 * scroll container it lives in (and above the docked composer), and it follows
 * the selection while the thread scrolls instead of disappearing.
 *
 * A selection inside a rendered answer is DOM, not source text: KaTeX paints
 * two parallel trees per formula, the highlighter splits one fence into a span
 * per token, and a table renders as cells. Handing that DOM to the composer
 * duplicates every formula, flattens every table, and turns code into
 * decorations, so a clone of the range is reduced back to Markdown — TeX,
 * fenced code, one line per table row — before it becomes draft text. Formulas
 * are read through `lib/selection-tex.ts`, the same module the clipboard uses,
 * so the two readings of one formula cannot drift apart.
 */
import {
  expandRangeToWholeKatex,
  KATEX_DISPLAY_SELECTOR,
  KATEX_SELECTOR,
  KATEX_TEX_SELECTOR,
  texSource,
} from "./selection-tex";

/** Gap between the selection and the floating pill. */
export const SELECTION_QUOTE_GAP = 8;
/** Smallest distance the pill keeps from the bounds it is clamped into. */
export const SELECTION_QUOTE_MARGIN = 8;
/** Markdown fences start at three backticks and grow past the longest run. */
export const SELECTION_QUOTE_MIN_FENCE = 3;

/**
 * Row chrome that is never part of a quote: the turn's process and tool
 * disclosures, standalone run rows, and the meta chips under an answer (model,
 * duration, token counts). They sit inside the same `data-minimap-id` row as
 * the answer text, so the row alone cannot tell them apart — a drag that ends
 * in them must not carry a tool payload or a token count into the prompt.
 */
export const UNQUOTABLE_SELECTOR = [
  ".turn-process",
  ".turn-run-row",
  ".tool-row",
  ".message-meta",
].join(", ");

/** The transcript row attribute a quotable selection anchors to. */
export const QUOTABLE_ROW_ATTRIBUTE = "data-minimap-id";
/** The docked composer's own element, which the pill must stay above. */
export const COMPOSER_DOCK_SELECTOR = '[data-composer-dock="docked"]';

const OVERFLOW_VALUES = new Set(["auto", "clip", "hidden", "overlay", "scroll"]);

/** Viewport rectangle, structurally typed so geometry stays testable. */
export type SelectionQuoteRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** The box the pill has to stay inside. */
export type SelectionQuoteBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Everything the pill needs to render and act on one selection. */
export type SelectionQuoteTarget = {
  /** The selection, already reduced to the Markdown the composer receives. */
  markdown: string;
  /** Visible part of the selection, in viewport coordinates. */
  anchor: SelectionQuoteRect;
  /** Bounds the pill is clamped into. */
  bounds: SelectionQuoteBounds;
};

/* ---------- pure helpers ---------- */

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    if (value === character) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * A fence long enough to contain `text`, so quoting a snippet that itself
 * contains backticks cannot break out of the block.
 */
export function codeFenceFor(
  text: string,
  minimum = SELECTION_QUOTE_MIN_FENCE,
): string {
  return "`".repeat(Math.max(minimum, longestRun(text, "`") + 1));
}

/**
 * Collapse the whitespace the rendered DOM adds back to source-like text:
 * markup indentation, non-breaking spaces, soft hyphens, and the blank lines
 * that separating blocks introduce.
 *
 * A fenced code block is exempt. Its blank lines and trailing spaces are the
 * content of the code, so collapsing them would quote a program that is not the
 * one on screen — a Python block whose two blank lines became one is a
 * different file. Everything outside a fence keeps the collapse.
 */
export function normalizeSelectionMarkdown(value: string): string {
  const lines = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const kept: { text: string; inFence: boolean }[] = [];
  let fence: string | null = null;
  let blankRun = 0;
  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, " ").replace(/[\u200b\ufeff]/g, "");
    const trimmed = line.trim();
    if (fence) {
      // Inside a fence every line is content, blank ones included.
      kept.push({ text: line, inFence: true });
      const closing = /^(`{3,}|~{3,})$/.exec(trimmed)?.[1] ?? "";
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const opening = /^(`{3,}|~{3,})[^`]*$/.exec(trimmed)?.[1] ?? "";
    if (opening) {
      fence = opening;
      blankRun = 0;
      kept.push({ text: line.replace(/[ \t]+$/, ""), inFence: true });
      continue;
    }
    if (!trimmed) {
      blankRun += 1;
      if (blankRun === 1) kept.push({ text: "", inFence: false });
      continue;
    }
    blankRun = 0;
    kept.push({ text: line.replace(/[ \t]+$/, ""), inFence: false });
  }
  // The excerpt's own edges are not content: drop blank lines and indentation
  // the DOM wrapped around it, but never a line that belongs to a fence.
  while (kept.length > 0 && !kept[0].inFence && !kept[0].text.trim()) kept.shift();
  while (kept.length > 0 && !kept[kept.length - 1].inFence && !kept[kept.length - 1].text.trim()) {
    kept.pop();
  }
  if (kept.length > 0 && !kept[0].inFence) kept[0] = { ...kept[0], text: kept[0].text.replace(/^[ \t]+/, "") };
  return kept.map((entry) => entry.text).join("\n");
}

/**
 * The part of `rect` that is inside `bounds`, or null when they do not overlap.
 * A selection scrolled half out of its container is anchored to the half that
 * is still on screen.
 */
export function intersectSelectionQuoteRect(
  rect: SelectionQuoteRect,
  bounds: SelectionQuoteBounds,
): SelectionQuoteRect | null {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  if (left >= right || top >= bottom) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Place the pill above the selection, centered on it, then clamp it into the
 * bounds. Only the horizontal axis can collide (the pill is narrow and near the
 * top of the selection), so a selection against the right edge slides left
 * instead of leaving the container. Returns the measured width cap too, so a
 * narrow panel cannot push the pill out of its own bounds.
 */
export function placeSelectionQuote({
  anchor,
  size,
  bounds,
  margin = SELECTION_QUOTE_MARGIN,
  gap = SELECTION_QUOTE_GAP,
}: {
  anchor: SelectionQuoteRect;
  size: { width: number; height: number };
  bounds: SelectionQuoteBounds;
  margin?: number;
  gap?: number;
}): { top: number; left: number; maxWidth: number } {
  const maxWidth = Math.max(0, bounds.right - bounds.left - margin * 2);
  const width = Math.min(size.width, maxWidth);
  const maximumLeft = Math.max(bounds.left + margin, bounds.right - margin - width);
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - width / 2, bounds.left + margin),
    maximumLeft,
  );
  const maximumTop = Math.max(bounds.top + margin, bounds.bottom - size.height);
  const top = Math.min(
    Math.max(anchor.top - gap - size.height, bounds.top + margin),
    maximumTop,
  );
  return { top, left, maxWidth };
}

/* ---------- DOM reduction ---------- */

function replaceWithText(node: Element, text: string, doc: Document): void {
  node.replaceWith(doc.createTextNode(text));
}

/**
 * A formula is one unit: KaTeX's MathML tree and its visual tree are two
 * renderings of the same source, and copying both duplicates the expression.
 * The TeX annotation is the source, and `texSource` is where the fence width
 * and padding rules live for every reading of it, so a quoted formula reads
 * exactly like a copied one. A display formula carries its wrapper out too,
 * because that wrapper is what marks it as display.
 */
function replaceKatex(wrapper: Element, doc: Document): void {
  for (const katex of Array.from(wrapper.querySelectorAll(KATEX_SELECTOR))) {
    const tex = katex.querySelector(KATEX_TEX_SELECTOR)?.textContent ?? "";
    if (!tex.trim()) {
      // Valid KaTeX always carries the annotation; keep one rendering if not
      // rather than dropping the formula from the quote.
      replaceWithText(katex, katex.textContent ?? "", doc);
      continue;
    }
    const display = katex.closest(KATEX_DISPLAY_SELECTOR);
    replaceWithText(display ?? katex, texSource(tex, Boolean(display)), doc);
  }
}

function fencedBlock(code: string, language: string): string {
  const fence = codeFenceFor(code);
  return `\n${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}\n`;
}

/** The language rail a code block renders, sanitized for a fence info string. */
function fenceLanguage(element: Element): string {
  const label =
    element.querySelector(".code-block-lang")?.textContent ??
    element.previousElementSibling?.querySelector(".code-block-lang")?.textContent ??
    "";
  return label.trim().replace(/[^A-Za-z0-9_+.-]/g, "");
}

function replaceCodeBlocks(wrapper: Element, doc: Document): void {
  for (const block of Array.from(wrapper.querySelectorAll(".code-block"))) {
    const code = block.querySelector("pre code")?.textContent ?? "";
    replaceWithText(block, fencedBlock(code, fenceLanguage(block)), doc);
  }
  // A `pre` outside the app's code-block wrapper (or one reached on its own) is
  // still code, and quoting it line by line would read as prose. Selecting the
  // *contents* of a code block — what a drag over the code actually produces —
  // leaves its language rail as a previous sibling rather than an ancestor, so
  // the fence keeps the language there too.
  for (const pre of Array.from(wrapper.querySelectorAll("pre"))) {
    const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
    replaceWithText(pre, fencedBlock(code, fenceLanguage(pre)), doc);
  }
}

function replaceInlineCode(wrapper: Element, doc: Document): void {
  for (const code of Array.from(wrapper.querySelectorAll("code"))) {
    if (code.closest("pre")) continue;
    const value = code.textContent ?? "";
    const fence = codeFenceFor(value, 1);
    replaceWithText(code, `${fence}${value}${fence}`, doc);
  }
}

function replaceTaskCheckboxes(wrapper: Element, doc: Document): void {
  for (const input of Array.from(
    wrapper.querySelectorAll('input[type="checkbox"]'),
  )) {
    replaceWithText(input, (input as HTMLInputElement).checked ? "[x] " : "[ ] ", doc);
  }
}

/**
 * Drop transcript chrome, and unwrap the rest of the controls: a file-reference
 * chip renders its code inside a button, so removing buttons outright would
 * delete the text the user selected. The unquotable regions go too, which is
 * what keeps a drag that runs from the answer into a tool row or the meta chips
 * from carrying them along.
 */
function removeChrome(wrapper: Element): void {
  for (const node of Array.from(
    wrapper.querySelectorAll(
      [
        UNQUOTABLE_SELECTOR,
        ".message-actions",
        ".code-block-head",
        "script",
        "style",
        "noscript",
        "template",
        "[hidden]",
        '[aria-hidden="true"]',
        ".sr-only",
      ].join(", "),
    ),
  )) {
    node.remove();
  }
  for (const button of Array.from(wrapper.querySelectorAll("button"))) {
    button.replaceWith(...Array.from(button.childNodes));
  }
}

/**
 * A row is the smallest unit that carries meaning across the visual column
 * split, so each row becomes one `a | b` line.
 */
function replaceTables(wrapper: Element, doc: Document): void {
  for (const row of Array.from(wrapper.querySelectorAll("tr"))) {
    const cells = Array.from(row.querySelectorAll(":scope > th, :scope > td"));
    if (cells.length === 0) continue;
    const value = cells
      .map((cell) => (cell.textContent ?? "").trim().replace(/\s*\n\s*/g, " "))
      .join(" | ");
    replaceWithText(row, `${value}\n`, doc);
  }
}

function replaceLists(wrapper: Element, doc: Document): void {
  // Innermost first: a nested item must become text before its parent reads it.
  for (const item of Array.from(wrapper.querySelectorAll("li")).reverse()) {
    const parent = item.parentElement;
    let prefix = "- ";
    if (parent?.tagName?.toLowerCase() === "ol") {
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName?.toLowerCase() === "li",
      );
      const start = Number.parseInt(parent.getAttribute("start") ?? "1", 10) || 1;
      prefix = `${start + Math.max(0, siblings.indexOf(item))}. `;
    }
    // The rendered source keeps newlines between items; left in place they read
    // back as a blank line between two list items, which is two lists.
    let next = item.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !(next.nodeValue ?? "").trim()) {
      const following = next.nextSibling;
      next.remove();
      next = following;
    }
    replaceWithText(item, `${prefix}${(item.textContent ?? "").trim()}\n`, doc);
  }
}

function replaceHeadings(wrapper: Element, doc: Document): void {
  for (let level = 1; level <= 6; level += 1) {
    for (const heading of Array.from(wrapper.querySelectorAll(`h${level}`))) {
      replaceWithText(
        heading,
        `\n${"#".repeat(level)} ${(heading.textContent ?? "").trim()}\n`,
        doc,
      );
    }
  }
}

function addBlockBoundaries(wrapper: Element, doc: Document): void {
  for (const br of Array.from(wrapper.querySelectorAll("br"))) {
    replaceWithText(br, "\n", doc);
  }
  for (const rule of Array.from(wrapper.querySelectorAll("hr"))) {
    replaceWithText(rule, "\n---\n", doc);
  }
  for (const block of Array.from(
    wrapper.querySelectorAll("p, pre, blockquote, section, article, div"),
  )) {
    block.before(doc.createTextNode("\n"));
    block.after(doc.createTextNode("\n"));
  }
}

/**
 * The Markdown a rendered selection stands for. Returns an empty string when
 * there is nothing quotable, which every caller treats as "keep the pill
 * hidden".
 */
export function serializeSelectionMarkdown(range: Range | null): string {
  if (!range) return "";
  const ownerDocument =
    range.commonAncestorContainer?.ownerDocument ??
    (range.commonAncestorContainer?.nodeType === 9
      ? (range.commonAncestorContainer as unknown as Document)
      : null) ??
    (typeof document === "undefined" ? null : document);
  if (!ownerDocument) return "";

  const wrapper = ownerDocument.createElement("div");
  wrapper.append(expandRangeToWholeKatex(range).cloneContents());

  // Order matters: formulas and code are reduced before chrome is dropped and
  // before generic block boundaries are inserted, or their own markup would be
  // flattened into the text the reduction is looking for.
  replaceKatex(wrapper, ownerDocument);
  replaceCodeBlocks(wrapper, ownerDocument);
  replaceInlineCode(wrapper, ownerDocument);
  replaceTaskCheckboxes(wrapper, ownerDocument);
  removeChrome(wrapper);
  replaceTables(wrapper, ownerDocument);
  replaceLists(wrapper, ownerDocument);
  replaceHeadings(wrapper, ownerDocument);
  addBlockBoundaries(wrapper, ownerDocument);

  return normalizeSelectionMarkdown(wrapper.textContent ?? "");
}

/* ---------- live selection ---------- */

/** The transcript row a node sits in, or null when the selection is elsewhere. */
export function quotableRowFor(node: Node | null | undefined): Element | null {
  const element =
    node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  return element?.closest?.(`[${QUOTABLE_ROW_ATTRIBUTE}]`) ?? null;
}

/** The unquotable region a node sits in, or null when it sits in answer text. */
export function unquotableAncestor(node: Node | null | undefined): Element | null {
  const element =
    node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  return element?.closest?.(UNQUOTABLE_SELECTOR) ?? null;
}

/** The document selection, when it is a non-empty text range. */
export function activeSelectionRange(): Range | null {
  if (typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  return range.toString().trim() ? range : null;
}

/**
 * Keep a range inside one element: a drag that leaves the row must not pull the
 * next row's text into the quote.
 */
export function clampRangeToElement(range: Range, element: Element): Range {
  const clamped = range.cloneRange();
  const contents = range.startContainer.ownerDocument!.createRange();
  contents.selectNodeContents(element);
  if (
    !element.contains(clamped.startContainer) ||
    clamped.compareBoundaryPoints(Range.START_TO_START, contents) < 0
  ) {
    clamped.setStart(contents.startContainer, contents.startOffset);
  }
  if (
    !element.contains(clamped.endContainer) ||
    clamped.compareBoundaryPoints(Range.END_TO_END, contents) > 0
  ) {
    clamped.setEnd(contents.endContainer, contents.endOffset);
  }
  return clamped;
}

/**
 * The visible band the pill may use: every scrollable ancestor's rect (the
 * transcript scroller is one) intersected with the viewport, and capped by the
 * docked composer — which floats over the transcript, so the scroller's own
 * bottom edge is not the visible bottom.
 */
export function selectionQuoteBounds({
  element,
  viewport,
  bottomBoundaryTop,
}: {
  element: Element | null;
  viewport: { width: number; height: number };
  bottomBoundaryTop?: number | null;
}): SelectionQuoteBounds | null {
  const bounds: SelectionQuoteBounds = {
    left: 0,
    top: 0,
    right: viewport.width,
    bottom:
      typeof bottomBoundaryTop === "number"
        ? Math.min(viewport.height, bottomBoundaryTop)
        : viewport.height,
  };
  const ownerDocument = element?.ownerDocument;
  const view = ownerDocument?.defaultView;
  let node: Element | null = element;
  while (node && node !== ownerDocument?.body && node !== ownerDocument?.documentElement) {
    const style = view?.getComputedStyle?.(node);
    // `overflow: hidden` on a decorative wrapper clips the selection too, so it
    // counts the same as a real scroll container.
    const clipsX = (style?.overflowX ?? "").split(/\s+/).some((v) => OVERFLOW_VALUES.has(v));
    const clipsY = (style?.overflowY ?? "").split(/\s+/).some((v) => OVERFLOW_VALUES.has(v));
    if (clipsX || clipsY) {
      const rect = node.getBoundingClientRect();
      if (clipsY) {
        bounds.top = Math.max(bounds.top, rect.top);
        bounds.bottom = Math.min(bounds.bottom, rect.bottom);
      }
      if (clipsX) {
        bounds.left = Math.max(bounds.left, rect.left);
        bounds.right = Math.min(bounds.right, rect.right);
      }
      if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
    }
    node = node.parentElement;
  }
  return bounds.bottom <= bounds.top ? null : bounds;
}

/**
 * Where the pill anchors: the selection's first client rect that is still
 * visible inside the bounds (a multi-line selection anchors to its top line),
 * falling back to the visible part of the whole bounding box.
 */
export function selectionQuoteAnchor({
  range,
  element,
  bounds,
}: {
  range: Range;
  element: Element;
  bounds: SelectionQuoteBounds;
}): SelectionQuoteRect | null {
  const rowRect = element.getBoundingClientRect();
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  for (const rect of rects) {
    const visible = intersectSelectionQuoteRect(rect, bounds);
    if (!visible) continue;
    if (rects.length > 1 || intersectSelectionQuoteRect(visible, rowRect)) {
      return visible;
    }
  }
  const bounding = range.getBoundingClientRect();
  const visibleBounding = intersectSelectionQuoteRect(bounding, bounds);
  if (visibleBounding && intersectSelectionQuoteRect(visibleBounding, rowRect)) {
    return visibleBounding;
  }
  if (rects.length > 0 || bounding.width > 0 || bounding.height > 0) return null;
  const rowVisible = intersectSelectionQuoteRect(rowRect, bounds);
  return rowVisible;
}

/**
 * Everything the pill renders from, or null when the selection is not one it
 * should own: no selection, a selection outside this transcript, a selection
 * that spans two rows, or an empty excerpt.
 */
export function selectionQuoteTarget({
  scrollRoot,
  bottomBoundaryTop,
  viewport = {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  },
}: {
  scrollRoot: Element | null;
  bottomBoundaryTop?: number | null;
  viewport?: { width: number; height: number };
}): SelectionQuoteTarget | null {
  const live = activeSelectionRange();
  if (!live || !scrollRoot) return null;

  const startRow = quotableRowFor(live.startContainer);
  // Both ends must sit in the same row: a drag that crosses rows has no single
  // message to attribute.
  if (!startRow || startRow !== quotableRowFor(live.endContainer)) return null;
  if (!scrollRoot.contains(startRow)) return null;
  if (!startRow.getAttribute(QUOTABLE_ROW_ATTRIBUTE)) return null;
  /*
    A gesture that starts in a tool row, a process disclosure, or the meta chips
    is not quoting conversation text, so no pill appears. Starting in the answer
    and ending in one of them is still a quote — of the answer: `removeChrome`
    drops those regions from the clone, so the meta text or the tool payload
    never reaches the draft.
  */
  if (unquotableAncestor(live.startContainer)) return null;

  const range = clampRangeToElement(live, startRow);
  const markdown = serializeSelectionMarkdown(range);
  if (!markdown) return null;

  const bounds = selectionQuoteBounds({
    element: startRow,
    viewport,
    bottomBoundaryTop,
  });
  if (!bounds) return null;
  const anchor = selectionQuoteAnchor({ range, element: startRow, bounds });
  if (!anchor) return null;

  return { markdown, anchor, bounds };
}
