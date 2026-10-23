import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WorktreeRefContext = { worktree: string; parent: string };

/**
 * A parent-checkout reference means the same file in this isolated session.
 * Only existing file counterparts are mapped; the normal resolver still owns
 * realpath containment, including symlinks. Directories and parent-only files
 * retain the existing outside-root locate-only behavior.
 */
export async function rebaseWorktreeRef(
  ref: string,
  context: WorktreeRefContext | null,
): Promise<string> {
  if (!context || !isAbsolute(ref)) return ref;
  const absolute = resolve(ref);
  if (relativeWithin(context.worktree, absolute) !== null) return ref;
  const suffix = relativeWithin(context.parent, absolute);
  if (!suffix) return ref;
  const candidate = resolve(context.worktree, suffix);
  try {
    return (await stat(candidate)).isFile() ? candidate : ref;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR") return ref;
    throw error;
  }
}

function relativeWithin(root: string, candidate: string): string | null {
  const suffix = relative(resolve(root), candidate);
  return suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
    ? null : suffix;
}
