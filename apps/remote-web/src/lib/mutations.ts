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
  RacpPermissionMode,
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
