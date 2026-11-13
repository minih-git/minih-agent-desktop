import type { BotListItem, TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import type { ToastOptions } from "../app-state";

/**
 * The waiting channel's renderer half (employee mode 0.5 slice 4a).
 *
 * Two jobs, both of which need the task list and the employee roster together:
 *
 * - **Name a task in a notification.** A task session's id is all an event
 *   carries, while the person needs "<employee> · <task> 在等你". One small
 *   directory is kept here, refreshed on `tasksChanged` / `botsChanged`, so the
 *   notifier stays synchronous.
 * - **Announce a task that stopped.** A stage that became `blocked` (not the
 *   person's own stop) or `failed` gets one pinned reminder and one system
 *   notification per `stage_seq`. The native side keeps its own viewing/focus
 *   policy in Main (`shouldShowNativeNotification`), so a task the person is
 *   already reading does not pop.
 *
 * Everything here is best-effort: a failed read costs a nicer title, never the
 * notification that already went out.
 */

export type TaskWaitingLabels = { employee?: string; task: string };

const directory = new Map<string, TaskWaitingLabels>();
/** The last `stage_seq` a stuck task was announced at, per task id. */
const announcedStage = new Map<string, number>();

/** The employee and task title for one task session, when the roster is loaded. */
export function taskLabelsFor(sessionId: string | null | undefined): TaskWaitingLabels | undefined {
  if (!sessionId) return undefined;
  return directory.get(sessionId);
}

/** The employee's name for a task, for the blocked card's heading. */
export function employeeNameOf(
  employees: readonly BotListItem[] | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!employees || !sessionId) return undefined;
  const employee = employees.find((bot) => bot.sessionId === sessionId);
  const name = employee?.profile?.name?.trim() || employee?.title?.trim();
  return name || undefined;
}

/**
 * What the card and the notification say about a stuck task.
 *
 * `stopped` is excluded on purpose: the person's own click is not news, and a
 * reminder about it would be the second time they are told what they just did.
 */
export function stuckNotice(task: TaskView): { reason: "blocked" | "failed"; where?: string } | null {
  if (task.archivedAt) return null;
  if (task.blocker?.reason === "stopped") return null;
  if (task.stage !== "blocked" && task.stage !== "failed") return null;
  return {
    reason: task.stage === "failed" ? "failed" : "blocked",
    ...(task.blocker?.where ? { where: task.blocker.where } : {}),
  };
}

type StoppedNoticeText = { title: string; body: string };

/**
 * Start listening. Returns the unsubscribe pair, so a test (or a shutdown) can
 * stop it without leaving a listener behind.
 */
export function startTaskWaitingRuntime({
  translate,
  showToast,
  notifyNative,
}: {
  translate: (key: string, options?: Record<string, unknown>) => string;
  showToast: (message: string, options: ToastOptions) => void;
  notifyNative: typeof api.showNativeNotification;
}): () => void {
  // The store module is imported by SSR too (extension E2E, docs), where there is
  // no preload bridge: nothing can be listened to and nothing can be announced.
  if (typeof window === "undefined" || !window.minihAgent?.on) return () => undefined;
  let cancelled = false;

  const refresh = async () => {
    try {
      const [listed, roster] = await Promise.all([api.listTasks({}), api.listBots()]);
      if (cancelled) return;
      const employees = roster?.bots ?? [];
      const next = new Map<string, TaskWaitingLabels>();
      for (const task of listed?.tasks ?? []) {
        next.set(task.sessionId, {
          employee: employeeNameOf(employees, task.employeeSessionId),
          task: task.title,
        });
      }
      directory.clear();
      for (const [key, value] of next) directory.set(key, value);
      announceStopped(listed?.tasks ?? [], employees, { translate, showToast, notifyNative });
    } catch {
      // A read that failed keeps the previous labels: a stale name is better than
      // no notification at all.
    }
  };
  // No read at boot: the store is created before the window shows anything, and a
  // boot-time host call is a cost every surface pays. Every path that creates,
  // moves or archives a task announces it (`services/task-changes.ts`), and every
  // task that can be waiting has been created first, so the first announcement
  // fills the directory before any question can need a name.
  const stopTasks = api.onTasksChanged(() => void refresh());
  const stopBots = api.onBotsChanged(() => void refresh());
  return () => {
    cancelled = true;
    stopTasks?.();
    stopBots?.();
  };
}

/**
 * One pinned reminder and one system notification per stuck task and stage.
 *
 * The dedupe is by `stageSeq` rather than by stage: a task can fail, be retried
 * and fail again, and each of those is its own thing to tell the person.
 */
function announceStopped(
  tasks: readonly TaskView[],
  employees: readonly BotListItem[],
  {
    translate,
    showToast,
    notifyNative,
  }: {
    translate: (key: string, options?: Record<string, unknown>) => string;
    showToast: (message: string, options: ToastOptions) => void;
    notifyNative: typeof api.showNativeNotification;
  },
): void {
  for (const task of tasks) {
    const notice = stuckNotice(task);
    if (!notice) continue;
    const seq = task.stageSeq ?? 0;
    if ((announcedStage.get(task.id) ?? -1) >= seq) continue;
    announcedStage.set(task.id, seq);

    const employee = employeeNameOf(employees, task.employeeSessionId);
    const title = translate("notifications.taskStuckTitle", {
      employee: employee ?? translate("bots.card.targetUnknown"),
    });
    const body = stoppedBody(notice, task, translate);
    // The same separator the prompt toasts use, so two notifications about the
    // same task read alike.
    showToast(`${title}: ${body}`, {
      variant: "warning",
      duration: 0,
      sessionId: task.sessionId,
    });
    void notifyNative({
      id: `${task.id}:${seq}`,
      sessionId: task.sessionId,
      kind: "task",
      title,
      body,
    }).catch(() => undefined);
  }
}

/** Where it stopped, or why it failed, in the words the card would use. */
function stoppedBody(
  notice: { reason: "blocked" | "failed"; where?: string },
  task: TaskView,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (notice.where) return notice.where;
  if (notice.reason === "failed") {
    const code = task.blocker?.code;
    return code
      ? translate("notifications.failedBodyWithCode", { code })
      : translate("notifications.failedBody");
  }
  return translate("notifications.taskStuckInterrupted");
}

/** Test seam: forget what was announced, so a case starts from nothing. */
export function resetTaskWaitingRuntimeForTest(): void {
  directory.clear();
  announcedStage.clear();
}

export type { StoppedNoticeText };