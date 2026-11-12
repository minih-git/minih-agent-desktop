import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { useBots } from "./use-bots";

/**
 * The tasks of one employee, or of everyone, as a surface renders them
 * (ADR bot-sessions-and-steward §7).
 *
 * State lives here rather than in `stores/app-store.ts` for the same reason the
 * employee roster does: it is one feature's concern, it comes from `task.list`,
 * and nothing else in the app reads it.
 *
 * The hook never creates anything. A task starts from a person's action in the
 * workbench or from a confirmed card, and this only reads what the host now
 * holds — including a stage the host moved on its own, which arrives on
 * `tasksChanged`.
 */
export type TasksState = {
  tasks: TaskView[];
  /** First paint only; later reloads keep the rows and dim them. */
  loading: boolean;
  /** True once a read has written rows, so a surface can tell "none" from "not yet". */
  hydrated: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

export function useTasks(
  employeeSessionId: string | null | undefined,
  options: { includeArchived?: boolean; since?: number | null } = {},
): TasksState {
  const { includeArchived = false, since = null } = options;
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may write state, so a slow fetch for a previous
  // employee cannot land after a newer one and overwrite it.
  const latestRequest = useRef(0);
  const hydrated = useRef(false);

  const reload = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const result = await api.listTasks({
        ...(employeeSessionId ? { employeeSessionId } : {}),
        ...(includeArchived ? { includeArchived: true } : {}),
        ...(since ? { since } : {}),
      });
      if (requestId !== latestRequest.current) return;
      setTasks(result.tasks ?? []);
      setError(null);
    } catch (cause) {
      if (requestId !== latestRequest.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === latestRequest.current && !hydrated.current) {
        hydrated.current = true;
        setLoading(false);
      }
    }
  }, [employeeSessionId, includeArchived, since]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => api.onTasksChanged(() => void reload()), [reload]);

  return { tasks, loading, hydrated: hydrated.current, error, reload };
}

/**
 * The task behind the session on screen, with the employee's name for the
 * composer's placeholder.
 *
 * A task session's compose box talks to that task's employee, so the wording
 * needs both the task (is it archived?) and the employee (who am I addressing?).
 * Everything is read from the host, and a non-task session costs one render and
 * no request.
 */
export function useTaskSession(
  session: { id?: string; role?: string } | null | undefined,
): { task: TaskView; archivedAt?: string; employeeName?: string } | null {
  const isTask = session?.role === "task";
  // Every task of every employee: one read answers "is this session a task, and
  // is it archived", which is all the composer asks.
  const state = useTasks(null, { includeArchived: true });
  const tasks = isTask ? state.tasks : [];
  const task = tasks.find((row) => row.sessionId === session?.id);
  const bots = useBots();
  if (!task) return null;
  const employee = bots.bots.find((bot) => bot.sessionId === task.employeeSessionId);
  return {
    task,
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
    ...(employee ? { employeeName: employee.profile.name || employee.title } : {}),
  };
}
