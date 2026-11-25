import { useTranslation } from "react-i18next";
import type { TaskView } from "@minih-agent/shared";
import { useBots } from "./use-bots";
import { useTasks } from "./use-tasks";

/**
 * What a task session's composer has to say, if anything (ADR
 * bot-sessions-and-steward §7).
 *
 * The composer is a hotspot (AGENTS.md §7), so the two facts a task session
 * adds to it — the words in the empty field, and whether the input is closed
 * because the task is finished — are decided here. Composer keeps one call and
 * one fallback; everything that has to be read to answer is read in this file.
 *
 * A non-task session costs one render and no request: the read is skipped
 * outright rather than filtered afterwards.
 */
export type TaskComposerState = {
  /** The placeholder a task session shows, or undefined for a conversation. */
  placeholder?: string;
  /** Finished work accepts no further messages. */
  archived: boolean;
};

export function useTaskComposer(
  session: { id?: string; role?: string } | null | undefined,
): TaskComposerState {
  const { t } = useTranslation();
  const isTask = session?.role === "task";
  // Every task of every employee: one read answers "which task is this session
  // and is it finished", which is all the composer asks.
  const state = useTasks(null, { includeArchived: true });
  const bots = useBots();
  const task: TaskView | undefined = isTask
    ? state.tasks.find((row) => row.sessionId === session?.id)
    : undefined;
  if (!task) return { archived: false };
  if (task.archivedAt) {
    return { placeholder: t("bots.tasks.archivedPlaceholder"), archived: true };
  }
  const employee = bots.bots.find((bot) => bot.sessionId === task.employeeSessionId);
  return {
    placeholder: t("bots.tasks.composerPlaceholder", {
      name: employee?.profile.name ?? t("bots.group.title"),
      agent: employee?.profile.name ?? t("bots.group.title"),
    }),
    archived: false,
  };
}