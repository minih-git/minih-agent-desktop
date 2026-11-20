import {
  DEFAULT_PLUGIN_TASK_PERMISSION_MODE,
  PLUGIN_TASK_PERMISSION_MODES,
  type PluginTaskPermissionMode,
  type PluginTasksContrib,
} from "@minih-agent/plugin-sdk";

/**
 * `pi.tasks.*` — the plugin-facing half of the task surface (spec 07-plugins/03
 * §"tasks"). The host owns the roster, the ledger and the stage events; this
 * module owns only what the broker decides before the host is asked: which
 * permission a method needs, what its input may contain, and the manifest
 * ceiling a `create` runs under.
 *
 * It stays flat and runtime-free so the whole contract is testable without a
 * plugin process, and so `plugin-runtime.ts` grows by one delegate instead of a
 * third task-shaped switch.
 */

export type PluginTaskApiMethod = "roster" | "list" | "create" | "get" | "send" | "stop";

/**
 * Read methods answer over the person's own tasks; the manage methods reach only
 * the tasks this plugin created, which the host enforces with `pluginId`
 * (`NOT_FOUND`, never `PERMISSION_DENIED`, for anyone else's row).
 */
export const PLUGIN_TASK_API_PERMISSIONS: Record<
  PluginTaskApiMethod,
  "tasks.read" | "tasks.manage"
> = {
  roster: "tasks.read",
  list: "tasks.read",
  create: "tasks.manage",
  get: "tasks.manage",
  send: "tasks.manage",
  stop: "tasks.manage",
};

/** The host method the main process calls for each `pi.tasks.*` name. */
export const PLUGIN_TASK_API_METHODS: readonly PluginTaskApiMethod[] = [
  "roster",
  "list",
  "create",
  "get",
  "send",
  "stop",
];

/**
 * The calls the main process makes for `pi.tasks.*`.
 *
 * `call` answers with the host's own result for that method
 * (`pluginTasks.roster` → `{ employees }`, `list` → `{ tasks, nextCursor }`,
 * `create` → `{ task, session, notificationId, permissionMode }`, `get` →
 * `{ task }`, `send`/`stop` → `{ taskId, sessionId, employeeId }`); the broker
 * projects `create` down to the two ids a plugin may hold.
 *
 * `owner` is not a `pi.tasks.*` method: it is the host's ledger answer to
 * "which plugin created this task" (`pluginTasks.owner`), and it is how a stage
 * event finds its recipient. Routing must not be remembered in this process:
 * a map filled by `create` answers only for the tasks this run happened to
 * create, so every task that outlived a restart would go silent.
 */
export type PluginTaskService = {
  call: (
    pluginId: string,
    method: PluginTaskApiMethod,
    input: unknown,
    manifestMaxPermission: PluginTaskPermissionMode,
  ) => Promise<unknown>;
  owner?: (taskId: string) => Promise<string | null>;
};

export type PluginTasksHostService = {
  pluginTasks?: PluginTaskService;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_ID_CHARS = 256;
const MAX_CURSOR_CHARS = 512;
const MAX_TITLE_CHARS = 200;
/** Same budget as a Composer transform: one prompt, not a document dump. */
const MAX_PROMPT_CHARS = 100_000;

function taskError(
  code: "INVALID_ARGUMENT" | "PERMISSION_DENIED" | "INTERNAL",
  message: string,
): Error & {
  code: string;
} {
  return Object.assign(new Error(message), { code });
}

export function isPluginTaskApiMethod(value: string): value is PluginTaskApiMethod {
  return (PLUGIN_TASK_API_METHODS as readonly string[]).includes(value);
}

export function pluginTaskPermission(method: PluginTaskApiMethod): "tasks.read" | "tasks.manage" {
  return PLUGIN_TASK_API_PERMISSIONS[method];
}

/**
 * The ceiling the installed manifest declared. Omitted means `accept-edits`:
 * `auto` is never implied and has to be written down in
 * `manifest.tasks.manage.maxPermission`.
 *
 * A declared `auto` is a declared ceiling, not a working mode: an explicit
 * `auto` request is refused below, and the host caps every plugin task at
 * `accept-edits` until action-based approval exists.
 */
export function manifestTaskMaxPermission(
  tasks: PluginTasksContrib | undefined,
): PluginTaskPermissionMode {
  const declared = tasks?.manage?.maxPermission;
  return declared ?? DEFAULT_PLUGIN_TASK_PERMISSION_MODE;
}

function isPermissionMode(value: unknown): value is PluginTaskPermissionMode {
  return (PLUGIN_TASK_PERMISSION_MODES as readonly unknown[]).includes(value);
}

function asObject(input: unknown, method: PluginTaskApiMethod): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw taskError("INVALID_ARGUMENT", `tasks.${method} input must be an object`);
  }
  return input as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw taskError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw taskError("INVALID_ARGUMENT", `${field} must be at most ${maxChars} characters`);
  }
  return value;
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw taskError("INVALID_ARGUMENT", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CURSOR_CHARS) {
    throw taskError("INVALID_ARGUMENT", "cursor must be a non-empty string");
  }
  return value;
}

function optionalProjectId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw taskError("INVALID_ARGUMENT", "projectId must be a positive integer");
  }
  return value;
}

function taskIdOf(input: Record<string, unknown>): string {
  return requiredText(input.taskId, "taskId", MAX_ID_CHARS);
}

/** An employee id; the host answers `NOT_FOUND` for anything that is not one. */
function employeeIdOf(input: Record<string, unknown>): string {
  return requiredText(input.employeeId, "employeeId", MAX_ID_CHARS);
}

/**
 * The bounded payload for one call, plus the manifest ceiling the host
 * narrows against the employee's own mode.
 *
 * `create` names the employee the task is for — a plugin never gets to invent
 * "some employee", and the host answers `NOT_FOUND` for an id that is not one of
 * the person's. The id is passed through unchanged; the host resolves the
 * employee's own permission mode from it, which is the only ceiling a caller
 * cannot see.
 *
 * An explicit `auto` request is refused (`PERMISSION_DENIED`) whatever the
 * manifest declares: per-action approval is unavailable for plugin-created
 * tasks, so there is no mode that would remove the person's approval step. A
 * lower declared ceiling still narrows `accept-edits` — that direction is the
 * declaration doing its job.
 */
export function preparePluginTaskCall(
  method: PluginTaskApiMethod,
  tasks: PluginTasksContrib | undefined,
  rawInput: unknown,
): { input: Record<string, unknown>; maxPermission: PluginTaskPermissionMode } {
  const manifestMaxPermission = manifestTaskMaxPermission(tasks);
  const input = asObject(rawInput, method);

  switch (method) {
    case "roster": {
      // The host's roster read takes no parameters: it answers every employee
      // it holds, capped host-side. Passing a `limit` nobody honours would make
      // a plugin believe it had paged the roster.
      return { input: {}, maxPermission: manifestMaxPermission };
    }
    case "list": {
      const limit = optionalLimit(input.limit);
      const cursor = optionalCursor(input.cursor);
      return {
        input: { limit: limit ?? DEFAULT_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
        maxPermission: manifestMaxPermission,
      };
    }
    case "create": {
      const employeeId = employeeIdOf(input);
      const title = requiredText(input.title, "title", MAX_TITLE_CHARS);
      const prompt = requiredText(input.prompt, "prompt", MAX_PROMPT_CHARS);
      const projectId = optionalProjectId(input.projectId);
      const requested = input.maxPermission;
      if (requested !== undefined && requested !== null && !isPermissionMode(requested)) {
        throw taskError(
          "INVALID_ARGUMENT",
          `maxPermission must be one of ${PLUGIN_TASK_PERMISSION_MODES.join(", ")}`,
        );
      }
      if (requested === "auto") {
        throw taskError(
          "PERMISSION_DENIED",
          "tasks.create may not request auto: action approval is unavailable for plugin-created tasks",
        );
      }
      return {
        input: {
          employeeId,
          title,
          prompt,
          ...(projectId === undefined ? {} : { projectId }),
          ...(requested === undefined || requested === null ? {} : { maxPermission: requested }),
        },
        maxPermission: manifestMaxPermission,
      };
    }
    case "get":
    case "stop": {
      return { input: { taskId: taskIdOf(input) }, maxPermission: manifestMaxPermission };
    }
    case "send": {
      return {
        input: {
          taskId: taskIdOf(input),
          prompt: requiredText(input.prompt, "prompt", MAX_PROMPT_CHARS),
        },
        maxPermission: manifestMaxPermission,
      };
    }
    default: {
      // Exhaustive: a new method that forgets its bounds must fail loudly here
      // rather than reaching the host unchecked.
      throw taskError("INVALID_ARGUMENT", `unsupported tasks method: ${String(method)}`);
    }
  }
}

/** What a plugin is told about the task it just created. */
export type PluginTaskCreatedResult = {
  taskId: string;
  sessionId: string;
};

/**
 * The plugin-facing answer to `tasks.create`: the two ids, and nothing else.
 *
 * The host answers with the whole task row and its session summary, which carry
 * the person's own utterance, progress and workspace paths — fields the task
 * surface never shows a plugin (`plugin_tasks::list` redacts exactly those).
 * Projecting here keeps one redaction boundary instead of trusting every plugin
 * to ignore what it was handed.
 */
export function createdTaskResult(result: unknown): PluginTaskCreatedResult {
  const task = (result as { task?: { id?: unknown; sessionId?: unknown } } | null | undefined)?.task;
  const taskId = typeof task?.id === "string" ? task.id : undefined;
  const sessionId = typeof task?.sessionId === "string" ? task.sessionId : undefined;
  if (!taskId || !sessionId) {
    throw taskError("INTERNAL", "the host did not answer with a created task");
  }
  return { taskId, sessionId };
}