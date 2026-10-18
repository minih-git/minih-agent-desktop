/**
 * Naming input for a built-in session title: the user's own words plus the
 * bounded text behind any pasted reference that prompt carries.
 *
 * Large pastes arrive as an `@<data dir>/scratch/<session>/pasted/pasted-*.txt`
 * chip, so the first message can be nothing but a path. Naming the session from
 * that path produced titles describing the upload instead of what the user
 * actually asked about, so the title input reads the pasted text itself — only
 * inside this session's own `pasted/` directory, only regular files, only a
 * bounded prefix, and never through a link that leaves the session.
 */
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { findPromptReferenceTokens } from "@minih-agent/shared";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** At most this many pasted files feed one title. */
export const MAX_PASTED_TITLE_FILES = 3;
/** At most this many Unicode code points are read from one pasted file. */
export const MAX_PASTED_TITLE_CHARS_PER_FILE = 2_000;
/** At most this many Unicode code points reach the naming prompt in total. */
export const MAX_PASTED_TITLE_CHARS = 3_000;
/**
 * Bytes read from the head of one paste. A naming excerpt is 2,000 code points,
 * so a much larger paste is read as a bounded prefix instead of being skipped:
 * the user's 600 KiB paste still names the session.
 */
const PASTED_PREFIX_BYTES = 64 * 1024;
const PASTED_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"]);
const utf8 = new TextDecoder("utf-8", { fatal: false });

function insideRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

/**
 * Resolve a link-free chain from the data root to the session's `pasted/`
 * directory.
 *
 * A `realpath` of `pasted/` alone cannot be trusted: if `pasted/` itself is a
 * link, its target silently becomes the root every file is then checked
 * against, so a redirected directory reads any text file on disk. Each step is
 * therefore required to stay inside the previous one.
 */
async function resolvePastedRoot(dataDir: string, sessionId: string): Promise<string | null> {
  try {
    const dataRoot = await realpath(dataDir);
    const scratchRoot = await realpath(join(dataRoot, "scratch"));
    if (!insideRoot(dataRoot, scratchRoot)) return null;
    const sessionRoot = await realpath(join(scratchRoot, sessionId));
    if (!insideRoot(scratchRoot, sessionRoot)) return null;
    const pastedRoot = await realpath(join(sessionRoot, "pasted"));
    if (!insideRoot(sessionRoot, pastedRoot)) return null;
    return pastedRoot;
  } catch {
    return null;
  }
}

/** The bounded head of one pasted file, or `""` when it cannot be read. */
async function readPastedPrefix(path: string, limit: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(PASTED_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PASTED_PREFIX_BYTES, 0);
    if (bytesRead <= 0) return "";
    // A prefix can end mid-character; the decoder replaces that tail, and the
    // replacement is dropped rather than becoming part of the title input.
    return Array.from(utf8.decode(buffer.subarray(0, bytesRead)))
      .slice(0, limit)
      .join("")
      .replace(/\uFFFD+$/, "")
      .trim();
  } finally {
    await handle.close();
  }
}

/**
 * The pasted text behind `prompt`'s references, joined in reference order.
 * Every failure degrades to "no material": a title is never worth an error.
 */
export async function readPastedPromptMaterial({
  dataDir,
  sessionId,
  prompt,
  maxChars = MAX_PASTED_TITLE_CHARS,
}: {
  dataDir: string;
  sessionId: string;
  prompt: string;
  maxChars?: number;
}): Promise<string> {
  if (!SAFE_SESSION_ID.test(sessionId)) return "";
  const tokens = findPromptReferenceTokens(prompt);
  if (!tokens.length) return "";

  const pastedRoot = await resolvePastedRoot(dataDir, sessionId);
  if (!pastedRoot) return "";

  const excerpts: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  let files = 0;
  for (const token of tokens) {
    if (files >= MAX_PASTED_TITLE_FILES) break;
    // The join separator counts against the same budget as the excerpts.
    const remaining = maxChars - used - (excerpts.length ? 2 : 0);
    if (remaining <= 0) break;
    const requested = token.path.trim();
    if (!requested) continue;
    let path: string;
    try {
      path = await realpath(isAbsolute(requested) ? resolve(requested) : resolve(pastedRoot, requested));
    } catch {
      continue;
    }
    if (!insideRoot(pastedRoot, path) || seen.has(path)) continue;
    if (!PASTED_TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      const excerpt = await readPastedPrefix(
        path,
        Math.min(MAX_PASTED_TITLE_CHARS_PER_FILE, remaining),
      );
      if (!excerpt) continue;
      seen.add(path);
      files += 1;
      used += excerpt.length + (excerpts.length ? 2 : 0);
      excerpts.push(excerpt);
    } catch {
      // A pasted file that vanished or cannot be read names nothing.
    }
  }
  return excerpts.join("\n\n");
}
