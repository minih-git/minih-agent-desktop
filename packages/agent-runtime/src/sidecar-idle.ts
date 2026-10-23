/**
 * Idle-runtime reclaim policy.
 *
 * The sidecar keeps one live runtime per session because rebuilding it costs a
 * history read and a provider prompt-cache miss. Nothing used to take those
 * runtimes away again: a session left alone for hours kept its full history,
 * its attachments and its tool clients in memory for the life of the process.
 *
 * This module holds only the decision — which runtimes may be reclaimed now —
 * so it can be tested with a controlled clock. The sidecar owns the timer, the
 * activity bookkeeping, and the actual disposal.
 */

/** One runtime as the policy sees it. */
export type RuntimeActivity = {
  sessionId: string;
  /** Last prompt, steer or other turn activity, in epoch milliseconds. */
  lastActivity: number;
  /**
   * Something can still resume the runtime: a running turn, a pending
   * approval or input, an in-flight checkpoint, or a pending steer. A busy
   * runtime is never reclaimed, however old its last activity is.
   */
  busy: boolean;
};

export type ReclaimPolicy = {
  /** A runtime idle for this long is reclaimed. */
  idleMs: number;
  /** Upper bound on how many idle runtimes may stay resident. */
  maxIdle: number;
};

export const DEFAULT_RECLAIM_POLICY: ReclaimPolicy = {
  idleMs: 30 * 60 * 1000,
  maxIdle: 8,
};

/**
 * Session ids to reclaim now, oldest first.
 *
 * Two rules, applied in order:
 * 1. a not-busy runtime whose last activity is at least `idleMs` old goes;
 * 2. of the remaining idle runtimes, everything beyond `maxIdle` goes, least
 *    recently used first, so a burst of sessions cannot keep an unbounded
 *    number of idle runtimes alive.
 */
export function selectReclaimableRuntimes(
  runtimes: readonly RuntimeActivity[],
  now: number,
  policy: ReclaimPolicy = DEFAULT_RECLAIM_POLICY,
): string[] {
  if (policy.idleMs <= 0 && policy.maxIdle < 0) return [];
  const idle = runtimes.filter((runtime) => !runtime.busy);
  const expired = idle
    .filter((runtime) => policy.idleMs > 0 && now - runtime.lastActivity >= policy.idleMs)
    .sort((left, right) => left.lastActivity - right.lastActivity);
  const expiredIds = new Set(expired.map((runtime) => runtime.sessionId));
  const survivors = idle
    .filter((runtime) => !expiredIds.has(runtime.sessionId))
    .sort((left, right) => left.lastActivity - right.lastActivity);
  const overCap =
    policy.maxIdle >= 0 ? survivors.slice(0, Math.max(0, survivors.length - policy.maxIdle)) : [];
  return [...expired, ...overCap].map((runtime) => runtime.sessionId);
}

/** Read the policy from the environment, so a soak can shorten the window. */
export function reclaimPolicyFromEnv(env: NodeJS.ProcessEnv): ReclaimPolicy {
  // `Number("")` is 0, so an unset variable must be treated as absent rather
  // than as a request for a zero-length window or a zero idle cap.
  const idleSeconds = env.MINIH_AGENT_IDLE_RUNTIME_SECONDS
    ? Number(env.MINIH_AGENT_IDLE_RUNTIME_SECONDS)
    : Number.NaN;
  const maxIdle = env.MINIH_AGENT_MAX_IDLE_RUNTIMES
    ? Number(env.MINIH_AGENT_MAX_IDLE_RUNTIMES)
    : Number.NaN;
  return {
    idleMs:
      Number.isFinite(idleSeconds) && idleSeconds > 0
        ? idleSeconds * 1000
        : DEFAULT_RECLAIM_POLICY.idleMs,
    maxIdle:
      Number.isFinite(maxIdle) && maxIdle >= 0 ? maxIdle : DEFAULT_RECLAIM_POLICY.maxIdle,
  };
}