import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useSessionDelegations } from "../../hooks/use-session-delegations";
import {
  buildSessionSubagentRoster,
  groupSessionSubagentRoster,
  mergeDelegationRows,
  sessionSubagentSummary,
  type SessionSubagentEntry,
} from "../../lib/subagent-roster";
import { formatToolDuration } from "../../lib/tool-display";
import { cx } from "../ui";
import {
  IconBot,
  IconCheck,
  IconChevronDown,
  IconCircleAlert,
  IconMinus,
  IconX,
} from "../icons";

/**
 * Persisted per session for this app run only; a restart reopens expanded.
 * This mirrors the work panel's own session contexts: renderer memory, not a
 * preference the user expects to survive a launch.
 */
const COLLAPSED_SESSIONS = new Set<string>();

/**
 * A signature of the delegation facts the roster renders.
 *
 * The transcript array identity changes on every streaming token, so caching on
 * it would rebuild the list continuously. Caching on row identity alone is
 * wrong in the other direction: a settled delegation keeps its row id and only
 * its result changes, which left the row showing `running` after the delegate
 * finished. The signature therefore covers the fields that can change a row.
 */
function liveDelegationSignature(
  messages: readonly {
    id: string;
    toolName?: string;
    toolResult?: unknown;
    agentName?: string;
  }[],
): string {
  const parts: string[] = [];
  for (const message of messages) {
    const payload = message.toolResult as { details?: { status?: unknown; completedAt?: unknown } } | undefined;
    const status = payload?.details?.status;
    const completedAt = payload?.details?.completedAt;
    parts.push(
      `${message.id}\u0001${message.toolName ?? ""}\u0001${typeof status === "string" ? status : ""}\u0001${typeof completedAt === "number" ? completedAt : ""}\u0001${message.agentName ?? ""}`,
    );
  }
  return parts.join("\u0000");
}

function StatusIcon({ entry }: { entry: SessionSubagentEntry }) {
  switch (entry.status) {
    case "running":
      return (
        <span className="subagent-roster-live" aria-hidden="true">
          <IconBot size={12} />
        </span>
      );
    case "completed":
      return <IconCheck size={13} aria-hidden="true" />;
    case "failed":
    case "denied":
    case "timed_out":
      return <IconCircleAlert size={13} aria-hidden="true" />;
    case "aborted":
    case "stopped":
      return <IconMinus size={13} aria-hidden="true" />;
    default:
      return <IconX size={12} aria-hidden="true" />;
  }
}

function RosterRow({
  entry,
  selected,
  onOpen,
}: {
  entry: SessionSubagentEntry;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const duration =
    entry.durationMs !== undefined
      ? formatToolDuration(entry.durationMs / 1000)
      : null;
  return (
    <button
      type="button"
      className={cx(
        "subagent-roster-row",
        selected && "is-selected",
        `is-${entry.status}`,
      )}
      data-delegation-id={entry.delegationId}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
    >
      <span className="subagent-roster-row-icon">
        <StatusIcon entry={entry} />
      </span>
      <span className="subagent-roster-row-copy">
        <span className="subagent-roster-row-title">{entry.title}</span>
        <span className="subagent-roster-row-meta">
          {entry.agentName ? (
            <span className="subagent-roster-agent">{entry.agentName}</span>
          ) : null}
          {entry.agentName ? <span aria-hidden="true">·</span> : null}
          <span className="subagent-roster-status">
            {t(`chat.subagentStatus.${entry.status}`)}
          </span>
        </span>
      </span>
      {duration ? (
        <span className="subagent-roster-duration">{duration}</span>
      ) : null}
    </button>
  );
}

/**
 * A compact, always-available index of the active conversation's subagents.
 *
 * It sits above every work-panel tab body rather than inside one tab: "who is
 * still working, and where is that one from earlier" has to be answerable
 * while reading Review, a file, or a browser view. A row opens the existing
 * subagent detail tab, which remains the one place rendering a delegation's
 * conversation.
 */
export function SessionSubagentRoster() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const openSubagentTab = useAppStore((state) => state.openSubagentTab);
  const activeTabId = useAppStore((state) => state.activeWorkPanelTabId);
  const activeTab = useAppStore((state) =>
    state.workPanelTabs.find((tab) => tab.id === state.activeWorkPanelTabId),
  );
  const running = useAppStore((state) =>
    state.activeSessionId
      ? state.runningSessions[state.activeSessionId] ?? false
      : false,
  );
  const liveMessages = useAppStore((state) =>
    state.activeSessionId === sessionId
      ? state.messages
      : sessionId
        ? state.retainedTranscripts[sessionId] ?? null
        : null,
  );
  const liveSignature = liveMessages
    ? liveDelegationSignature(liveMessages)
    : "";
  const { rows, loading, error, reload } = useSessionDelegations(sessionId);

  const [collapsed, setCollapsed] = useState(() =>
    sessionId ? COLLAPSED_SESSIONS.has(sessionId) : false,
  );
  useEffect(() => {
    setCollapsed(sessionId ? COLLAPSED_SESSIONS.has(sessionId) : false);
  }, [sessionId]);

  const roster = useMemo(
    () =>
      buildSessionSubagentRoster(
        mergeDelegationRows(rows?.messages ?? [], liveMessages ?? []),
        // Only a live turn can still settle a running delegation; after it
        // ends, leftovers read as aborted, exactly like the transcript.
        { turnLive: running },
      ),
    // `liveSignature` stands in for the live array: its identity changes on
    // every token, while a row's own fields only change when it really does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, liveSignature, running],
  );

  // Keep the section on screen for every state the user must be told about:
  // loading and a failed read. Hiding those would present an unknown answer as
  // "no subagents", which is exactly what the roster is supposed to resolve.
  const visible = roster.length > 0 || loading || error !== null;
  if (!sessionId || !visible) return null;
  const summary = sessionSubagentSummary(roster);

  const groups = groupSessionSubagentRoster(roster);
  const activeDelegationId =
    activeTab?.kind === "subagent" ? activeTab.resource : undefined;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) COLLAPSED_SESSIONS.add(sessionId);
    else COLLAPSED_SESSIONS.delete(sessionId);
  };

  return (
    <section
      className={cx("subagent-roster", collapsed && "is-collapsed")}
      aria-label={t("panel.roster.title")}
      data-testid="session-subagent-roster"
    >
      <button
        type="button"
        className="subagent-roster-header no-drag"
        aria-expanded={!collapsed}
        aria-controls="subagent-roster-body"
        onClick={toggle}
      >
        <span className="subagent-roster-chevron" aria-hidden="true">
          <IconChevronDown size={12} />
        </span>
        <span className="subagent-roster-heading">{t("panel.roster.title")}</span>
        {summary.total > 0 ? (
          <span className="subagent-roster-count">
            {t("panel.roster.count", { total: summary.total })}
          </span>
        ) : null}
        {summary.running > 0 ? (
          <span className="subagent-roster-running">
            <span className="subagent-roster-dot" aria-hidden="true" />
            {t("panel.roster.running", { count: summary.running })}
          </span>
        ) : null}
        <span className="subagent-roster-hint">
          {collapsed
            ? t("panel.roster.expand")
            : t("panel.roster.currentSession")}
        </span>
      </button>

      {!collapsed ? (
        <div className="subagent-roster-body" id="subagent-roster-body">
          {loading ? (
            <div className="subagent-roster-note" role="status">
              {t("panel.roster.loading")}
            </div>
          ) : null}
          {error ? (
            <div className="subagent-roster-note is-error" role="alert">
              <span>{t("panel.roster.error")}</span>
              <button
                type="button"
                className="subagent-roster-retry"
                onClick={reload}
              >
                {t("panel.roster.retry")}
              </button>
            </div>
          ) : null}
          {groups.running.length > 0 ? (
            <div className="subagent-roster-group">
              <div className="subagent-roster-group-label">
                {t("panel.roster.groupRunning")}
              </div>
              {groups.running.map((entry) => (
                <RosterRow
                  key={entry.delegationId}
                  entry={entry}
                  selected={entry.delegationId === activeDelegationId}
                  onOpen={() =>
                    openSubagentTab(entry.delegationId, entry.agentName)
                  }
                />
              ))}
            </div>
          ) : null}
          {groups.settled.length > 0 ? (
            <div className="subagent-roster-group">
              <div className="subagent-roster-group-label">
                {t("panel.roster.groupSettled")}
              </div>
              {groups.settled.map((entry) => (
                <RosterRow
                  key={entry.delegationId}
                  entry={entry}
                  selected={entry.delegationId === activeDelegationId}
                  onOpen={() =>
                    openSubagentTab(entry.delegationId, entry.agentName)
                  }
                />
              ))}
            </div>
          ) : null}
          {!loading && !error && summary.total === 0 ? (
            <div className="subagent-roster-note" role="status">
              {t("panel.roster.empty")}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
