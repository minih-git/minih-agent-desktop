/**
 * How an absolute path belonging to *another* machine is recognized (D670
 * amendment, rollout R7).
 *
 * A Host answers `project/browse` and accepts `project/register` in its own
 * native spelling. The desktop and the phone never resolve those paths against
 * their own filesystem, so they cannot use `path` — the separator belongs to
 * the Host's platform, not to the client's. Assuming POSIX (a leading `/`) made
 * every Windows Host unusable: the Host answered `C:\Users\me`, the desktop
 * rejected the answer as malformed, and the folder picker showed neither the
 * root nor any directory.
 *
 * The rules here are the client's read of the Host's own rules, and nothing
 * more:
 *   - three absolute shapes exist: POSIX (`/…`), a Windows drive (`C:\…` or
 *     `C:/…`), and a Windows UNC share (`\\server\share\…`);
 *   - a child entry's path is its parent plus one separator plus its name,
 *     whichever separator that Host style uses;
 *   - a name is a single component, so it carries no separator of its style,
 *     is never `.` or `..`, carries no control character, and is bounded.
 *
 * This is a *shape* check that keeps untrusted Host data out of the renderer.
 * It never decides what the Host may reach: root confinement, `..` collapsing
 * and symlink escape stay in the Host (`resolveBrowsableDirectory`), which is
 * also where a path that does not exist is refused.
 */

/** The longest remote path either end accepts, matching `WorkspaceFilesRequestSchema`. */
export const REMOTE_PATH_MAX_LENGTH = 4096;

/** The longest single directory name in a browse answer. */
export const REMOTE_ENTRY_NAME_MAX_LENGTH = 4096;

/** Windows drive-letter form, either separator: `C:\Users` or `C:/Users`. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Windows UNC form: `\\server\share`. A single leading backslash is
 * root-relative on the current drive, not absolute, so it is not accepted; the
 * extended-length `\\?\C:\…` form starts with `\\` as well and is accepted.
 */
const WINDOWS_UNC = /^\\\\[^\\/]/;

/** Characters no path or name may carry: they end a NUL-delimited string. */
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

/**
 * Whether `value` is an absolute path in a Host's native spelling.
 *
 * Every caller keeps its own length and identity rules; this answers only the
 * spelling question, so a Guard, an IPC handler and a renderer field all agree.
 */
export function isAbsoluteRemotePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > REMOTE_PATH_MAX_LENGTH) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  return value.startsWith("/") || WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value);
}

/**
 * The separator the Host used in `path`: `\` for a Windows spelling, `/` for
 * everything else.
 *
 * Derived from the path rather than from `node:path`, because the path belongs
 * to the other machine: this runs unchanged on a POSIX desktop that is talking
 * to a Windows Host. A POSIX path may legitimately contain a backslash in a
 * directory name, so a leading `/` always means POSIX.
 */
export function remotePathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.startsWith("/") ? "\\" : "/";
}

/**
 * The two child spellings under `directory`: the same joining separator the
 * directory's own components use, and the other one.
 *
 * Both are built because Windows accepts `/` and `\` between components, so a
 * Host may answer with either. Accepting both cannot weaken the check:
 * `directory` must match exactly — the parent is not respelled — and `name`
 * carries no separator at all.
 */
export function remoteChildPaths(directory: string, name: string): string[] {
  const base = directory.replace(/[\\/]+$/, "");
  return [`${base}/${name}`, `${base}\\${name}`];
}

/** Whether `child` is exactly `name` directly under `directory`. */
export function isRemoteChildPath(directory: string, name: string, child: string): boolean {
  return remoteChildPaths(directory, name).includes(child);
}
/**
 * Whether `name` is one directory name inside `directory`, by that Host's own
 * rules.
 *
 * Windows forbids both separators in a name; POSIX forbids only `/`, so a
 * backslash is an ordinary character and a POSIX Host may legitimately offer
 * such a directory. Rejecting it there would fail the whole listing over one
 * entry the Host is allowed to have.
 */
export function isRemoteEntryName(name: unknown, directory: string): name is string {
  if (typeof name !== "string" || !name || name.length > REMOTE_ENTRY_NAME_MAX_LENGTH) return false;
  if (CONTROL_CHARACTERS.test(name) || name === "." || name === "..") return false;
  return remotePathSeparator(directory) === "\\" ? !/[\\/]/.test(name) : !name.includes("/");
}

/**
 * `path` with `root` written as `~`, for anything a person reads: the desktop's
 * device notice, the project picker and the phone's folder picker.
 *
 * A path outside the root is returned unchanged, so a notice can never look
 * like it is inside the root when it is not. Selections are display only — the
 * request always carries the Host's own absolute spelling.
 */
export function shortenRemoteHomePath(path: string, root: string): string {
  const separator = remotePathSeparator(root);
  const normalized = root.endsWith(separator) ? root.slice(0, -separator.length) : root;
  if (!normalized) return path;
  if (path === normalized) return "~";
  const prefix = `${normalized}${separator}`;
  return path.startsWith(prefix) ? `~${separator}${path.slice(prefix.length)}` : path;
}