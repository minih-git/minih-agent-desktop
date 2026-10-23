import type { FsReadResult } from "@minih-agent/shared";

/**
 * A page of HTML past this length is not rendered inline; the reference stays a
 * link. Kept below `MAX_SYNC_MARKDOWN_CODE_UNITS` so the cap is reachable: a
 * larger message never reaches this renderer at all.
 */
export const MAX_HTML_PAGE_SOURCE_LENGTH = 100_000;

/**
 * Reading a page for inline display, as a call the answer surface can await.
 * The host owns the file read (roots, session, size cap), so this module only
 * decides what a completed read means for the transcript.
 */
export type ReadLocalHtmlPage = () => Promise<FsReadResult | null>;

export type LocalHtmlPage =
  | { status: "loading" }
  | { status: "ready"; code: string }
  | { status: "unavailable" };

/**
 * Where a `file://` link points, as a path the host already accepts.
 *
 * Only the empty host and `localhost` name the local machine; a remote host in
 * a `file://` URL is not a file this app may read.
 */
export function localHtmlPagePath(href: string): string | null {
  const withoutQuery = href.trim().replace(/[?#].*$/, "");
  if (!/^file:\/\//i.test(withoutQuery)) return null;
  let rest = withoutQuery.slice("file://".length);
  if (!rest.startsWith("/")) {
    const slash = rest.indexOf("/");
    const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    if (host && host !== "localhost") return null;
    rest = slash === -1 ? "" : rest.slice(slash);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  // `file:///C:/page.html` is a drive path, not an absolute path under a root.
  if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);
  return decoded || null;
}

/**
 * The local page a chat link names, or null when it names something else.
 *
 * The Markdown renderer rewrites a `file://` destination before it reaches a
 * component: the scheme is dropped and the rest arrives percent-encoded, so
 * `file:///tmp/report.html` shows up as `%2Ftmp%2Freport.html`. A message may
 * also write the absolute path directly. Both are the same local page here, and
 * the host still decides whether it may read that path.
 */
export function localHtmlPageLinkPath(href: string): string | null {
  const direct = localHtmlPagePath(href);
  if (direct) return /\.html?$/i.test(direct) ? direct : null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.trim());
  } catch {
    return null;
  }
  if (decoded.startsWith("file:")) {
    const path = localHtmlPagePath(decoded);
    return path && /\.html?$/i.test(path) ? path : null;
  }
  return decoded.startsWith("/") && /\.html?$/i.test(decoded) ? decoded : null;
}

/** Whether a chat link names a local `.html` page rather than some other file. */
export function isLocalHtmlPageLink(href: string): boolean {
  return localHtmlPageLinkPath(href) !== null;
}

/**
 * What one host read means for the transcript.
 *
 * The page renders only from `text` content the cap allows: a binary, missing,
 * empty, unreadable or oversized file leaves the link the message already had,
 * so a failed read never invents an empty frame.
 */
export function localHtmlPageFromRead(
  result: FsReadResult | null | undefined,
): LocalHtmlPage {
  if (!result || result.kind !== "text") return { status: "unavailable" };
  const code = result.content ?? "";
  if (!code.trim() || code.length > MAX_HTML_PAGE_SOURCE_LENGTH) {
    return { status: "unavailable" };
  }
  return { status: "ready", code };
}

/** Run one read for inline display; a rejected read is simply not renderable. */
export async function loadLocalHtmlPage(
  read: ReadLocalHtmlPage,
): Promise<LocalHtmlPage> {
  try {
    return localHtmlPageFromRead(await read());
  } catch {
    return { status: "unavailable" };
  }
}