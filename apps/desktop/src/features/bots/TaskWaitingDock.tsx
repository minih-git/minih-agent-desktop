import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isTaskInterrupted,
  isTaskStuck,
  type PendingInteractiveRequests,
  type TaskView,
  type TaskWaiting,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { stewardNameOf, stewardSessionIdOf } from "./steward-name";
import { useBots } from "./use-bots";
import { useTasks } from "./use-tasks";
import { TaskBlockedCard } from "./TaskBlockedCard";
import { type DockEntry, stewardDockEntries, waitingRowText } from "./task-waiting";

/**
 * The steward's dock: the questions and the stuck cards of the work she
 * dispatched (employee mode 0.5 slice 4a).
 *
 * It is the second of the four surfaces one record shows up in, and it is the one
 * the person can act from without leaving the conversation they are reading. The
 * order is the ADR's — **a question or an approval first, then a stuck task, then
 * the cards** — because that is the order in which work stops moving.
 *
 * Two rules keep it honest:
 *
 * - **The row is never hidden behind a failed read.** If the pending request
 *   cannot be read here, the row says 「去任务里回答」 and stays: hiding it is how
 *   a person loses a task.
 * - **Clicking here is the person's own act.** The steward's model has no tool
 *   that answers a request; only these buttons resolve one.
 */
export function StewardTaskDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { bots } = useBots();
  const { tasks, reload } = useTasks(null, { includeArchived: false });
  const [pending, setPending] = useState<Record<string, PendingInteractiveRequests>>({});
  /**
   * Rows that were answered from this dock. They collapse to one quiet line and
   * stay until the dock is unmounted: the record belonged to the dock, not to the
   * transcript, so nothing is appended to the conversation (ADR §8 of this
   * slice) — but the person still sees that their click landed.
   */
  const [answered, setAnswered] = useState<
    Record<string, { task: TaskView; waiting: TaskWaiting }>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stewardSessionId = stewardSessionIdOf(bots);
  const stewardName = stewardNameOf(bots);
  const entries = useMemo(
    () => stewardDockEntries(tasks, { stewardSessionId }),
    [tasks, stewardSessionId],
  );
  const waitingEntries = entries.filter(
    (entry): entry is Extract<DockEntry, { kind: "waiting" }> =>
      entry.kind === "waiting" && !answered[entry.waiting.requestId],
  );
  const stuckEntries = entries.filter((entry) => entry.kind === "stuck");
  const sessions = useMemo(
    () => [...new Set(waitingEntries.map((entry) => entry.task.sessionId))],
    // The list is derived from the ids only, so a new question on the same
    // session does not refetch what is already loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [waitingEntries.map((entry) => entry.task.sessionId).join(",")],
  );

  const loadPending = useCallback(async () => {
    if (sessions.length === 0) return;
    const loaded = await Promise.all(
      sessions.map(async (taskSessionId) => {
        try {
          return [taskSessionId, await api.pendingInteractive(taskSessionId)] as const;
        } catch {
          // A read that failed is reported as "cannot answer here", never as
          // "nothing is open": the row must stay visible.
          return [taskSessionId, null] as const;
        }
      }),
    );
    setPending((current) => {
      const next = { ...current };
      for (const [taskSessionId, requests] of loaded) {
        if (requests) next[taskSessionId] = requests;
        else delete next[taskSessionId];
      }
      return next;
    });
  }, [sessions]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const names = useMemo(
    () =>
      Object.fromEntries(
        bots.map((bot) => [bot.sessionId, bot.profile?.name?.trim() || bot.title]),
      ),
    [bots],
  );

  const answer = async (
    task: TaskView,
    waiting: TaskWaiting,
    decision: { answers?: string[]; permission?: "allow-once" | "deny" },
  ) => {
    if (busy) return;
    setBusy(waiting.requestId);
    setError(null);
    try {
      if (decision.permission) {
        await api.resolvePermission({
          requestId: waiting.requestId,
          decision: decision.permission,
        });
      } else {
        await api.resolveAskTool({
          requestId: waiting.requestId,
          sessionId: task.sessionId,
          answers: [decision.answers ?? null],
        });
      }
      setAnswered((current) => ({ ...current, [waiting.requestId]: { task, waiting } }));
      await loadPending();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const openTask = (task: TaskView) => {
    void useAppStore.getState().selectSession(task.sessionId);
  };

  if (waitingEntries.length === 0 && stuckEntries.length === 0) return null;

  return (
    <div className="task-card-dock task-waiting-dock" data-testid="task-waiting-dock">
      {error ? (
        <p className="task-waiting-error" role="alert">
          {error}
        </p>
      ) : null}
      {waitingEntries.map(({ task, waiting }) => {
        const { meta, question } = waitingRowText(task, names[task.employeeSessionId]);
        const requests = pending[task.sessionId];
        const ask = requests?.asks.find((entry) => entry.requestId === waiting.requestId);
        const permission = requests?.permissions.find(
          (entry) => entry.requestId === waiting.requestId,
        );
        const options =
          waiting.options && waiting.options.length > 0
            ? waiting.options
            : (ask?.questions?.[0]?.options ?? []).map(optionLabel);

        return (
          <section
            key={`${task.id}:${waiting.requestId}`}
            className="task-waiting-row"
            aria-label={t("bots.waiting.rowLabel", { name: names[task.employeeSessionId] ?? "" })}
            data-task-waiting={task.id}
            data-waiting-request={waiting.requestId}
            data-waiting-kind={waiting.kind}
            data-waiting-can-answer={ask || permission ? "true" : "false"}
          >
            <div className="task-waiting-meta">{meta}</div>
            <p className="task-waiting-question">{question}</p>
            {ask || permission ? (
              <div className="task-waiting-actions">
                {ask
                  ? options.map((label: string) => (
                      <Button
                        key={label}
                        variant="secondary"
                        disabled={busy === waiting.requestId}
                        onClick={() => void answer(task, waiting, { answers: [label] })}
                        data-waiting-option={label}
                      >
                        {label}
                      </Button>
                    ))
                  : null}
                {permission?.toolName ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busy === waiting.requestId}
                      onClick={() => void answer(task, waiting, { permission: "allow-once" })}
                      data-waiting-allow=""
                    >
                      {t("bots.waiting.allow")}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy === waiting.requestId}
                      onClick={() => void answer(task, waiting, { permission: "deny" })}
                      data-waiting-deny=""
                    >
                      {t("bots.waiting.deny")}
                    </Button>
                  </>
                ) : null}
              </div>
            ) : (
              // The request is open but this screen cannot read it (a reloaded
              // renderer, a sidecar generation older than the task). The row
              // stays and says where to answer.
              <div className="task-waiting-actions">
                <Button variant="secondary" onClick={() => openTask(task)} data-waiting-open="">
                  {t("bots.waiting.openTask")}
                </Button>
              </div>
            )}
            <button
              type="button"
              className="task-waiting-goto"
              onClick={() => openTask(task)}
              data-waiting-goto={task.shortId}
            >
              {t("bots.waiting.goToTask", { shortId: task.shortId })}
            </button>
          </section>
        );
      })}
      {Object.entries(answered).map(([requestId, entry]) => {
        const { meta } = waitingRowText(entry.task, names[entry.task.employeeSessionId]);
        return (
          <section
            key={"answered:" + requestId}
            className="task-waiting-row answered"
            data-task-waiting={entry.task.id}
            data-waiting-request={requestId}
            data-waiting-answered="true"
          >
            <div className="task-waiting-meta">{meta}</div>
            <p className="task-waiting-answered">{t("bots.waiting.answered")}</p>
          </section>
        );
      })}
      {stuckEntries.map(({ task }) => (
        <TaskBlockedCard
          key={`stuck:${task.id}`}
          task={task}
          employeeName={names[task.employeeSessionId]}
          stewardName={stewardName}
          stewardSessionId={stewardSessionId}
          onChanged={() => void reload()}
        />
      ))}
    </div>
  );
}

/**
 * The blocked card of the task session the person is reading.
 *
 * It renders nothing unless the open conversation *is* a task that stopped, so
 * the composer can mount it unconditionally: a normal conversation never grows a
 * card, and a working task never grows one either.
 */
export function TaskBlockedCardForSession({ sessionId }: { sessionId: string }) {
  const { tasks, reload } = useTasks(null, { includeArchived: false });
  const { bots } = useBots();
  const task = tasks.find(
    (candidate) => candidate.sessionId === sessionId && !candidate.archivedAt,
  );
  if (!task || !(isTaskStuck(task) || isTaskInterrupted(task))) return null;
  const employee = bots.find((bot) => bot.sessionId === task.employeeSessionId);
  return (
    <TaskBlockedCard
      task={task}
      employeeName={employee?.profile?.name?.trim() || employee?.title}
      stewardName={stewardNameOf(bots)}
      stewardSessionId={stewardSessionIdOf(bots)}
      onChanged={() => void reload()}
    />
  );
}

function optionLabel(option: string | { label?: string }): string {
  return typeof option === "string" ? option : (option.label ?? "");
}