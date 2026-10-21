import type { StreamState } from "./stream-supervisor.js";
import type { StatusType } from "../components/ui/StatusDot.js";

export function formatRelativeTime(
  timestamp: number | string | Date,
  nowTimestamp: number = Date.now(),
): string {
  const date = typeof timestamp === "number" || typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const time = date.getTime();
  if (isNaN(time)) return "";

  const diffMs = nowTimestamp - time;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) {
    return "justNow";
  }
  if (diffMin < 60) {
    return `${diffMin}m`;
  }
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  if (diffDays === 1) {
    return "yesterday";
  }
  if (diffDays < 7) {
    return `${diffDays}d`;
  }
  return date.toLocaleDateString();
}


/**
 * The relative time a row shows, with the two words `formatRelativeTime` returns
 * as keys translated by the caller. Two screens show this line (§17.2's project
 * card and §17.4's session row), so it lives here rather than in both.
 */
export function relativeTimeText(
  timestamp: number | string | Date,
  labels: { justNow: string; yesterday: string },
  nowTimestamp: number = Date.now(),
): string {
  const raw = formatRelativeTime(timestamp, nowTimestamp);
  if (raw === "justNow") return labels.justNow;
  if (raw === "yesterday") return labels.yesterday;
  return raw;
}
export type SessionDateGroup<T> = {
  key: "today" | "yesterday" | "pastWeek" | "earlier";
  labelKey: string;
  items: T[];
};

export function groupSessionsByDate<T extends { updatedAt: string | number }>(
  sessions: T[],
  nowTimestamp: number = Date.now(),
): Array<SessionDateGroup<T>> {
  const groups: Record<"today" | "yesterday" | "pastWeek" | "earlier", T[]> = {
    today: [],
    yesterday: [],
    pastWeek: [],
    earlier: [],
  };

  const nowDate = new Date(nowTimestamp);
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfPastWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;

  for (const session of sessions) {
    const t = new Date(session.updatedAt).getTime();
    if (isNaN(t)) {
      groups.earlier.push(session);
      continue;
    }
    if (t >= startOfToday) {
      groups.today.push(session);
    } else if (t >= startOfYesterday) {
      groups.yesterday.push(session);
    } else if (t >= startOfPastWeek) {
      groups.pastWeek.push(session);
    } else {
      groups.earlier.push(session);
    }
  }

  const result: Array<SessionDateGroup<T>> = [];
  if (groups.today.length > 0) {
    result.push({ key: "today", labelKey: "sessions.group.today", items: groups.today });
  }
  if (groups.yesterday.length > 0) {
    result.push({ key: "yesterday", labelKey: "sessions.group.yesterday", items: groups.yesterday });
  }
  if (groups.pastWeek.length > 0) {
    result.push({ key: "pastWeek", labelKey: "sessions.group.pastWeek", items: groups.pastWeek });
  }
  if (groups.earlier.length > 0) {
    result.push({ key: "earlier", labelKey: "sessions.group.earlier", items: groups.earlier });
  }

  return result;
}

export function formatCountdown(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return "0:00";
  const m = Math.floor(secondsRemaining / 60);
  const s = Math.floor(secondsRemaining % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export interface ConnectionBannerInfo {
  type: "none" | "retrying" | "exhausted" | "failure";
  tone?: "running" | "error" | "warn";
  messageKey?: string;
  message?: string;
}

export function resolveConnectionBanner(
  streamState: StreamState,
  failure?: { failure: { message?: string }; operationKey: string } | null,
): ConnectionBannerInfo {
  if (failure) {
    return {
      type: "failure",
      tone: "error",
      message: failure.failure.message || "Operation failed",
    };
  }
  if (streamState === "exhausted") {
    return {
      type: "exhausted",
      tone: "error",
      messageKey: "session.exhausted",
    };
  }
  if (streamState === "retrying") {
    return {
      type: "retrying",
      tone: "running",
      messageKey: "session.retrying",
    };
  }
  if (streamState === "paused") {
    return {
      type: "retrying",
      tone: "warn",
      messageKey: "session.paused",
    };
  }
  return { type: "none" };
}

export interface TurnStatusDisplay {
  statusType: StatusType;
  labelKey: string;
  isStopping?: boolean;
}

export function resolveTurnStatusDisplay(
  turnStatus?: string,
  stopping: boolean = false,
  decisionKind?: "approval" | "input",
): TurnStatusDisplay | null {
  if (stopping) {
    return {
      statusType: "running",
      labelKey: "session.stopping",
      isStopping: true,
    };
  }
  if (decisionKind === "approval") {
    return {
      statusType: "decision",
      labelKey: "session.waitingApproval",
    };
  }
  if (decisionKind === "input") {
    return {
      statusType: "decision",
      labelKey: "session.waitingInput",
    };
  }
  if (turnStatus === "running") {
    return {
      statusType: "running",
      labelKey: "session.turn.running",
    };
  }
  if (turnStatus === "interrupted") {
    return {
      statusType: "error",
      labelKey: "session.turn.interrupted",
    };
  }
  if (turnStatus === "stopped") {
    return {
      statusType: "muted",
      labelKey: "session.turn.stopped",
    };
  }
  if (turnStatus === "completed") {
    return {
      statusType: "done",
      labelKey: "session.turn.completed",
    };
  }
  return null;
}
