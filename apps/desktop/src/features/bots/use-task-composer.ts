import { useTranslation } from "react-i18next";
import type { TaskView } from "@minih-agent/shared";
import { useAppStore } from "../../stores/app-store";
import { useBots } from "./use-bots";
import { useTasks } from "./use-tasks";
import { isStewardSession } from "./bot-status";

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
    }),
    archived: false,
  };
}

/**
 * What clicking an employee, or one of its tasks, does.
 *
 * The sidebar is a hotspot too, so the two decisions live here: the steward is a
 * conversation (it proposes cards and reports in chat, so it opens as one),
 * every other employee opens its workbench, and a task opens its own session.
 * `reportError` is the sidebar's own toast, passed in so this module does not
 * invent a second way to report one.
 */
export function useBotSidebarHandlers(
  reportError: (error: unknown) => void,
): {
  onOpenBot: (bot: { sessionId: string; profile?: { definition?: string } }) => void;
  onOpenTask: (task: TaskView) => void;
} {
  const selectSession = useAppStore((state) => state.selectSession);
  const setWorkbenchEmployee = useAppStore((state) => state.setWorkbenchEmployee);
  return {
    onOpenBot: (bot) => {
      if (isStewardSession({ role: "bot", botProfile: bot.profile })) {
        void selectSession(bot.sessionId).catch(reportError);
        return;
      }
      setWorkbenchEmployee(bot.sessionId);
    },
    onOpenTask: (task) => {
      void selectSession(task.sessionId).catch(reportError);
    },
  };
}