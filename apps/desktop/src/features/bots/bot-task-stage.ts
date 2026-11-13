import type { TaskStage } from "@minih-agent/shared";

/**
 * The word a **task's stage** has, as distinct from the employee's own status.
 *
 * The two vocabularies both start from a stage, and that is exactly why they
 * must not share a catalog: `bots.status.*` answers "is this employee busy or
 * waiting on me", in words about the *employee* ("忙", "等你处理"), while a task
 * row has to say where the *task* is ("进行中", "待验收"). Reusing the employee
 * words made a finished task read "等你处理" and a working one read "忙".
 *
 * The map is keyed by the stage union, so a new stage cannot ship without its
 * own word: adding one to `TaskStage` fails the typecheck here until this table
 * and its `bots.taskStage.*` keys exist. Employee status stays in
 * `bot-status.ts` and is untouched by this module.
 */
const TASK_STAGE_KEYS: Record<TaskStage, string> = {
  queued: "bots.taskStage.queued",
  working: "bots.taskStage.working",
  waiting: "bots.taskStage.waiting",
  blocked: "bots.taskStage.blocked",
  failed: "bots.taskStage.failed",
  "person/answer": "bots.taskStage.personAnswer",
  "person/accept": "bots.taskStage.personAccept",
};

/** The i18n key for a task stage, e.g. `bots.taskStage.personAccept`. */
export function taskStageLabelKey(stage: TaskStage): string {
  // A stage the host reports but this build does not know yet still needs a
  // word; "queued" is the truth for "nothing has happened yet".
  return TASK_STAGE_KEYS[stage] ?? "bots.taskStage.queued";
}