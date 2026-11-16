import { isTaskInterrupted, isTaskStuck } from "@minih-agent/shared";
import { useBots } from "./use-bots";
import { useTasks } from "./use-tasks";
import { TaskBlockedCard } from "./TaskBlockedCard";
import { TaskCompletionCard } from "./TaskCompletionCard";
import { showsCompletionCard } from "./task-delivery";

/**
 * The completion card of the task session the person is reading.
 *
 * It renders nothing unless the open conversation *is* a task at
 * `person/accept`, so the composer mounts it unconditionally next to the blocked
 * card: the two share one slot and are mutually exclusive by stage — a task that
 * stopped is a blocked card, a task that finished is this one.
 */
export function TaskCompletionCardForSession({ sessionId }: { sessionId: string }) {
  const { tasks, reload } = useTasks(null, { includeArchived: false });
  const { bots } = useBots();
  const task = tasks.find(
    (candidate) => candidate.sessionId === sessionId && showsCompletionCard(candidate),
  );
  if (!task) return null;
  const employee = bots.find((bot) => bot.sessionId === task.employeeSessionId);
  return (
    <TaskCompletionCard
      task={task}
      employeeName={employee?.profile?.name?.trim() || employee?.title}
      onChanged={() => void reload()}
    />
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
      onChanged={() => void reload()}
    />
  );
}
