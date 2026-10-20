/**
 * How the phone shows a directory path (rollout A2).
 *
 * The Host's folder picker answers with absolute paths, and the browse root is
 * the user's home directory. Showing `/home/<user>/Projects/app` on a phone
 * leaks an account name the user never typed there and is longer than the screen
 * can hold, so a path under the root is shown from the root: `~/Projects/app`.
 *
 * This is display only. The request always carries the Host's own spelling —
 * rewriting a path before sending it would be a second, weaker copy of the
 * Host's root check.
 */
import type { BrowseEntry } from "./mutations.js";

/** The root the Host browses from: everything it can list lives under this. */
export function displayPath(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (!normalizedRoot) return path;
  if (path === normalizedRoot) return "~";
  const prefix = `${normalizedRoot}/`;
  if (!path.startsWith(prefix)) return path;
  return `~/${path.slice(prefix.length)}`;
}

/** The same rule for one picker entry. */
export function displayEntry(entry: BrowseEntry, root: string | null | undefined): BrowseEntry {
  return { name: entry.name, path: displayPath(entry.path, root) };
}
