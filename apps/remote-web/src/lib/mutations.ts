/**
 * RACP command builders (PR-4).
 *
 * Every call returns a typed result instead of throwing, so a screen can name
 * the failed operation and its reason. The idempotency key is created by the
 * caller once per user action and passed in, which is what makes a retry safe:
 * the same key reaches the Host, which answers with the recorded outcome
 * instead of starting a second turn.
 *
 * Where the key may travel (checked against `packages/racp/src/operations.ts`
 * and the Gateway's `CommandRouter.idempotencyKeyFor`):
 *   - `turn/start`        → the command body (`params.idempotencyKey`),
 *                           the only operation the Gateway forwards a key for;
 *   - `approval/respond`  → `context.idempotencyKey` (the operation schema
 *                           accepts a request context; a body-level key is
 *                           refused by the Gateway);
 *   - `input/respond`     → `context.idempotencyKey`, same reason;
 *   - `turn/stop` / `turn/interrupt` / `turn/cancel` → no key at all: their
 *                           params schema is `{ turnId }` only, so a retry is
 *                           a fresh stop, which is naturally idempotent on the
 *                           Host.
 */
import type {
  RacpApprovalDecision,
  RacpApprovalResult,
  RacpCursor,
  RacpItemSummary,
  RacpModelSummary,
  RacpPermissionMode,
  RacpProjectSummary,
  RacpSession,
  RacpSessionSnapshot,
  RacpTurn,
  RacpTurnAdmission,
} from "@minih-agent/shared";

import { failureFrom, type OperationFailure } from "./errors.js";

export type CommandClient = {
  request<T = unknown>(method: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T>;
};

export type MutationResult<T> = { ok: true; value: T } | { ok: false; failure: OperationFailure };

export type SessionAttachResult = {
  session: RacpSession;
  role?: string;
  replayComplete?: boolean;
  resyncReason?: string;
  snapshot?: RacpSessionSnapshot;
};

export type TurnStartResult = {
  accepted?: boolean;
  turn: RacpTurn;
  cursor?: RacpCursor;
};

async function run<T>(call: () => Promise<T>): Promise<MutationResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, failure: failureFrom(error) };
  }
}

export function listSessions(client: CommandClient): Promise<MutationResult<RacpSession[]>> {
  return run(async () => {
    const result = await client.request<{ sessions?: RacpSession[] }>("session/list", {});
    return result.sessions ?? [];
  });
}

/** One directory the Host offered in its folder picker. */
export type BrowseEntry = { name: string; path: string };

export type ProjectBrowseResult = {
  /** The directory that was listed, in the Host's canonical spelling. */
  path: string;
  /** The parent directory, absent when `path` is the Host's browse root. */
  parent?: string;
  entries: BrowseEntry[];
};

/**
 * Walk the Host's directories (controller role, rollout A2).
 *
 * Omitting `path` asks for the Host's browse root — the user's home directory —
 * which is also the boundary the Host enforces: a path outside it is refused
 * with `REMOTE_PATH_FORBIDDEN`.
 */
export function browseProjects(
  client: CommandClient,
  path?: string,
): Promise<MutationResult<ProjectBrowseResult>> {
  return run(async () => {
    const result = await client.request<ProjectBrowseResult>("project/browse", {
      ...(path ? { path } : {}),
    });
    return {
      path: result.path,
      ...(result.parent ? { parent: result.parent } : {}),
      entries: result.entries ?? [],
    };
  });
}

/**
 * Register one of the Host's directories as a project (controller role,
 * rollout A2). The Host canonicalizes the path again and refuses anything
 * outside its browse root, so the picker is a convenience, not the boundary.
 */
export function registerProject(
  client: CommandClient,
  path: string,
): Promise<MutationResult<RacpProjectSummary & { path: string }>> {
  return run(async () => {
    const result = await client.request<{ project?: RacpProjectSummary & { path?: string } }>(
      "project/register",
      { path },
    );
    if (!result.project) throw new Error("the host registered no project");
    return { ...result.project, path: result.project.path ?? path };
  });
}

/**
 * The projects this device may create sessions under (viewer role).
 *
 * `project/list` exists exactly so `session/create` never needs a path
 * (protocol §7.7), which is also why the phone shows the catalog instead of a
 * folder picker.
 */
export function listProjects(client: CommandClient): Promise<MutationResult<RacpProjectSummary[]>> {
  return run(async () => {
    const result = await client.request<{ projects?: RacpProjectSummary[] }>("project/list", {});
    return result.projects ?? [];
  });
}

/**
 * The models this Host offers (R7, protocol §16.1).
 *
 * A Host too old to implement `model/list` answers `CAPABILITY_UNAVAILABLE`;
 * the caller then creates the session without a model, which is exactly what the
 * Host's own default would have done.
 */
export function listModels(client: CommandClient): Promise<MutationResult<RacpModelSummary[]>> {
  return run(async () => {
    const result = await client.request<{ models?: RacpModelSummary[] }>("model/list", {});
    return result.models ?? [];
  });
}

export type SessionCreateInput = {
  /** Required: a session belongs to one of the projects `project/list` named. */
  projectId: string;
  title?: string;
  /** R7: the model the user chose. Absent means the Host's own default. */
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  mode?: "agent" | "plan" | "goal";
  permissionMode?: "ask" | "accept-edits" | "auto";
};

/**
 * Create a session under one authorized project (controller role).
 *
 * The body is the Host's own contract (`SessionCreateParams` in
 * `packages/racp/src/operations.ts`): only `projectId` and an optional `title`
 * are sent, so nothing is invented here. The Host applies its own defaults for
 * mode, permission mode, and model.
 */
export function createSession(
  client: CommandClient,
  input: SessionCreateInput,
): Promise<MutationResult<RacpSession>> {
  return run(async () => {
    // A whitespace-only title is the same as none: the Host would otherwise
    // store a blank name that no sidebar can show.
    const title = input.title?.trim();
    const result = await client.request<{ session?: RacpSession }>("session/create", {
      projectId: input.projectId,
      ...(title ? { title } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    });
    if (!result.session) throw new Error("the host created no session");
    return result.session;
  });
}

/**
 * How the "new session" entry point behaves for this device.
 *
 * - `hidden`: the Gateway recorded roles and `controller` is not one of them, so
 *   the device may only read; the screen explains that instead of offering an
 *   action that would be refused.
 * - `direct`: exactly one project is available, so the choice is not worth a
 *   dialog.
 * - `choose`: several projects; the screen asks which one.
 * - `unavailable`: no project the device may create a session under.
 * - `unknown`: no roles were recorded (an entry from an earlier build) or the
 *   catalog has not loaded yet, so nothing is decided and the action is offered.
 */
export type NewSessionMode = "hidden" | "direct" | "choose" | "unavailable" | "unknown";

export function newSessionMode(
  roles: readonly string[] | undefined,
  projects: readonly RacpProjectSummary[] | null,
): NewSessionMode {
  if (roles && !roles.includes("controller")) return "hidden";
  if (projects === null || !roles) return "unknown";
  const usable = projects.filter((project) => !project.archived);
  if (usable.length === 0) return "unavailable";
  return usable.length === 1 ? "direct" : "choose";
}

export type HistoryPage = {
  items: RacpItemSummary[];
  /** Whether the Host holds anything older than this page. */
  hasMore: boolean;
};

/**
 * One page of older transcript rows (viewer role, protocol §5.4: "older pages
 * come from `session/history`").
 *
 * The snapshot carries only the newest page, so a long conversation opens with
 * the last 50 rows — which, in a session full of tool calls, may not include a
 * single thing the user typed. `beforeItemId` walks backwards from the oldest
 * row the client holds; `limit` is clamped by the Host to 1–200.
 */
export function listHistory(
  client: CommandClient,
  sessionId: string,
  options: { beforeItemId?: string; limit?: number } = {},
): Promise<MutationResult<HistoryPage>> {
  return run(async () => {
    const result = await client.request<{ items?: RacpItemSummary[]; hasMore?: boolean }>("session/history", {
      sessionId,
      ...(options.beforeItemId ? { beforeItemId: options.beforeItemId } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    });
    return { items: result.items ?? [], hasMore: result.hasMore === true };
  });
}

export function attachSession(client: CommandClient, sessionId: string): Promise<MutationResult<SessionAttachResult>> {
  return run(() => client.request<SessionAttachResult>("session/attach", { sessionId, includeSnapshot: true }));
}

export type TurnStartInput = {
  sessionId: string;
  text: string;
  admission: RacpTurnAdmission;
  idempotencyKey: string;
  requestId: string;
};

export function startTurn(client: CommandClient, input: TurnStartInput): Promise<MutationResult<TurnStartResult>> {
  return run(() =>
    client.request<TurnStartResult>(
      "turn/start",
      {
        sessionId: input.sessionId,
        admission: input.admission,
        input: { text: input.text },
        context: { requestId: input.requestId },
      },
      input.idempotencyKey,
    ),
  );
}

export type ApprovalResponseInput = {
  approvalId: string;
  decision: RacpApprovalDecision;
  permissionMode?: RacpPermissionMode;
  idempotencyKey: string;
  requestId: string;
};

export function respondApproval(
  client: CommandClient,
  input: ApprovalResponseInput,
): Promise<MutationResult<RacpApprovalResult>> {
  return run(() =>
    client.request<RacpApprovalResult>("approval/respond", {
      approvalId: input.approvalId,
      decision: input.decision,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      context: { requestId: input.requestId, idempotencyKey: input.idempotencyKey },
    }),
  );
}

export type InputResponseInput = {
  inputId: string;
  /** One entry per question: the chosen labels, or `null` to skip it. */
  answers: Array<string[] | null>;
  idempotencyKey: string;
  requestId: string;
};

export function respondInput(
  client: CommandClient,
  input: InputResponseInput,
): Promise<MutationResult<{ inputId: string; status: string }>> {
  return run(() =>
    client.request<{ inputId: string; status: string }>("input/respond", {
      inputId: input.inputId,
      answers: input.answers,
      context: { requestId: input.requestId, idempotencyKey: input.idempotencyKey },
    }),
  );
}

export function stopTurn(client: CommandClient, turnId: string): Promise<MutationResult<RacpTurn>> {
  return run(async () => (await client.request<{ turn: RacpTurn }>("turn/stop", { turnId })).turn);
}

export function interruptTurn(client: CommandClient, turnId: string): Promise<MutationResult<RacpTurn>> {
  return run(async () => (await client.request<{ turn: RacpTurn }>("turn/interrupt", { turnId })).turn);
}

/**
 * Change what a session runs on (controller role, R7).
 *
 * The Host refuses this under a running turn (`AGENT_BUSY`), which is why the
 * screen asks `modelSwitchBlockedReason` first and shows the reason rather than
 * a control that would be rejected.
 */
export function configureSession(
  client: CommandClient,
  input: {
    sessionId: string;
    providerId?: string;
    modelId?: string;
    thinkingLevel?: string;
    mode?: "agent" | "plan" | "goal";
    permissionMode?: "ask" | "accept-edits" | "auto";
  },
): Promise<MutationResult<RacpSession>> {
  return run(async () => {
    const { sessionId, ...rest } = input;
    const result = await client.request<{ session?: RacpSession }>("session/configure", {
      sessionId,
      ...rest,
    });
    if (!result.session) throw new Error("the host returned no session");
    return result.session;
  });
}

/** Rename a session (controller role). */
export function renameSession(
  client: CommandClient,
  sessionId: string,
  title: string,
): Promise<MutationResult<string>> {
  return run(async () => {
    await client.request("session/rename", { sessionId, title: title.trim() });
    return title.trim();
  });
}
