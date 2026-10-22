import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  fuzzyMatchPath,
  selectBestMatches,
  type FsIndexEntry,
  type FsIndexResult,
} from "@minih-agent/shared";
import { isIgnoredName } from "./workspace-files.js";

/**
 * Composer "@" snapshot and bounded deeper search (ADR 0024).
 * Git supplies exact ignore semantics; non-git roots use the files-tab ignore
 * set. The initial shallow snapshot stays small, while a nonempty query can
 * search past its cap without sending filesystem work to the renderer.
 */
export const FS_INDEX_MAX_ENTRIES = 8000;
const FS_SEARCH_MAX_ENTRIES = 200_000;
const FS_SEARCH_MAX_RESULTS = 50;
const FS_SEARCH_MAX_QUERY = 256;
const SEARCH_WALK_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 15_000;
const GIT_TIMEOUT_MS = 4000;
const MAX_GIT_BUFFER = 32 * 1024 * 1024;

type Listing = { entries: FsIndexEntry[]; complete: boolean };
type CacheSlot = {
  at: number;
  index: FsIndexResult;
  listing: Listing;
  walked: boolean;
  deeper?: Promise<Listing>;
};
const cache = new Map<string, CacheSlot>();

function hasIgnoredSegment(path: string): boolean {
  return path.split("/").some(isIgnoredName);
}

/** `git ls-files -co --exclude-standard -z`, null when git is unusable. */
function gitListFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root, env: process.env,
    });
    let out = "";
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.length > MAX_GIT_BUFFER) {
        failed = true;
        child.kill();
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) return resolve(null);
      resolve(out.split("\0").filter((path) => path.length > 0));
    });
  });
}

async function walkFiles(
  root: string,
  budget: number,
  deadline = Number.POSITIVE_INFINITY,
): Promise<{ files: string[]; dirs: string[]; exhausted: boolean }> {
  const files: string[] = [];
  const dirs: string[] = [];
  let exhausted = false;
  const queue: string[] = [""];
  for (let next = 0; next < queue.length; next += 1) {
    if (Date.now() > deadline) {
      exhausted = true;
      break;
    }
    const rel = queue[next]!;
    let dirents;
    try {
      dirents = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (isIgnoredName(dirent.name)) continue;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      // Never follow symlinks out of root or into a cycle.
      if (dirent.isDirectory()) {
        dirs.push(childRel);
        queue.push(childRel);
      } else if (dirent.isFile()) {
        files.push(childRel);
      }
      if (files.length + dirs.length >= budget) {
        exhausted = true;
        queue.length = 0;
        break;
      }
    }
  }
  return { files, dirs, exhausted };
}

function dirsFromFilePaths(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let at = file.indexOf("/");
    while (at > 0) {
      dirs.add(file.slice(0, at));
      at = file.indexOf("/", at + 1);
    }
  }
  return [...dirs];
}

function depth(path: string): number {
  let count = 0;
  for (const ch of path) if (ch === "/") count += 1;
  return count;
}

function compareEntries(a: FsIndexEntry, b: FsIndexEntry): number {
  return depth(a.path) - depth(b.path) || a.path.localeCompare(b.path);
}

function toListing(files: string[], dirs: string[], complete: boolean): Listing {
  const entries: FsIndexEntry[] = [
    ...dirs.map((path): FsIndexEntry => ({ path, kind: "dir" })),
    ...files.map((path): FsIndexEntry => ({ path, kind: "file" })),
  ].sort(compareEntries);
  return entries.length > FS_SEARCH_MAX_ENTRIES
    ? { entries: entries.slice(0, FS_SEARCH_MAX_ENTRIES), complete: false }
    : { entries, complete };
}

async function walkListing(root: string, budget: number, deadline?: number): Promise<Listing> {
  const walked = await walkFiles(root, budget, deadline);
  return toListing(walked.files, walked.dirs, !walked.exhausted);
}

async function buildSlot(root: string): Promise<CacheSlot> {
  const viaGit = await gitListFiles(root);
  const files = viaGit?.filter((path) => !hasIgnoredSegment(path));
  const listing = files
    ? toListing(files, dirsFromFilePaths(files), true)
    : await walkListing(root, FS_INDEX_MAX_ENTRIES + 1);
  const { entries, complete } = listing;
  const index = entries.length > FS_INDEX_MAX_ENTRIES
    ? { entries: entries.slice(0, FS_INDEX_MAX_ENTRIES), truncated: true }
    : { entries, truncated: !complete };
  return { at: Date.now(), index, listing, walked: !viaGit };
}

/** Concurrent readers share the listing build and its TTL. */
const pending = new Map<string, Promise<CacheSlot>>();
function slotFor(root: string): Promise<CacheSlot> {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached);
  const inFlight = pending.get(root);
  if (inFlight) return inFlight;
  const build = buildSlot(root).then((slot) => {
    cache.set(root, slot);
    // Large listings expire even if the root is never queried again.
    setTimeout(() => {
      if (cache.get(root) === slot) cache.delete(root);
    }, CACHE_TTL_MS).unref();
    return slot;
  }).finally(() => pending.delete(root));
  pending.set(root, build);
  return build;
}

export async function getWorkspaceFileIndex(root: string): Promise<FsIndexResult> {
  return (await slotFor(root)).index;
}

/** Search at most one bounded deep listing per slot, ranked like the menu. */
export async function searchWorkspaceFiles(
  root: string,
  query: string,
  limit = FS_SEARCH_MAX_RESULTS,
): Promise<FsIndexResult> {
  const needle = query.trim().slice(0, FS_SEARCH_MAX_QUERY);
  if (!needle) return { entries: [], truncated: false };
  const slot = await slotFor(root);
  const listing = slot.walked && !slot.listing.complete
    ? await (slot.deeper ??= walkListing(root, FS_SEARCH_MAX_ENTRIES, Date.now() + SEARCH_WALK_TIMEOUT_MS))
    : slot.listing;
  const best = selectBestMatches(matchEntries(listing.entries, needle), limit, (hit) => ({
    score: hit.score, text: hit.entry.path,
  }));
  return { entries: best.map((hit) => hit.entry), truncated: !listing.complete };
}

function* matchEntries(entries: FsIndexEntry[], query: string) {
  for (const entry of entries) {
    const match = fuzzyMatchPath(query, entry.path, entry.kind);
    if (match) yield { entry, score: match.score };
  }
}
