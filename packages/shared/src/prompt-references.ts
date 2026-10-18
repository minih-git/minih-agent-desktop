/**
 * `@path` references a persisted Composer prompt carries.
 *
 * The composer keeps pasted and picked files as compact chips and serializes
 * them into exact `@path` tokens at send time, so a prompt may be mostly
 * references. Surfaces that summarize the user's own words — the immediate
 * title fallback and the automatic title input — need the token positions and
 * the text between them, without re-deriving the composer grammar.
 *
 * Only path-shaped tokens count: `@media` in prose stays a word, while
 * `@/abs/pasted.txt`, `@"path with spaces/a.md"`, and `@src/a.ts` are
 * references the composer inserted.
 */

export type PromptReferenceToken = {
  /** Path inside the token, quotes removed. */
  path: string;
  /** Index of the `@` that opens the token. */
  start: number;
  /** Index one past the closing quote or the last path character. */
  end: number;
};

/** Characters that may precede a reference without turning it into a suffix. */
const BOUNDARY = new Set(["", " ", "\t", "\n", "\r", "\"", "'", "=", "(", "[", "{", ",", ";"]);

function isReferencePath(path: string): boolean {
  if (!path) return false;
  // A path carries a separator or a file extension; prose words do not.
  return path.includes("/") || path.includes("\\") || /\.[A-Za-z0-9]{1,16}$/.test(path);
}

/** Every path-shaped `@reference` in reading order. */
export function findPromptReferenceTokens(content: string): PromptReferenceToken[] {
  const tokens: PromptReferenceToken[] = [];
  const value = String(content ?? "");
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "@") continue;
    const previous = value[index - 1] ?? "";
    if (!BOUNDARY.has(previous)) continue;
    let cursor = index + 1;
    let path = "";
    if (value[cursor] === "\"") {
      const close = value.indexOf("\"", cursor + 1);
      if (close === -1) continue;
      path = value.slice(cursor + 1, close);
      cursor = close + 1;
    } else {
      const start = cursor;
      while (cursor < value.length && !/\s/.test(value[cursor])) cursor += 1;
      path = value.slice(start, cursor);
      // A trailing sentence mark belongs to the prose, not the path.
      path = path.replace(/[),.;:!?]+$/, "");
      cursor = start + path.length;
    }
    if (!isReferencePath(path)) continue;
    tokens.push({ path, start: index, end: cursor });
    index = cursor - 1;
  }
  return tokens;
}

/**
 * The user's own words: reference tokens removed, runs of whitespace collapsed.
 * A chip's path adds nothing here; `promptReferenceFileNames` carries the part
 * of a reference that is actually worth naming from.
 */
export function promptTextWithoutReferences(content: string): string {
  const value = String(content ?? "");
  let text = "";
  let cursor = 0;
  for (const token of findPromptReferenceTokens(value)) {
    text += `${value.slice(cursor, token.start)} `;
    cursor = token.end;
  }
  text += value.slice(cursor);
  return text.replace(/\s+/g, " ").trim();
}

/** A naming-relevant file name is bounded so one long path cannot dominate. */
const MAX_REFERENCE_NAME_CHARS = 60;
/** At most this many referenced names describe one session. */
const MAX_REFERENCE_NAMES = 6;

/**
 * Distinct file names the prompt references, in first-seen order.
 *
 * A prompt that only points at workspace files (`@src/login.ts`) still says what
 * the session is about, so its names belong in the naming input instead of
 * leaving it empty. Pasted scratch files are excluded: their content is the
 * naming input, and the chip name (`pasted-text-a1b2.txt`) describes nothing.
 */
export function promptReferenceFileNames(
  content: string,
  limit = MAX_REFERENCE_NAMES,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const token of findPromptReferenceTokens(content)) {
    const normalized = token.path.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!normalized || /(^|\/)pasted\//.test(normalized)) continue;
    const leaf = normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
    const name = Array.from(leaf).slice(0, MAX_REFERENCE_NAME_CHARS).join("").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}
