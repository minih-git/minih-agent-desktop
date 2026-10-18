import type { UiMessage } from "@minih-agent/shared";
import type { AssistantActivityItem } from "./assistant-turns";
import { delegationIdForMessage } from "./subagent-panel";
import {
  collectDelegationStatuses,
  delegationRoster,
  type SubagentOutcome,
} from "./subagent-topology";
import { isDelegationStartTool } from "./tool-display";
import { toolResultPayload } from "./tool-presentation";

/** One row of the session's subagent roster. */
export type SessionSubagentEntry = {
  delegationId: string;
  agentName: string;
  /** Recognizable brief, falling back to the agent name. */
  title: string;
  status: SubagentOutcome;
  /** Wall-clock milliseconds, only when the runtime reported both ends. */
  durationMs?: number;
  /** Earliest known start, used for newest-first ordering. */
  startedAt?: number;
  running: boolean;
};

type Accumulated = {
  delegationId: string;
  agentName: string;
  task: string;
  status: SubagentOutcome;
  startedAt?: number;
  durationMs?: number;
};

const OUTCOMES = new Set<SubagentOutcome>([
  "running",
  "completed",
  "timed_out",
  "aborted",
  "failed",
  "stopped",
  "denied",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function createdAtMs(message: UiMessage): number | undefined {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function taskFromArgs(message: UiMessage): string {
  const args = asRecord(message.toolArgs);
  const task = args?.task;
  return typeof task === "string" ? task.trim() : "";
}

function agentFromArgs(message: UiMessage): string {
  const args = asRecord(message.toolArgs);
  const agent = args?.agent;
  return typeof agent === "string" ? agent.trim() : "";
}

function startStatus(payload: Record<string, unknown>): SubagentOutcome {
  const status = payload.status;
  return typeof status === "string" && OUTCOMES.has(status as SubagentOutcome)
    ? (status as SubagentOutcome)
    : "running";
}

/** A short, single-line brief for the roster row. */
function briefTitle(task: string, agentName: string): string {
  const firstLine = task.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  if (!firstLine) return agentName;
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

/**
 * Merge the renderer's live rows with the host's full-history rows.
 *
 * The host rows make old delegations visible; the live rows carry the newest
 * stream state. De-duplication is by row id, and the live copy wins because
 * the host snapshot can only be as fresh as its last read. Delegation identity
 * is separate from row identity: several rows can describe one delegate.
 */
export function mergeDelegationRows(
  history: readonly UiMessage[],
  live: readonly UiMessage[],
): UiMessage[] {
  const byId = new Map<string, UiMessage>();
  for (const message of history) byId.set(message.id, message);
  for (const message of live) byId.set(message.id, message);
  return [...byId.values()];
}

/**
 * Every delegation the merged rows prove exists, running first, newest first.
 *
 * Status comes from the shared topology projection rather than a private
 * ladder here: that is the one place that already knows a `Task` result starts
 * as `running`, lifecycle rows settle it, and a finished turn aborts leftovers.
 * Rows without a `delegationId` (a rejected `Task`) never become entries.
 */
export function buildSessionSubagentRoster(
  messages: readonly UiMessage[],
  options: { turnLive?: boolean } = {},
): SessionSubagentEntry[] {
  const items: AssistantActivityItem[] = messages.map((message) => ({
    kind: "tool" as const,
    message,
  }));
  const statuses = collectDelegationStatuses(items, options);
  const entries = new Map<string, Accumulated>();

  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) {
      continue;
    }
    const payload = asRecord(toolResultPayload(message));
    // A rejected call never delegated, so it is not a roster entry. The result
    // payload, not the fallback call id, is what proves a delegate started.
    if (!payload || typeof payload.delegationId !== "string") continue;
    const delegationId = payload.delegationId;
    if (!delegationId) continue;
    const startedAt = timestamp(payload.startedAt) ?? createdAtMs(message);
    const agentName =
      (typeof payload.agent === "string" ? payload.agent.trim() : "") ||
      agentFromArgs(message);
    const task = taskFromArgs(message);
    const previous = entries.get(delegationId);
    const status = statuses.get(delegationId) ?? startStatus(payload);
    const completedAt = timestamp(payload.completedAt);
    const durationMs =
      startedAt !== undefined && completedAt !== undefined
        ? Math.max(0, completedAt - startedAt)
        : undefined;
    entries.set(delegationId, {
      delegationId,
      agentName: agentName || previous?.agentName || "",
      // A resume call repeats the chain but brings a fresh brief; keep the
      // first task so the roster label stays stable while the chain continues.
      task: previous?.task || task,
      status,
      ...(previous?.startedAt !== undefined
        ? { startedAt: previous.startedAt }
        : startedAt !== undefined
          ? { startedAt }
          : {}),
      ...(durationMs !== undefined
        ? { durationMs }
        : previous?.durationMs !== undefined
          ? { durationMs: previous.durationMs }
          : {}),
    });
  }

  // A delegate that produced rows while its start row sits outside the merged
  // set still exists; `parentToolCallId` names the call that started it.
  for (const message of messages) {
    const parent = message.parentToolCallId;
    if (!parent || entries.has(parent) || !message.agentName) continue;
    entries.set(parent, {
      delegationId: parent,
      agentName: message.agentName,
      task: "",
      status: statuses.get(parent) ?? "running",
      ...(createdAtMs(message) !== undefined
        ? { startedAt: createdAtMs(message) }
        : {}),
    });
  }

  // Lifecycle rows can name delegates whose own rows are gone. They still ran
  // in this session, so the roster reports them instead of dropping them.
  for (const message of messages) {
    for (const entry of delegationRoster(message)) {
      if (entries.has(entry.delegationId)) continue;
      entries.set(entry.delegationId, {
        delegationId: entry.delegationId,
        agentName: entry.agentName,
        task: "",
        status: statuses.get(entry.delegationId) ?? entry.status,
        ...(entry.durationMs !== undefined
          ? { durationMs: entry.durationMs }
          : {}),
      });
    }
  }

  return [...entries.values()]
    .map((entry) => ({
      delegationId: entry.delegationId,
      agentName: entry.agentName,
      title: briefTitle(entry.task, entry.agentName),
      status: entry.status,
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      running: entry.status === "running",
    }))
    .sort((left, right) => {
      if (left.running !== right.running) return left.running ? -1 : 1;
      return (right.startedAt ?? 0) - (left.startedAt ?? 0);
    });
}

/** Running first, then settled; each group keeps newest-first order. */
export function groupSessionSubagentRoster(
  roster: readonly SessionSubagentEntry[],
): { running: SessionSubagentEntry[]; settled: SessionSubagentEntry[] } {
  return {
    running: roster.filter((entry) => entry.running),
    settled: roster.filter((entry) => !entry.running),
  };
}

/** Summary counts for the collapsed header. */
export function sessionSubagentSummary(
  roster: readonly SessionSubagentEntry[],
): { total: number; running: number } {
  return {
    total: roster.length,
    running: roster.filter((entry) => entry.running).length,
  };
}
