import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BackgroundTaskOutput, type BackgroundTaskSummary } from "../../../lib/api";
import {
  type BarVisibility,
  EMPTY_VISIBILITY,
  dismissTask,
  nextExpiryAt,
  observeTasks,
  selectVisibleTasks,
  sessionTasks,
} from "./bar-visibility";

const REFRESH_MS = 1_000;
type Failure = "load" | "output" | "stop";

export function useBackgroundTasks(sessionId: string) {
  const [tasks, setTasks] = useState<BackgroundTaskSummary[]>([]);
  // Renderer-local view state: which tasks the bar may show. The registry in
  // host-core stays the source of truth for the processes themselves.
  const [visibility, setVisibility] = useState<BarVisibility>(EMPTY_VISIBILITY);
  const [clock, setClock] = useState(() => Date.now());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [output, setOutput] = useState<BackgroundTaskOutput | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<Failure | null>(null);
  const mounted = useRef(false);
  const pendingStops = useRef(new Set<string>());
  const refreshList = useRef<(() => void) | null>(null);

  // A selection belongs to one conversation's list: switching must not keep
  // polling the previous conversation's task or pin its row into this bar.
  useEffect(() => {
    setExpandedId(null);
    setOutput(null);
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let pollAgain = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      clearTimeout(timer);
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const result = await api.backgroundTasksList();
        if (disposed) return;
        const observedAt = Date.now();
        // The list is process-wide; this bar only ever shows its own session.
        const mine = sessionTasks(result.tasks, sessionId);
        setTasks(mine);
        setVisibility((current) => observeTasks(current, mine, observedAt));
        setClock(observedAt);
        setError((current) => current === "load" ? null : current);
        pollAgain = mine.some((task) => task.state === "running");
      } catch (failure) {
        if (disposed) return;
        console.error("Background task list failed", failure);
        setError("load");
        pollAgain = true;
      } finally {
        inFlight = false;
        if (!disposed) {
          if (queued) {
            queued = false;
            void refresh();
          } else if (pollAgain) {
            timer = setTimeout(() => void refresh(), REFRESH_MS);
          }
        }
      }
    };
    refreshList.current = () => void refresh();
    const unsubscribe = api.onBackgroundTasksChanged(() => void refresh());
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      refreshList.current = null;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [sessionId]);

  // Only what the bar should render: running tasks, a finished task during its
  // post-exit grace window, and the row whose output the user is reading.
  const visibleTasks = selectVisibleTasks(visibility, tasks, clock, expandedId);

  useEffect(() => {
    const expiry = nextExpiryAt(visibility, tasks, clock, expandedId);
    if (expiry === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiry - clock));
    return () => clearTimeout(timer);
  }, [visibility, tasks, clock, expandedId]);

  const selectedState = tasks.find((task) => task.id === expandedId)?.state;
  useEffect(() => {
    setOutput(null);
    if (!expandedId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await api.backgroundTasksOutput(expandedId);
        if (disposed) return;
        setOutput(result);
        setError((current) => current === "output" ? null : current);
      } catch (failure) {
        if (disposed) return;
        console.error("Background task output failed", failure);
        setError("output");
      } finally {
        // Only the selected log crosses IPC, with at most one read in flight.
        if (!disposed && selectedState === "running") {
          timer = setTimeout(() => void refresh(), REFRESH_MS);
        }
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [expandedId, selectedState]);

  const toggleOutput = useCallback((id: string) => {
    setExpandedId((current) => current === id ? null : id);
    setError((current) => current === "output" ? null : current);
  }, []);

  const dismiss = useCallback((id: string) => {
    setVisibility((current) => dismissTask(current, id));
    setExpandedId((current) => current === id ? null : current);
  }, []);

  const stop = useCallback(async (id: string) => {
    if (pendingStops.current.has(id)) return;
    pendingStops.current.add(id);
    setStoppingIds(new Set(pendingStops.current));
    setError(null);
    try {
      await api.backgroundTasksStop(id);
      if (mounted.current) refreshList.current?.();
    } catch (failure) {
      if (mounted.current) {
        console.error("Background task stop failed", failure);
        setError("stop");
      }
    } finally {
      pendingStops.current.delete(id);
      if (mounted.current) setStoppingIds(new Set(pendingStops.current));
    }
  }, []);

  return {
    tasks: visibleTasks,
    expandedId,
    output,
    stoppingIds,
    error,
    toggleOutput,
    stop,
    dismiss,
  };
}
