import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskView } from "@minih-agent/shared";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useTasks } from "./use-tasks";

/**
 * A failed workspace, said in full where there is room for it.
 *
 * The session header carries one red chip ("workspace failed") and nothing else:
 * the whole row has a fixed height, so the error text and the retry control used
 * to wrap it and push it out of the window. The words and the way out belong in
 * the content area, as one banner under the header — error on the left, "retry
 * preparing" on the right.
 *
 * Nothing here decides policy. "Retry" asks the host to prepare again and keeps
 * the answer, so a fixed workspace leaves the banner rather than waiting for a
 * list refresh.
 */
export function TaskWorkspaceBanner({ task }: { task: TaskView }) {
  const { t } = useTranslation();
  const [row, setRow] = useState(task);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => setRow(task), [task]);

  if (row.workspaceStatus !== "failed") return null;

  const error = failure ?? row.workspaceError ?? t("bots.tasks.workspaceFailed");

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

  return (
    <div
      className="task-workspace-banner"
      role="status"
      data-task-workspace-banner={row.id}
      data-task-workspace-status={row.workspaceStatus}
    >
      <span className="task-workspace-error" data-task-workspace-error="">
        {error}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        data-task-workspace-retry=""
        onClick={() => void retry()}
      >
        {busy ? t("bots.tasks.workspacePreparing") : t("bots.tasks.retryWorkspace")}
      </Button>
    </div>
  );
}

/**
 * The banner for whatever task session the pane is showing.
 *
 * A task session is the only surface that can have one, so the check comes
 * first and the task list is not read for an ordinary conversation. The two
 * components exist so that check stays a real condition instead of a hook
 * called behind an early return.
 */
export function ActiveTaskWorkspaceBanner() {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const isTaskSession = useAppStore((state) =>
    Boolean(state.sessions.find((session) => session.id === state.activeSessionId)?.role === "task"),
  );
  if (!activeSessionId || !isTaskSession) return null;
  return <TaskSessionBanner sessionId={activeSessionId} />;
}

function TaskSessionBanner({ sessionId }: { sessionId: string }) {
  const state = useTasks(null, { includeArchived: true });
  const task = state.tasks.find((row) => row.sessionId === sessionId);
  if (!task) return null;
  return <TaskWorkspaceBanner task={task} />;
}