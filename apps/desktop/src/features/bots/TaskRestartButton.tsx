import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isTaskInterrupted, type TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";

/**
 * 「重新开工」: the person's way back from an interrupted task (employee mode 0.5
 * slice 3, the sixth defect).
 *
 * ADR 0239's startup fence never replays work, so nothing resumes on its own —
 * that is deliberate. What was missing is that the interruption was invisible
 * and there was no way back. This is the way back, and it is one click: the host
 * writes one new delivery from the same mandate and Main starts it through the
 * same dispatch a confirmed card uses.
 *
 * It renders nothing for a task that is not interrupted, so the header can place
 * it unconditionally and an ordinary task never grows a button.
 */
export function TaskRestartButton({
  task,
  onRestarted,
}: {
  task: TaskView;
  /** Called after the host answered, so the caller can refresh its own row. */
  onRestarted?: (task: TaskView) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isTaskInterrupted(task)) return null;

  const restart = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await api.restartTask(task.id)) as {
        task?: TaskView;
        startError?: string;
      };
      // A restart that the host accepted but the runtime did not start still
      // changed the task: say so instead of showing a calm "restarted" over
      // work that is not running.
      if (result?.startError) setError(t("bots.tasks.restartNotStarted", { reason: result.startError }));
      if (result?.task) onRestarted?.(result.task);
    } catch (cause) {
      setError(
        t("bots.tasks.restartFailed", {
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="task-restart" data-task-restart={task.id}>
      <Button variant="secondary" disabled={busy} onClick={() => void restart()}>
        {busy ? t("bots.tasks.restarting") : t("bots.tasks.restart")}
      </Button>
      {error ? (
        <span className="task-restart-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}