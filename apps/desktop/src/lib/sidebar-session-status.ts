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
}: {
  running: boolean;
  selected: boolean;
  outcome?: "completed" | "failed";
  hasPendingPermission?: boolean;
}): SidebarSessionStatus | null {
  if (hasPendingPermission) return "permission";
  if (running) return "running";
  if (selected) return "selected";
  return outcome ?? null;
}

export type SidebarCollapsedProjectStatus = {
  kind: "permission" | "running";
  runningCount: number;
  permissionCount: number;
};

export function sidebarCollapsedProjectStatus({
  collapsed,
  sessions,
  runningSessions,
  pendingPermissions = {},
}: {
  collapsed: boolean;
  sessions: readonly { id: string }[];
  runningSessions: Record<string, boolean | undefined>;
  pendingPermissions?:
    | Record<string, readonly unknown[] | undefined>
    | readonly { sessionId: string }[];
}): SidebarCollapsedProjectStatus | null {
  if (!collapsed || sessions.length === 0) return null;

  const hasPendingForSession = Array.isArray(pendingPermissions)
    ? (() => {
        const set = new Set(
          pendingPermissions.map((permission) => permission.sessionId),
        );
        return (sessionId: string) => set.has(sessionId);
      })()
    : (sessionId: string) =>
        ((pendingPermissions as Record<string, readonly unknown[] | undefined>)[
          sessionId
        ]?.length ?? 0) > 0;

  let runningCount = 0;
  let permissionCount = 0;

  for (const session of sessions) {
    const hasPermission = hasPendingForSession(session.id);
    const isRunning = Boolean(runningSessions[session.id]);
    if (hasPermission) {
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

