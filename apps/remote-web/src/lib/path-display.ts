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
 *
 * The rule itself is `@minih-agent/shared`, shared with the Host, because the
 * separator belongs to the Host's platform: a Windows Host answers
 * `C:\Users\me\app`, and nothing about this bundle tells it otherwise.
 */
import { shortenRemoteHomePath } from "@minih-agent/shared";

import type { BrowseEntry } from "./mutations.js";

/** The root the Host browses from: everything it can list lives under this. */
export function displayPath(path: string, root: string | null | undefined): string {
  return root ? shortenRemoteHomePath(path, root) : path;
}

/** The same rule for one picker entry. */
export function displayEntry(entry: BrowseEntry, root: string | null | undefined): BrowseEntry {
  return { name: entry.name, path: displayPath(entry.path, root) };
}
