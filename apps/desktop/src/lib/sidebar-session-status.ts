export type SidebarSessionStatus =
  | "running"
  | "selected"
  | "completed"
  | "failed"
  | "permission";
export type SidebarSessionOutcome = Extract<
  SidebarSessionStatus,
  "completed" | "failed"
>;

export { latestSessionOutcomes } from "@minih-agent/shared";

export function sidebarSessionStatus({
  running,
  selected,
  outcome,
  hasPendingPermission,
  hasPendingAsk,
}: {
  running: boolean;
  selected: boolean;
  outcome?: "completed" | "failed";
  hasPendingPermission?: boolean;
  hasPendingAsk?: boolean;
}): SidebarSessionStatus | null {
  // A waiting turn is still `running` (the runtime pauses on the request), so
  // the decision state must outrank the in-progress dot: a pending tool
  // permission and a pending question card both wait for the user.
  if (hasPendingPermission || hasPendingAsk) return "permission";
  if (running) return "running";
  if (selected) return "selected";
  return outcome ?? null;
}

export type SidebarCollapsedProjectStatus = {
  kind: "permission" | "running";
  runningCount: number;
  permissionCount: number;
};

type PendingSessionEntries =
  | Record<string, readonly unknown[] | undefined>
  | readonly { sessionId: string }[];

function pendingSessionLookup(
  pending: PendingSessionEntries,
): (sessionId: string) => boolean {
  if (Array.isArray(pending)) {
    const set = new Set(pending.map((entry) => entry.sessionId));
    return (sessionId) => set.has(sessionId);
  }
  return (sessionId) =>
    (
      (pending as Record<string, readonly unknown[] | undefined>)[sessionId] ??
      []
    ).length > 0;
}

export function sidebarCollapsedProjectStatus({
  collapsed,
  sessions,
  runningSessions,
  pendingPermissions = {},
  pendingAsks = {},
}: {
  collapsed: boolean;
  sessions: readonly { id: string }[];
  runningSessions: Record<string, boolean | undefined>;
  pendingPermissions?: PendingSessionEntries;
  pendingAsks?: PendingSessionEntries;
}): SidebarCollapsedProjectStatus | null {
  if (!collapsed || sessions.length === 0) return null;

  const hasPendingPermission = pendingSessionLookup(pendingPermissions);
  const hasPendingAsk = pendingSessionLookup(pendingAsks);

  let runningCount = 0;
  let permissionCount = 0;

  for (const session of sessions) {
    const awaitsDecision =
      hasPendingPermission(session.id) || hasPendingAsk(session.id);
    const isRunning = Boolean(runningSessions[session.id]);
    if (awaitsDecision) {
      permissionCount += 1;
      runningCount += 1;
    } else if (isRunning) {
      runningCount += 1;
    }
  }

  if (permissionCount > 0) {
    return {
      kind: "permission",
      runningCount,
      permissionCount,
    };
  }

  if (runningCount > 0) {
    return {
      kind: "running",
      runningCount,
      permissionCount: 0,
    };
  }

  return null;
}

