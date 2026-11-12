import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskView } from "@minih-agent/shared";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import {
  asksBeforeDiscarding,
  baseRefLabel,
  deliveryModeKey,
  taskBranch,
  workspaceStatusKey,
} from "./task-workspace";

/**
 * A task's workspace, on the surface that has to show it: its workbench row and
 * its own session header (employee mode 0.5 slice 2).
 *
 * One component for both, because the two must never describe the same folder
 * differently: preparing, ready or failed, on which branch, from which commit,
 * delivered how. It reads the row it was given and keeps the answer the host
 * returned from a retry, so a fixed workspace shows as ready without waiting for
 * a list refresh.
 *
 * Nothing here decides policy. "Retry" asks the host to prepare again, and
 * "Archive" asks the host to archive — including the refusal that comes back
 * while the folder still holds work, which is the one question this component
 * puts to the person.
 */
export function TaskWorkspaceStatus({
  task,
  withRetry = false,
  withArchive = false,
}: {
  task: TaskView;
  /** Offer "retry preparing" when the preparation failed. */
  withRetry?: boolean;
  /** Offer to archive the task, with the discard confirmation. */
  withArchive?: boolean;
}) {
  const { t } = useTranslation();
  const [row, setRow] = useState(task);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => setRow(task), [task]);

  const retry = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.retryTaskWorkspace(row.id);
      if (result?.task) setRow(result.task);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    setFailure(null);
    try {
      // The host refuses while the workspace still holds work; the second
      // click is the person saying they know, and it is the only path to
      // `discard`.
      try {
        await api.archiveTask(row.id);
      } catch (cause) {
        // "It still holds work" and "it could not be checked" both ask before
        // discarding; anything else is a real failure the person should see.
        const code = (cause as { code?: string } | null)?.code;
        if (!asksBeforeDiscarding(code)) throw cause;
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (!window.confirm(t("bots.tasks.archiveDiscardConfirm", { detail }))) return;
        await api.archiveTask(row.id, true);
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const statusKey = workspaceStatusKey(row.workspaceStatus);
  if (!statusKey) return null;
  const branch = taskBranch(row);
  const base = baseRefLabel(row.baseRef, row.baseRemote);
  const deliveryKey = deliveryModeKey(row.deliveryMode);
  const error = failure ?? row.workspaceError ?? null;

  return (
    <span
      className="task-workspace"
      data-task-workspace={row.id}
      data-task-workspace-status={row.workspaceStatus}
    >
      <span className="ct-chip" data-task-workspace-state={row.workspaceStatus}>
        {t(statusKey)}
      </span>
      {branch ? (
        <span className="ct-chip" data-task-workspace-branch={branch}>
          {branch}
        </span>
      ) : null}
      {base ? (
        <span
          className="ct-chip"
          data-task-workspace-base={base.remote ? "remote" : "local"}
        >
          {base.remote ? base.label : t("bots.tasks.baseLocal", { branch: base.label })}
        </span>
      ) : null}
      {deliveryKey ? (
        <span
          className="ct-chip"
          data-task-delivery={row.deliveryMode ?? "none"}
        >
          {t(deliveryKey)}
        </span>
      ) : null}
      {withRetry && row.workspaceStatus === "failed" ? (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          data-task-workspace-retry=""
          onClick={() => void retry()}
        >
          {busy ? t("bots.tasks.workspacePreparing") : t("bots.tasks.retryWorkspace")}
        </Button>
      ) : null}
      {withArchive ? (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          data-task-archive=""
          onClick={() => void archive()}
        >
          {t("bots.tasks.archive")}
        </Button>
      ) : null}
      {error ? (
        <span className="task-workspace-error" role="status" data-task-workspace-error="">
          {error}
        </span>
      ) : null}
    </span>
  );
}