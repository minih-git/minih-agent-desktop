import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";

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
