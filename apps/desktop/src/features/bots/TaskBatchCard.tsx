import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { TaskCompletionCard } from "./TaskCompletionCard";
import { batchMergeOrder, isAccepted, type TaskBatch } from "./task-delivery";

/**
 * 「汇总卡」: one sentence became several cards, and all of them are finished
 * (employee mode 0.5 slice 4b).
 *
 * It exists because reviewing three completions one conversation at a time is
 * three times the work, and because the merge order matters: the cards were
 * proposed in an order, and merging them out of that order is how a later card
 * lands on a `main` its own branch never saw.
 *
 * 「全部接受」 walks that order and stops at the first refusal. A task that
 * cannot merge is only *accepted* — the batch does not pretend otherwise, and
 * its own card stays there to be merged later.
 */
export function TaskBatchCard({
  batch,
  names,
  stewardSessionId,
  onChanged,
}: {
  batch: TaskBatch;
  /** Employee display names, keyed by session id. */
  names: Record<string, string>;
  stewardSessionId?: string | null;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);

  const acceptAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const finished: string[] = [];
    try {
      for (const task of batchMergeOrder(batch)) {
        if (done.includes(task.id) || task.archivedAt) {
          finished.push(task.id);
          continue;
        }
        const check = await api.checkTaskDelivery(task.id);
        if (!check?.canMerge) {
          // "Cannot merge" is not a failure of the batch: the work is accepted,
          // and its own card keeps the merge for when the conditions hold.
          await api.acceptTask(task.id);
          finished.push(task.id);
          continue;
        }
        const result = await api.mergeTaskDelivery(task.id);
        finished.push(task.id);
        if (!result?.merged) {
          // The first refusal stops the batch: the next card would land on a
          // `main` the stopped one never reached.
          setError(
            t("bots.completion.batchStopped", {
              shortId: task.shortId,
              step: result?.failedStep ?? "",
              detail: result?.detail ?? "",
            }),
          );
          break;
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDone(finished);
      setBusy(false);
      onChanged?.();
    }
  };

  return (
    <section
      className="task-batch-card"
      role="region"
      aria-label={t("bots.completion.batchTitle", { count: batch.tasks.length })}
      data-task-batch={batch.batchId}
      aria-busy={busy ? true : undefined}
    >
      <div className="task-batch-header">
        <span className="task-batch-title">
          {t("bots.completion.batchTitle", { count: batch.tasks.length })}
        </span>
        <span className="task-batch-hint">{t("bots.completion.batchOrder")}</span>
      </div>

      <ol className="task-batch-rows">
        {batchMergeOrder(batch).map((task, index) => (
          <li
            key={task.id}
            className="task-batch-row"
            data-batch-row={task.id}
            data-batch-accepted={isAccepted(task) ? "true" : "false"}
          >
            <span className="task-batch-index">{index + 1}</span>
            <span className="task-batch-task">#{task.shortId}</span>
            <span className="task-batch-goal">{task.title}</span>
            <span className="task-batch-employee">
              {names[task.employeeSessionId] ?? ""}
            </span>
            <span className="task-batch-state">
              {isAccepted(task)
                ? t("bots.completion.rowAccepted")
                : t("bots.completion.rowFinished")}
            </span>
          </li>
        ))}
      </ol>

      {error ? (
        <p className="task-batch-error" role="alert">
          {error}
        </p>
      ) : null}

      {expanded ? (
        <div className="task-batch-expanded">
          {batch.tasks.map((task: TaskView) => (
            <TaskCompletionCard
              key={task.id}
              task={task}
              employeeName={names[task.employeeSessionId]}
              stewardSessionId={stewardSessionId}
              onChanged={onChanged}
              variant="dock"
            />
          ))}
        </div>
      ) : null}

      <div className="task-batch-actions">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void acceptAll()}
          data-batch-accept-all=""
        >
          {t("bots.completion.acceptAll")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => setExpanded((current) => !current)}
          data-batch-expand=""
        >
          {expanded ? t("bots.completion.collapseOneByOne") : t("bots.completion.oneByOne")}
        </Button>
      </div>
    </section>
  );
}
