import type { SessionSummary } from "@minih-agent/shared";
import { isRemoteSession } from "./remote-session-safety.ts";
import { isAutomationSession } from "./session-origin.ts";
import type { ProjectMeta, SessionMeta } from "./sidebar-preferences";

export function normalizeProjectPath(projectPath?: string | null): string | null {
  const value = projectPath?.trim();
  if (!value) return null;

  let normalized = value.replace(/\\/g, "/");
  // Strip the Windows extended-length prefix (`//?/C:/...` → `C:/...`)
  if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(4);
  }
  // Remove trailing slashes but keep the one after a drive letter (e.g. `C:/`)
  normalized = normalized.replace(/(?<![A-Za-z]:)\/+$/, "");
  return normalized || "/";
}

export function sessionMatchesProject(
  session: Pick<SessionSummary, "projectPath"> & Partial<Pick<SessionSummary, "source" | "id">>,
  projectPath?: string | null,
): boolean {
  if (session.source === "remote" || session.id?.startsWith("remote:")) return false;
  return normalizeProjectPath(session.projectPath) === normalizeProjectPath(projectPath);
}

/** Return normalized project paths belonging to sessions added by a refresh. */
export function projectPathsForNewSessions(
  previousSessions: readonly Pick<SessionSummary, "id">[],
  nextSessions: readonly (Pick<SessionSummary, "id" | "projectPath"> & Partial<Pick<SessionSummary, "source">>)[],
): string[] {
  const previousIds = new Set(previousSessions.map((session) => session.id));
  const paths = new Set<string>();
  for (const session of nextSessions) {
    if (isRemoteSession(session)) continue;
    if (previousIds.has(session.id)) continue;
    const path = normalizeProjectPath(session.projectPath);
    if (path) paths.add(path);
  }
  return [...paths];
}

export function groupSidebarSessions(
  sessions: SessionSummary[],
  projectPath?: string | null,
): {
  projectSessions: SessionSummary[];
  temporarySessions: SessionSummary[];
} {
  const normalizedProjectPath = normalizeProjectPath(projectPath);

  return {
    projectSessions: normalizedProjectPath
      ? sessions.filter(
          (session) => normalizeProjectPath(session.projectPath) === normalizedProjectPath,
        )
      : [],
    temporarySessions: sessions.filter(
      (session) => normalizeProjectPath(session.projectPath) === null,
    ),
  };
}

export function sessionArchived(session: SessionSummary, meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.archived || (session as SessionSummary & { archived?: boolean }).archived);
}

export function sessionPinned(session: SessionSummary, meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.pinned || (session as SessionSummary & { pinned?: boolean }).pinned);
}

/** Pins are global shortcuts; project retention and dates do not limit discovery. */
export function getGlobalPinnedSessions(
  sessions: SessionSummary[],
  sessionMeta: Record<string, SessionMeta>,
  projectMeta: Record<string, ProjectMeta>,
  showArchived: boolean,
): SessionSummary[] {
  return sessions.filter((session) => {
    if (!sessionPinned(session, sessionMeta[session.id])) return false;
    const path = normalizeProjectPath(session.projectPath);
    const project = path ? (projectMeta[path] ?? projectMeta[session.projectPath!]) : undefined;
    return (
      showArchived || (!sessionArchived(session, sessionMeta[session.id]) && !project?.archived)
    );
  });
}

export type TimeGroup = "today" | "yesterday" | "thisWeek" | "older14d" | "archived";

function getTimeGroup(dateStr: string | undefined, now: Date): TimeGroup {
  if (!dateStr) return "older14d";
  const ts = Date.parse(dateStr);
  if (!Number.isFinite(ts)) return "older14d";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000; // last 7 days
  const startOf14d = startOfToday - 13 * 86400000;
  if (ts >= startOfToday) return "today";
  if (ts >= startOfYesterday) return "yesterday";
  if (ts >= startOfWeek) return "thisWeek";
  if (ts >= startOf14d) return "older14d";
  return "archived"; // older than 14 days
}

const TIME_GROUP_ORDER: TimeGroup[] = ["today", "yesterday", "thisWeek", "older14d", "archived"];
/** Group only normal history; callers remove global pins before any row limit. */
export function groupSidebarSessionsByTime(sessions: SessionSummary[], now = new Date()) {
  const grouped = new Map<TimeGroup, SessionSummary[]>();
  for (const session of sessions) {
    const group = getTimeGroup(session.updatedAt, now);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(session);
  }
  return TIME_GROUP_ORDER.flatMap((group) => {
    const rows = grouped.get(group);
    return rows?.length ? [{ group, sessions: rows }] : [];
  });
}

const MAX_ACTIVITY_PREVIEW_CHARS = 160;

export function normalizeMessagePreview(
  raw?: string | null,
  maxChars = MAX_ACTIVITY_PREVIEW_CHARS,
): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return `${chars.slice(0, maxChars).join("").trimEnd()}…`;
}

export function latestTranscriptMessagePreview(
  messages?: readonly { role?: string; content?: string | null }[] | null,
): string | null {
  if (!messages?.length) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message.role !== "assistant" && message.role !== "user")) continue;
    const preview = normalizeMessagePreview(message.content);
    if (preview) return preview;
  }
  return null;
}

export function resolveSessionActivityPreview({
  session,
  activeSessionId,
  activeMessages,
  retainedTranscripts,
}: {
  session: { id: string; lastMessagePreview?: string | null };
  activeSessionId?: string | null;
  activeMessages?: readonly { role?: string; content?: string | null }[] | null;
  retainedTranscripts?: Record<
    string,
    readonly { role?: string; content?: string | null }[] | undefined
  >;
}): string | null {
  if (activeSessionId === session.id) {
    const livePreview = latestTranscriptMessagePreview(activeMessages);
    if (livePreview) return livePreview;
  }
  const retainedPreview = latestTranscriptMessagePreview(
    retainedTranscripts?.[session.id],
  );
  if (retainedPreview) return retainedPreview;
  return normalizeMessagePreview(session.lastMessagePreview);
}

function optionalSessionTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Return all visible sessions across all projects and temporary chats ordered
 * by latest activity (`updatedAt` descending) for the sidebar Activity panel.
 *
 * A scheduled run owns its transcript, so the Scheduled page is its entry point
 * and every other list keeps it out (issue #1291). This feed is the one
 * exception, and only while the run is still executing: live work belongs in
 * the stream, a settled run does not.
 */
export function getSidebarActivitySessions({
  sessions,
  sessionMeta,
  projectMeta,
  showArchived,
  runningSessionIds,
}: {
  sessions: readonly SessionSummary[];
  sessionMeta: Record<string, SessionMeta>;
  projectMeta: Record<string, ProjectMeta>;
  showArchived: boolean;
  /** Sessions executing a turn right now, as the renderer knows them. */
  runningSessionIds: ReadonlySet<string>;
}): SessionSummary[] {
  return sessions
    .filter((session) => {
      if (isAutomationSession(session) && !runningSessionIds.has(session.id)) return false;
      const path = normalizeProjectPath(session.projectPath);
      const project = path ? (projectMeta[path] ?? projectMeta[session.projectPath!]) : undefined;
      return (
        showArchived || (!sessionArchived(session, sessionMeta[session.id]) && !project?.archived)
      );
    })
    .sort((left, right) => {
      const leftUpdated = optionalSessionTimestamp(left.updatedAt);
      const rightUpdated = optionalSessionTimestamp(right.updatedAt);
      if (leftUpdated !== rightUpdated) {
        if (leftUpdated === null) return 1;
        if (rightUpdated === null) return -1;
        return rightUpdated - leftUpdated;
      }
      const leftCreated = optionalSessionTimestamp(left.createdAt);
      const rightCreated = optionalSessionTimestamp(right.createdAt);
      if (leftCreated !== rightCreated) {
        if (leftCreated === null) return 1;
        if (rightCreated === null) return -1;
        return rightCreated - leftCreated;
      }
      return left.id.localeCompare(right.id);
    });
}

