import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isTaskInterrupted, type TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Select } from "../../components/ui";
import { TaskRestartButton } from "./TaskRestartButton";
import { retryResumesDelivery } from "./task-delivery";
import { isRelayBlocked, relayBlockerText } from "./task-relay";
import { useBots } from "./use-bots";
import { blockedFields } from "./task-waiting";

/**
 * 「卡住卡」: what the person sees when a task stopped moving (employee mode 0.5
 * slice 4a).
 *
 * Three situations share one card, because the person's next action is the same
 * in all three and the difference is only in what it says:
 *
 * - **blocked** — the employee called `TaskReport`, so the card shows its own
 *   three fields: where it stopped, what it already tried, what it suggests;
 * - **failed** — the turn failed, so the card shows the code the runtime settled;
 * - **interrupted** — the app restarted while the work was running, and the card
 *   says exactly that instead of pretending the work is still going.
 *
 * The four buttons are the four decisions the ADR gives the person: try again,
 * hand it to somebody else, give up, or say something. 「重新开工」 is the retry
 * of an interrupted task, and it lives *inside* this card rather than beside it —
 * two sets of buttons for one stuck task was the defect this replaced.
 */
export function TaskBlockedCard({
  task,
  employeeName,
  onChanged,
}: {
  task: TaskView;
  /** The employee's name; the card's heading names who got stuck. */
  employeeName?: string;
  /** The steward's current name; the reassignment note names its conversation. */
  stewardName?: string;
  /** Where 「改派给…」 proposes its card; the host resolves its own if absent. */
  stewardSessionId?: string | null;
  /** Called after the host answered, so the caller can refetch its own rows. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const { bots } = useBots();
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const selectSession = useAppStore((state) => state.selectSession);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDrop, setConfirmingDrop] = useState(false);
  const [reassignedTo, setReassignedTo] = useState<string | null>(null);
  const [reassignTarget, setReassignTarget] = useState("");

  const fields = blockedFields(task);
  const interrupted = isTaskInterrupted(task);
  // A relay step that lost the step before it: the two decisions are "start from
  // main" and "give up", and neither retry nor reassignment applies (slice 7).
  const relayStuck = isRelayBlocked(task.blocker);
  const relayNote = relayBlockerText(task.blocker, t);
  const who = employeeName?.trim() || t("bots.card.targetUnknown");

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const retry = () =>
    run("retry", async () => {
      if (retryResumesDelivery(task)) {
        // The work is done; what stopped was the host's own merge. Trying again
        // is the click, and the host resumes at the first step that is not done.
        const result = await api.mergeTaskDelivery(task.id);
        if (!result?.merged) {
          setError(
            t("bots.completion.mergeFailed", {
              step: result?.failedStep ?? "",
              detail: result?.detail ?? "",
            }),
          );
        }
        return;
      }
      // A fixed message in the person's own language: it is the click, not a
      // sentence they had to write.
      const accepted = await sendPrompt(t("bots.blocked.retryMessage"), undefined, task.sessionId);
      if (!accepted) setError(t("bots.blocked.retryBusy"));
    });
  const reassign = (employeeSessionId: string) =>
    run("reassign", async () => {
      const result = await api.reassignTask({
        taskId: task.id,
        targetSessionId: employeeSessionId,
        reason: t("bots.blocked.reassignReason", { shortId: task.shortId }),
      });
      if (result.startError) setError(result.startError);
      setReassignedTo(bots.find((bot) => bot.sessionId === employeeSessionId)?.profile.name || employeeSessionId);
    });


  /**
   * 「改从 main 开工」: drop the edge to the step that cannot be continued and
   * build this step's workspace from the project's own `main`.
   *
   * The host refuses it for any other kind of blocker, so the card only offers
   * it where it means something.
   */
  const detach = () =>
    run("detach", async () => {
      const result = await api.detachTask(task.id);
      if (result.startError) {
        setError(t("bots.blocked.startFromMainFailed", { reason: result.startError }));
      }
    });

  const drop = () =>
    run("drop", async () => {
      await api.archiveTask(task.id, true);
      setConfirmingDrop(false);
    });

  const saySomething = () => {
    void selectSession(task.sessionId);
    // The composer is the input of the session that was just selected; focusing
    // it is what makes 「我来说两句」 one click instead of two.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(".composer-dock textarea, .composer-dock [contenteditable='true']")
        ?.focus();
    });
  };

  return (
    <section
      className="task-blocked-card"
      role="region"
      aria-label={t("bots.blocked.title", { name: who })}
      data-task-blocked={task.id}
      data-blocked-source={fields.source}
      data-task-stage={task.stage}
      aria-busy={busy ? true : undefined}
    >
      <div className="task-blocked-header">
        <span className="task-blocked-title">{t("bots.blocked.title", { name: who })}</span>
        <span className="task-blocked-task">#{task.shortId}</span>
      </div>
      <p className="task-blocked-goal">{task.title}</p>

      {interrupted ? (
        <p className="task-blocked-note" data-blocked-interrupted="">
          {t("bots.blocked.interrupted")}
        </p>
      ) : null}
      {fields.source === "failed" ? (
        <p className="task-blocked-note" data-blocked-failed="">
          {fields.code
            ? t("bots.blocked.failedWithCode", { code: fields.code })
            : t("bots.blocked.failed")}
        </p>
      ) : null}
      {fields.source === "delivery" ? (
        <p className="task-blocked-note" data-blocked-delivery={fields.step ?? ""}>
          {t("bots.blocked.delivery", {
            step: fields.step ?? "",
            detail: fields.detail ?? "",
          })}
        </p>
      ) : null}
      {fields.source === "stopped" ? (
        <p className="task-blocked-note" data-blocked-stopped="">
          {t("bots.blocked.stopped")}
        </p>
      ) : null}
      {fields.source === "unknown" ? (
        // A reason this card does not know says only that it stopped: it is not
        // the person's own decision, and naming one would be a lie.
        <p className="task-blocked-note" data-blocked-unknown="">
          {t("bots.blocked.unknown")}
        </p>
      ) : null}
      {relayNote ? (
        <p className="task-blocked-note" data-blocked-relay={task.blocker?.reason ?? ""}>
          {relayNote}
          {task.blocker?.detail ? <span className="task-blocked-detail"> · {task.blocker.detail}</span> : null}
        </p>
      ) : null}

      {fields.where || fields.tried || fields.suggestion ? (
        <dl className="task-blocked-fields">
          {fields.where ? (
            <>
              <dt>{t("bots.blocked.where")}</dt>
              <dd>{fields.where}</dd>
            </>
          ) : null}
          {fields.tried ? (
            <>
              <dt>{t("bots.blocked.tried")}</dt>
              <dd>{fields.tried}</dd>
            </>
          ) : null}
          {fields.suggestion ? (
            <>
              <dt>{t("bots.blocked.suggestion")}</dt>
              <dd>{fields.suggestion}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {error ? (
        <p className="task-blocked-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="task-blocked-actions">
        {!relayStuck && !reassignedTo ? (
          <div className="task-blocked-reassign">
            <Select
              aria-label={t("bots.blocked.reassignTarget")}
              value={reassignTarget}
              disabled={Boolean(busy)}
              onChange={(event) => setReassignTarget(event.target.value)}
              data-blocked-reassign-target=""
            >
              <option value="">{t("bots.blocked.reassignTarget")}</option>
              {bots
                .filter((bot) => bot.sessionId !== task.employeeSessionId)
                .map((bot) => (
                  <option key={bot.sessionId} value={bot.sessionId}>
                    {bot.profile.name || bot.title}
                  </option>
                ))}
            </Select>
            <Button
              variant="secondary"
              disabled={!reassignTarget || Boolean(busy)}
              onClick={() => void reassign(reassignTarget)}
              data-blocked-reassign=""
            >
              {busy === "reassign" ? t("bots.blocked.reassigning") : t("bots.blocked.reassign")}
            </Button>
          </div>
        ) : reassignedTo ? (
          <p className="task-blocked-note" data-blocked-reassigned="" role="status">
            {t("bots.blocked.reassigned", { agent: reassignedTo })}
          </p>
        ) : null}
        {relayStuck ? (
          // Neither retry nor reassignment helps a step whose predecessor cannot
          // be continued: the two decisions are the person's, and the host picks
          // neither on its own.
          <Button
            variant="secondary"
            disabled={Boolean(busy)}
            onClick={() => void detach()}
            data-blocked-start-from-main=""
          >
            {busy === "detach" ? t("bots.blocked.startFromMainBusy") : t("bots.blocked.startFromMain")}
          </Button>
        ) : (
          <>
            {interrupted ? (
              // 「重新开工」 is this task's retry: one card, one set of buttons.
              <TaskRestartButton task={task} onRestarted={() => onChanged?.()} />
            ) : (
              // One action at a time: every button is disabled while any of them
              // is in flight, so a second click cannot race the first answer.
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void retry()}>
                {t("bots.blocked.retry")}
              </Button>
            )}
          </>
        )}
        {confirmingDrop ? (
          <>
            <span className="task-blocked-confirm">{t("bots.blocked.dropConfirm")}</span>
            <Button
              variant="primary"
              disabled={Boolean(busy)}
              onClick={() => void drop()}
              data-blocked-drop-confirm=""
            >
              {t("bots.blocked.dropYes")}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingDrop(false)}>
              {t("bots.blocked.dropCancel")}
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            disabled={Boolean(busy)}
            onClick={() => setConfirmingDrop(true)}
            data-blocked-drop=""
          >
            {t("bots.blocked.drop")}
          </Button>
        )}
        <Button variant="ghost" disabled={Boolean(busy)} onClick={saySomething} data-blocked-say="">
          {t("bots.blocked.saySomething")}
        </Button>
      </div>
    </section>
  );
}