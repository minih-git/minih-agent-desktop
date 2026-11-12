import {
  TASK_WORKSPACE_UNSAVED,
  TASK_WORKSPACE_UNSAVED_UNKNOWN,
  type TaskView,
} from "@minih-agent/shared";

/**
 * What a task's workspace adds to the person's screen (employee mode 0.5,
 * slice 2; ADR 0329 and its 2026-11 amendment).
 *
 * The workbench row and the task header must not disagree about the same
 * folder, so how a workspace is described in words is decided once, here.
 *
 * The host owns the facts — where the folder is, which branch it got, whether it
 * is ready — and this module only turns them into one line a person reads. It
 * stays free of the IPC client so the rules can be tested without a renderer.
 */

/** The i18n key for a workspace state; `none` has nothing to say. */
export function workspaceStatusKey(status: TaskView["workspaceStatus"]): string | null {
  switch (status) {
    case "preparing":
      return "bots.tasks.workspacePreparing";
    case "ready":
      return "bots.tasks.workspaceReady";
    case "failed":
      return "bots.tasks.workspaceFailed";
    default:
      return null;
  }
}

/** The i18n key for how the work will be delivered; `none` has nothing to say. */
export function deliveryModeKey(mode: TaskView["deliveryMode"]): string | null {
  switch (mode) {
    case "pr":
      return "bots.tasks.deliveryPr";
    case "local":
      return "bots.tasks.deliveryLocal";
    default:
      return null;
  }
}

/**
 * The ref a task branched from, in the short form a header can hold:
 * `refs/remotes/origin/main` reads as `origin/main`, `refs/heads/main` as
 * `main`. Anything else is returned as the host stored it, because inventing a
 * prettier name for an unknown ref would be a guess.
 */
export function baseRefLabel(
  baseRef: string | undefined,
  remote: boolean | undefined,
): { label: string; remote: boolean } | null {
  const trimmed = baseRef?.trim();
  if (!trimmed) return null;
  const fromRemote = trimmed.startsWith("refs/remotes/");
  const short = trimmed
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\//, "");
  if (!short) return null;
  return { label: short, remote: Boolean(remote ?? fromRemote) };
}

/** The branch the task actually works on, falling back to the one it asked for. */
export function taskBranch(task: Pick<TaskView, "workspaceBranch" | "branch">): string | null {
  return task.workspaceBranch?.trim() || task.branch?.trim() || null;
}

/**
 * Whether the host's archive refusal means "ask me before discarding".
 *
 * Two answers ask: "the workspace still holds work" and "the workspace could not
 * be checked". The second one is not a pass — a commit count that could not be
 * read says nothing about what the folder holds, and archiving anyway would
 * delete commits that exist only on this machine.
 */
export function asksBeforeDiscarding(code: string | undefined): boolean {
  return code === TASK_WORKSPACE_UNSAVED || code === TASK_WORKSPACE_UNSAVED_UNKNOWN;
}
