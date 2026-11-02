/**
 * Electron-main side of session cache keep-warm (ADR 0339).
 *
 * Main owns exactly three things and delegates the rest:
 *
 * 1. it resolves the launch a real turn would use, so the sidecar assembles the
 *    same provider, model, thinking level and instruction chain;
 * 2. it asks the sidecar — the only place that knows what the last request sent
 *    — whether the session may be warmed, and forwards that answer untouched;
 * 3. it writes the outcome to the host's own ledger, because a keep-warm request
 *    belongs to no turn and therefore has nowhere in the turn ledger to live.
 *
 * The verdict is never re-decided here. A plugin gets `session_busy`,
 * `prefix_changed` or `context_too_small` from the process that knows, which is
 * what keeps the plugin's schedule honest: it can stop on a reason, not guess
 * at one.
 */

import type {
  KeepWarmResult,
  KeepWarmUsage,
} from "@minih-agent/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { RuntimeState } from "./context";

export type SessionKeepWarmDependencies = {
  runtimeState: RuntimeState;
  getHost: () => HostProcess | null;
  resolveAgentRuntimeLaunch: (
    sessionId: string,
    session: Record<string, unknown>,
    settings: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ) => Promise<{ sidecarParams: Record<string, unknown> }>;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

export type KeepWarmSession = (sessionId: string) => Promise<KeepWarmResult>;

export function createSessionKeepWarm(deps: SessionKeepWarmDependencies): KeepWarmSession {
  return async function keepWarmSession(sessionId: string): Promise<KeepWarmResult> {
    const host = deps.getHost();
    const sidecar: AgentSidecar | null = deps.runtimeState.sidecar;
    if (!host || !sidecar) return { status: "skipped", reason: "runtime_unavailable" };
    let result: KeepWarmResult;
    try {
      const detail = await host.call<{ session?: Record<string, unknown> | null }>("session.get", {
        id: sessionId,
        messageLimit: 1,
      });
      const session = detail?.session;
      if (!session) return { status: "skipped", reason: "runtime_unavailable" };
      const settings = await host.call<Record<string, unknown>>("settings.get");
      const launch = await deps.resolveAgentRuntimeLaunch(sessionId, session, settings ?? {});
      result = await sidecar.call<KeepWarmResult>("agent.keepWarm", {
        ...launch.sidecarParams,
        sessionId,
      });
    } catch (error) {
      // A sidecar that is restarting, a model row that was just deleted, a
      // session that no longer exists: none of these are a reason to keep a
      // plugin's schedule running against a session that cannot be warmed.
      deps.log("warn", "keep-warm request could not be dispatched", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: "skipped", reason: "runtime_unavailable" };
    }
    await recordKeepWarmOutcome(host, sessionId, result, deps);
    return result;
  };
}

/**
 * Write one attempt to the host ledger.
 *
 * A skipped attempt is stored too, with no cost: the plugin shows the reason,
 * and a user who wonders why nothing happened an hour ago finds the answer in
 * the same place the spend is. A failure to record is logged and never turns a
 * successful warm into an error the user sees.
 */
async function recordKeepWarmOutcome(
  host: HostProcess,
  sessionId: string,
  result: KeepWarmResult,
  deps: SessionKeepWarmDependencies,
): Promise<void> {
  const usage: KeepWarmUsage | undefined = result.status === "warmed" ? result.usage : undefined;
  const payload = {
    sessionId,
    status: result.status,
    ...(result.status === "skipped" ? { reason: result.reason } : {}),
    ...(result.status === "failed" ? { reason: result.reason } : {}),
    ...(usage
      ? {
          providerId: usage.providerId,
          modelId: usage.modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadRatio: result.status === "warmed" ? result.cacheReadRatio : undefined,
          costUsd: usage.costUsd,
          durationMs: usage.durationMs,
        }
      : {}),
  };
  try {
    await host.call("session.keepWarm.record", payload);
  } catch (error) {
    deps.log("warn", "keep-warm usage could not be recorded", {
      sessionId,
      status: result.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
