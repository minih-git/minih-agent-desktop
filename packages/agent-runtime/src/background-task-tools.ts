import { Type } from "@earendil-works/pi-ai";

/**
 * The model-facing view of its own background Bash tasks.
 *
 * `Bash` with `runInBackground: true` returns only a `backgroundTaskId`: the
 * process belongs to the session, outlives the turn, and reports through the
 * composer's running-tasks bar. Without these three tools the model that
 * started a dev server could neither read its output nor stop it.
 *
 * All three are on-demand: they are not in the first request's schema, so a
 * session that never starts a background task does not pay for them. A
 * successful background `Bash` call activates them (see `runtime.ts`).
 * `BackgroundTaskList` and `BackgroundTaskOutput` are read-only;
 * `BackgroundTaskStop` stops a task this session owns. Host-core resolves every
 * id against the calling session, so another session's task answers exactly
 * like an unknown id.
 */

/** Longest single `waitSeconds` the host honours. */
export const BACKGROUND_TASK_MAX_WAIT_SECONDS = 60;

export const BACKGROUND_TASK_TOOL_NAMES = [
  "BackgroundTaskList",
  "BackgroundTaskOutput",
  "BackgroundTaskStop",
] as const;

const taskId = Type.String({
  minLength: 1,
  description:
    "The `backgroundTaskId` a `runInBackground` Bash call returned.",
});

export const backgroundTaskToolParameters: Record<
  string,
  Parameters<typeof Type.Object>[0]
> = {
  BackgroundTaskList: {},
  BackgroundTaskOutput: {
    id: taskId,
    waitSeconds: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: BACKGROUND_TASK_MAX_WAIT_SECONDS,
        description: `Optional wait, in seconds from 0 to ${BACKGROUND_TASK_MAX_WAIT_SECONDS}, for the task to finish. It returns as soon as the task ends; a timeout reports the state that is current now and is not a failure. The host caps the wait well below the tool budget.`,
      }),
    ),
  },
  BackgroundTaskStop: { id: taskId },
};

export const backgroundTaskToolDescriptions: Record<string, string> = {
  BackgroundTaskList:
    "List the background Bash tasks this session started: id, command, state, elapsedMs and exitCode. Use it after starting a `runInBackground` command to confirm it is running, or to recall an id you no longer have.",
  BackgroundTaskOutput:
    "Read a background Bash task this session started: its state, exitCode, and bounded stdout and stderr (the tail is kept and truncation is marked). Pass `waitSeconds` to wait for it to finish, for example right after starting a build; a timeout returns the current state, not an error. The task keeps running between calls.",
  BackgroundTaskStop:
    "Stop a background Bash task this session started. The whole process tree is terminated, and calling it again is harmless: `stopped` is false when there was nothing left to signal. The task's state becomes `stopped`.",
};
