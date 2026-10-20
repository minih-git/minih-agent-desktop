import { SESSION_LINK_SCHEME } from "./session-link.js";

/**
 * The Composer's lightweight session target: `#` in the draft names another
 * conversation, and the prompt carries that name and id as plain text.
 *
 * It is deliberately not a session *reference* (`session-link.ts`): a reference
 * is a `minih-agent-desktop://session/<id>` link that Electron main resolves into
 * a bounded excerpt of that conversation. A target carries no excerpt and no
 * link, so the model reads the title and the Session ID and can address the
 * session through the session tools. The text this module formats must
 * therefore never match `SESSION_LINK_PATTERN`; `session-target.test.ts` pins
 * that.
 */

/** Longest title snapshot a target carries, in characters. */
export const SESSION_TARGET_TITLE_MAX_CHARS = 80;

/**
 * The title one target may carry: whitespace (including newlines and tabs)
 * folded to single spaces and trimmed, so a multi-line title cannot break the
 * sentence it is embedded in, cut to {@link SESSION_TARGET_TITLE_MAX_CHARS},
 * and with our own deep-link scheme removed.
 *
 * The scheme strip is what keeps the guarantee above: a title is user text, and
 * a title that happens to be a `minih-agent-desktop://session/…` link would
 * otherwise make the whole sentence match `SESSION_LINK_PATTERN` and have main
 * attach an excerpt of a conversation the user only named.
 */
export function sessionTargetTitle(title: string): string {
  return title
    .replaceAll(`${SESSION_LINK_SCHEME}://`, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SESSION_TARGET_TITLE_MAX_CHARS)
    .trim();
}

/**
 * The prompt text for one target: `#<title> (Session ID: <id>)`.
 *
 * The id is always present, so a title that is empty, whitespace-only or lost
 * still names something addressable; an absent title falls back to the id's
 * first eight characters, which is the same shortening the session chips use.
 */
export function formatSessionTargetText(title: string, sessionId: string): string {
  const id = sessionId.trim();
  const name = sessionTargetTitle(title) || id.slice(0, 8);
  return `#${name} (Session ID: ${id})`;
}

/** The chip label for one target: `#<title>`, with the same fallback. */
export function sessionTargetLabel(title: string, sessionId: string): string {
  const id = sessionId.trim();
  return `#${sessionTargetTitle(title) || id.slice(0, 8)}`;
}
