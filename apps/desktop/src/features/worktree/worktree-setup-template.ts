/**
 * The "link the main workspace's dependencies" template (employee mode 0.5,
 * slice 2).
 *
 * A worktree starts without `node_modules`, so the first thing a task does —
 * run a build, run a test — fails for a reason that has nothing to do with the
 * task. The template fills the project's setup command with a POSIX shell
 * snippet that links every `node_modules` from the project into the worktree at
 * the same relative path, which is what this repository's own worktrees do by
 * hand.
 *
 * It is only a template: it is written into the command field for the person to
 * read and edit, and nothing runs until they save.
 */

/**
 * Links every `node_modules` directory of the project into the worktree, at the
 * same relative path, and leaves anything already there alone.
 *
 * `-prune` on `.git` and `.worktree` keeps the walk out of the repository's
 * metadata and out of other tasks' folders; `-prune` on the match itself stops
 * the walk descending into one dependency tree looking for another.
 */
export const MAIN_WORKSPACE_DEPENDENCY_TEMPLATE = `# Link the main workspace's node_modules into this worktree.
find "$PI_PROJECT_ROOT" \\
  \\( -name .git -o -name .worktree \\) -prune -o \\
  -type d -name node_modules -prune -print | while IFS= read -r dir; do
    relative="\${dir#"$PI_PROJECT_ROOT"/}"
    target="$PI_WORKTREE_ROOT/$relative"
    [ -e "$target" ] && continue
    mkdir -p "$(dirname "$target")"
    ln -s "$dir" "$target"
  done`;

/**
 * Whether this platform can run the template as written.
 *
 * It is POSIX shell: `find`, `ln -s` and `${var#prefix}` have no equivalent in
 * cmd.exe or PowerShell, and a Windows "junction" version would silently do
 * something different from what the text says. Offering nothing is more honest
 * than offering something close.
 */
export function setupTemplateAvailable(platform: string | undefined): boolean {
  return platform !== "win32";
}