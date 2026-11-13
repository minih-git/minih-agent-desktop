import { useTranslation } from "react-i18next";
import type { TaskView } from "@minih-agent/shared";
import { baseRefLabel, deliveryModeKey, taskBranch, workspaceStatusKey } from "./task-workspace";

/**
 * A task's workspace as one row of chips: preparing / ready / failed, the branch
 * it got, where it started from, and how its work will be delivered.
 *
 * Presentation only. What the failure says and how to retry live in
 * `TaskWorkspaceBanner`, because a session header is one fixed-height row and an
 * error message plus a button cannot fit in it: they wrapped the chip row and
 * pushed it off the top of the window. The workbench row and the task header
 * still read this one component, so neither can describe the same folder
 * differently.
 *
 * Chips a narrow header can drop are marked `data-task-optional`, in the order
 * they go: `early` (delivery route) before `late` (branch, base, a healthy
 * state). A failed state keeps no mark, because that is the one chip the person
 * must not lose.
 */
export function TaskWorkspaceStatus({ task }: { task: TaskView }) {
  const { t } = useTranslation();
  const statusKey = workspaceStatusKey(task.workspaceStatus);
  if (!statusKey) return null;
  const branch = taskBranch(task);
  const base = baseRefLabel(task.baseRef, task.baseRemote);
  const deliveryKey = deliveryModeKey(task.deliveryMode);

  return (
    <span
      className="task-workspace"
      data-task-workspace={task.id}
      data-task-workspace-status={task.workspaceStatus}
    >
      <span
        className="ct-chip"
        data-task-workspace-state={task.workspaceStatus}
        data-task-optional={task.workspaceStatus === "failed" ? undefined : "late"}
      >
        {t(statusKey)}
      </span>
      {branch ? (
        <span className="ct-chip" data-task-optional="late" data-task-workspace-branch={branch}>
          {branch}
        </span>
      ) : null}
      {base ? (
        <span
          className="ct-chip"
          data-task-optional="late"
          data-task-workspace-base={base.remote ? "remote" : "local"}
        >
          {base.remote ? base.label : t("bots.tasks.baseLocal", { branch: base.label })}
        </span>
      ) : null}
      {deliveryKey ? (
        <span
          className="ct-chip"
          data-task-optional="early"
          data-task-delivery={task.deliveryMode ?? "none"}
        >
          {t(deliveryKey)}
        </span>
      ) : null}
    </span>
  );
}