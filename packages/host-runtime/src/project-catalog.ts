/**
 * The project catalog, shared by both Hosts (rollout R7, D666 follow-up).
 *
 * A remote device may list projects, register one, and walk directories to pick
 * one — the same three things a person sitting at the machine can do. Until
 * A2 only `agent-host-cli` offered them; the desktop Host refused, so "new
 * session" on a phone could never reach a desktop. Both Hosts now delegate here
 * so there is exactly one set of rules, not two that drift.
 *
 * The rule that matters is the root: browse and register are confined to one
 * directory (the user's home by default). Canonicalization happens before the
 * check, so `..`, a relative path, and a symlink pointing outside the root are
 * all refused the same way, and a path that does not exist is refused with its
 * own code rather than being created.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { RacpError } from "@minih-agent/agent-host";
import type { RacpProjectCatalog } from "@minih-agent/racp";

import {
  listProjectSummaries,
  toProjectSummary,
  toRacpHostError,
  type HostProjectRow,
} from "./host-catalog-reads.js";
import type { HostRpc } from "./host-ports.js";

/** Directory names never offered by the folder picker. */
const HIDDEN_BROWSE_NAMES = new Set([".git", "node_modules", "__pycache__", ".Trash"]);
/** Cap on one browse answer, so a huge directory cannot become a payload. */
const MAX_BROWSE_ENTRIES = 500;

export type ProjectCatalogDeps = {
  getHost: () => HostRpc | null;
  /**
   * The one directory a remote device may browse and register under. Defaults
   * to the user's home directory, which is what `agent-host-cli` has always
   * used; a test or a Host with a narrower surface may pass its own.
   */
  browseRoot?: string;
};

function requireHost(getHost: () => HostRpc | null): HostRpc {
  const host = getHost();
  if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host-core is not running", { retriable: true });
  return host;
}

/** The root, resolved once so a symlinked home is compared in its real spelling. */
export async function projectBrowseRoot(root: string = homedir()): Promise<string> {
  const absolute = resolve(root);
  return realpath(absolute).catch(() => absolute);
}

/**
 * The same path with the browse root written as `~`, for anything a person
 * reads: the desktop's device notice and the phone's folder picker. A path
 * outside the root is returned unchanged, so a notice can never look like it is
 * inside the root when it is not.
 *
 * The phone has its own copy of this one-line rule (`apps/remote-web/src/lib/
 * path-display.ts`) because that bundle cannot import a Node module; both are
 * display-only, and the request always carries the Host's absolute spelling.
 */
export function shortenHomePath(path: string, root: string): string {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  if (!normalized) return path;
  if (path === normalized) return "~";
  const prefix = `${normalized}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

/**
 * Whether `target` is inside `root`. Compared after `realpath`, so a symlink
 * that leaves the root is outside even when its spelling looks inside.
 */
export function isInsideRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

/** The one refusal for a path outside the root; never says whether it exists. */
const OUTSIDE_ROOT = "path is outside the browsable root";

/**
 * Canonicalize one directory path and prove it is inside the root.
 *
 * A path outside the root is refused with the same code and the same message
 * whether or not it exists, and that check happens before anything is looked up
 * on disk: otherwise a device could map the filesystem outside its own home by
 * telling `REMOTE_PATH_NOT_FOUND` (absent) from `REMOTE_PATH_FORBIDDEN` (present
 * but not allowed). The literal path is checked first — a `..` detour, an
 * absolute path elsewhere, or a missing path outside the root are all outside —
 * and a path that resolves elsewhere through a symlink is caught by the second
 * check.
 *
 * Inside the root the distinction is kept, because it is the caller's own
 * directory: an absent path is `REMOTE_PATH_NOT_FOUND`, and so is an existing
 * file rather than a directory.
 *
 * `root` is the canonical root; `literalRoot` is the same root as the operator
 * spelled it, which matters when the browse root is itself a symlink: a path
 * under the spelling the operator configured is accepted for lookup even though
 * its literal form is not under the canonical root, and the resolved path is
 * checked against the canonical root afterwards either way.
 */
/**
 * The real path of the closest directory that exists above `path`, or
 * `undefined` when nothing above it resolves.
 *
 * Used only for a path that does not exist: the caller has already established
 * that the path's literal spelling is inside the root, so the ancestor is what
 * says whether a symlink on the way out is leading somewhere else.
 */
async function nearestExistingAncestor(path: string): Promise<string | undefined> {
  let current = path;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    try {
      return await realpath(parent);
    } catch {
      current = parent;
    }
  }
}

export async function resolveBrowsableDirectory(
  path: string,
  root: string,
  literalRoot: string = root,
): Promise<string> {
  if (!path.trim()) throw new RacpError("INVALID_ARGUMENT", "path must not be empty");
  if (!isAbsolute(path)) throw new RacpError("INVALID_ARGUMENT", "path must be absolute");
  // The literal spelling, without touching the filesystem: `resolve` collapses
  // `..` and `.`, so a path outside both spellings of the root is refused before
  // any lookup and can never be told apart by whether it exists.
  const literal = resolve(path);
  if (!isInsideRoot(root, literal) && !isInsideRoot(literalRoot, literal)) {
    throw new RacpError("REMOTE_PATH_FORBIDDEN", OUTSIDE_ROOT);
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    // The path is absent, but a symlink on the way to it may leave the root, so
    // the nearest existing ancestor decides the answer: outside the root is the
    // same refusal as an existing path outside it, and only an ancestor inside
    // the root may report `REMOTE_PATH_NOT_FOUND`. Without this, `~/link` →
    // elsewhere would tell a device which paths exist out there.
    const ancestor = await nearestExistingAncestor(path);
    if (ancestor && !isInsideRoot(root, ancestor)) {
      throw new RacpError("REMOTE_PATH_FORBIDDEN", OUTSIDE_ROOT);
    }
    throw new RacpError("REMOTE_PATH_NOT_FOUND", "no such directory");
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) throw new RacpError("REMOTE_PATH_NOT_FOUND", "not a directory");
  // A symlink inside the root can still point outside it; the answer is the
  // same refusal as a literal outside path, so the two are indistinguishable.
  if (!isInsideRoot(root, real)) throw new RacpError("REMOTE_PATH_FORBIDDEN", OUTSIDE_ROOT);
  return real;
}

/**
 * Projects over host-core, with the folder picker's root constraint.
 *
 * `register` accepts only a directory inside the root (the same check `browse`
 * uses), and it does not create anything: host-core canonicalizes and stores
 * the path it is given, and a path outside the root never reaches it.
 */
export function createProjectCatalog(deps: ProjectCatalogDeps): RacpProjectCatalog {
  const { getHost } = deps;
  /** Both spellings of the root: the operator's, and the one the filesystem uses. */
  const rootFor = async () => {
    const literal = resolve(deps.browseRoot ?? homedir());
    return { literal, real: await projectBrowseRoot(literal) };
  };
  return {
    async list() {
      return listProjectSummaries(requireHost(getHost));
    },
    async register(path) {
      const host = requireHost(getHost);
      const root = await rootFor();
      const real = await resolveBrowsableDirectory(path, root.real, root.literal);
      const result = await host
        .call<{ project?: HostProjectRow | null }>("projects.create", { path: real })
        .catch(toRacpHostError);
      if (!result.project) throw new RacpError("INTERNAL", "projects.create returned no project");
      return { ...toProjectSummary(result.project), path: result.project.path };
    },
    async browse(path) {
      const root = await rootFor();
      const target = await resolveBrowsableDirectory(path ?? root.real, root.real, root.literal);
      const dirents = await readdir(target, { withFileTypes: true }).catch(() => {
        throw new RacpError("REMOTE_PATH_FORBIDDEN", "cannot read that directory");
      });
      const entries = dirents
        .filter((dirent) => dirent.isDirectory() && !HIDDEN_BROWSE_NAMES.has(dirent.name) && !dirent.name.startsWith("."))
        .map((dirent) => ({ name: dirent.name, path: join(target, dirent.name) }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_BROWSE_ENTRIES);
      const parent = target === root.real ? undefined : dirname(target);
      return { path: target, ...(parent ? { parent } : {}), entries };
    },
  };
}
