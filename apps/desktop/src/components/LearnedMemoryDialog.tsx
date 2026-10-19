import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  LearnedMemoryEntry,
  LearnedMemoryKind,
  LearnedMemoryLocalStats,
  LearnedMemoryScopeKind,
  LearnedMemoryStatus,
} from "@minih-agent/shared";
import { useBlockingOverlay } from "../lib/blocking-overlay";
import { api } from "../lib/api";
import { localDay } from "../lib/learned-memory-extraction";
import {
  acceptancePercent,
  editConflicted,
  escapeCloses,
  formatIndexSize,
  initialManagerTab,
  managerRequest,
  showsEmptyState,
  sourceSessionOf,
  todayExtractionSpend,
} from "../lib/learned-memory-manager";
import { SuggestionBadge, SuggestionInbox } from "./LearnedMemorySuggestions";
import { Button, OverlayBackdrop, SegmentedControl, Select, Textarea, TooltipButton } from "./ui";
import {
  IconArchive,
  IconArchiveRestore,
  IconClose,
  IconFileText,
  IconSparkles,
  IconTrash,
} from "./icons";

const KINDS: LearnedMemoryKind[] = ["preference", "feedback", "fact", "reference"];
const STATUSES: LearnedMemoryStatus[] = ["active", "archived", "suggested"];

/**
 * The learned-memory manager (ADR agent-long-term-memory §3.2).
 *
 * One scope at a time: a project's notes, reached from its archive row menu, or
 * the user's own notes, reached from Settings. The host owns the rules, the
 * tombstones, and the compare-and-set revision; this dialog only shows the
 * entries and sends the edit it read back with that revision.
 */
export function LearnedMemoryDialog({
  scope,
  projectPath,
  projectName,
  onClose,
  onError,
  onOpenPinnedMemory,
  onOpenSourceSession,
}: {
  scope: LearnedMemoryScopeKind;
  projectPath?: string;
  projectName?: string;
  onClose: () => void;
  onError: (error: unknown) => void;
  onOpenPinnedMemory?: () => void;
  onOpenSourceSession?: (sessionId: string) => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LearnedMemoryEntry[] | null>(null);
  // The inbox is a tab of this dialog, not a separate surface: a suggestion is
  // reviewed with the same notes it will join once accepted.
  const [pendingSuggestions, setPendingSuggestions] = useState(0);
  const [tab, setTab] = useState<"entries" | "suggestions">("entries");
  const [status, setStatus] = useState<LearnedMemoryStatus | "">("");
  const [kind, setKind] = useState<LearnedMemoryKind | "">("");
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [stats, setStats] = useState<LearnedMemoryLocalStats | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listLearnedMemory(
        managerRequest({ scope, projectPath, status, kind }),
      );
      setEntries(result.entries);
    } catch (error) {
      onError(error);
      setEntries([]);
    }
  }, [kind, onError, projectPath, scope, status]);

  useEffect(() => {
    void load();
  }, [load]);

  // One read decides both the tab that opens and the badge: a user who clicked
  // "there is something to review" lands on the inbox, and a quiet manager
  // opens on the notes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listLearnedMemorySuggestions({
          scope,
          ...(scope === "project" && projectPath ? { path: projectPath } : {}),
        });
        if (cancelled) return;
        setPendingSuggestions(result.count);
        setTab((current) => (current === "entries" ? initialManagerTab(result.count) : current));
      } catch {
        // The badge is decoration: a failed read leaves the manager working.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, scope]);

  // This device's own counters: read when the manager opens, and again when a
  // decision changes them. A failed read hides the block, because the numbers
  // are context and a wrong one would be worse than none.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getLearnedMemoryStats();
        if (!cancelled) setStats(result.stats);
      } catch {
        if (!cancelled) setStats(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingSuggestions]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (escapeCloses(event.key, busy)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    // Focus lands inside the dialog so the keyboard reaches it immediately.
    dialogRef.current?.querySelector<HTMLElement>("button, select, textarea")?.focus();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = (entry: LearnedMemoryEntry) => {
    if (!editing || editing.id !== entry.id) return;
    const content = editing.content.trim();
    if (!content) return;
    setConflict(false);
    void run(async () => {
      try {
        const result = await api.updateLearnedMemory({
          id: entry.id,
          revision: entry.revision,
          content,
        });
        setEntries((current) =>
          (current ?? []).map((row) => (row.id === entry.id ? result.entry : row)),
        );
        setEditing(null);
      } catch (error) {
        // Another writer moved the revision: say so and reload rather than
        // overwrite what it wrote.
        if (editConflicted(error)) {
          setConflict(true);
          await load();
          return;
        }
        throw error;
      }
    });
  };

  const archive = (entry: LearnedMemoryEntry) =>
    run(async () => {
      const result =
        entry.status === "archived"
          ? await api.restoreLearnedMemory(entry.id)
          : await api.archiveLearnedMemory(entry.id);
      setEntries((current) =>
        (current ?? []).map((row) => (row.id === entry.id ? result.entry : row)),
      );
    });

  const remove = (entry: LearnedMemoryEntry) =>
    run(async () => {
      await api.deleteLearnedMemory(entry.id);
      setEntries((current) => (current ?? []).filter((row) => row.id !== entry.id));
      setPendingDelete(null);
    });

  const title = scope === "project"
    ? t("memory.managerTitleProject", { name: projectName ?? "" })
    : t("memory.managerTitleUser");

  // The two numbers the block formats rather than prints raw.
  const acceptanceRate = stats
    ? acceptancePercent(stats.suggestions.accepted, stats.suggestions.rejected)
    : null;
  const spentToday = stats ? todayExtractionSpend(stats.extraction, localDay()) : 0;

  const grouped = useMemo(() => entries ?? [], [entries]);

  return createPortal(
    <OverlayBackdrop
      className="overlay project-instructions-dialog-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog project-instructions-dialog project-memory-dialog learned-memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="learned-memory-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="project-instructions-dialog-head">
          <div>
            <h3
              id="learned-memory-dialog-title"
              className="project-instructions-dialog-title"
            >
              <IconSparkles size={17} aria-hidden />
              {title}
            </h3>
            {scope === "project" && projectPath ? (
              <div className="project-instructions-dialog-path">{projectPath}</div>
            ) : null}
          </div>
          <TooltipButton
            type="button"
            className="project-instructions-dialog-close"
            tooltip={t("settings.cancel")}
            ariaLabel={t("settings.cancel")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <p className="project-memory-dialog-description">{t("memory.managerDescription")}</p>
        <SegmentedControl
          value={tab}
          onChange={(next) => setTab(next as "entries" | "suggestions")}
          label={t("memory.managerTabs")}
          role="tablist"
          className="learned-memory-tabs"
          options={[
            { value: "entries", label: t("memory.tabEntries") },
            {
              value: "suggestions",
              label: (
                <span className="learned-memory-tab-label">
                  {t("memory.tabSuggestions")}
                  <SuggestionBadge count={pendingSuggestions} />
                </span>
              ),
            },
          ]}
        />
        {tab === "suggestions" ? (
          <SuggestionInbox
            scope={scope}
            projectPath={projectPath}
            busy={busy}
            onBusyChange={setBusy}
            onCountChange={setPendingSuggestions}
            onError={onError}
          />
        ) : (
          <>
        <div className="learned-memory-filters">
          <label className="learned-memory-filter">
            <span>{t("memory.filterKind")}</span>
            <Select
              value={kind}
              aria-label={t("memory.filterKind")}
              onChange={(event) => setKind(event.target.value as LearnedMemoryKind | "")}
            >
              <option value="">{t("memory.filterAll")}</option>
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(`memory.kind.${value}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className="learned-memory-filter">
            <span>{t("memory.filterStatus")}</span>
            <Select
              value={status}
              aria-label={t("memory.filterStatus")}
              onChange={(event) => setStatus(event.target.value as LearnedMemoryStatus | "")}
            >
              <option value="">{t("memory.filterAll")}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`memory.status.${value}`)}
                </option>
              ))}
            </Select>
          </label>
          {onOpenPinnedMemory ? (
            <Button type="button" size="sm" variant="ghost" onClick={onOpenPinnedMemory}>
              <IconFileText size={14} aria-hidden />
              {t("memory.openPinned")}
            </Button>
          ) : null}
        </div>
        {conflict ? (
          <p className="learned-memory-conflict" role="alert">
            {t("memory.editConflict")}
          </p>
        ) : null}
        {entries === null ? null : showsEmptyState(grouped) ? (
          <div className="project-memory-dialog-empty">
            <IconSparkles size={18} aria-hidden />
            <span>{t("memory.managerEmpty")}</span>
          </div>
        ) : (
          <div className="project-memory-dialog-list" role="list">
            {grouped.map((entry) => (
              <article className="project-memory-card learned-memory-card" key={entry.id} role="listitem">
                <div className="learned-memory-card-head">
                  <span className={`learned-memory-kind learned-memory-kind-${entry.kind}`}>
                    {t(`memory.kind.${entry.kind}`)}
                  </span>
                  <span className="learned-memory-meta">
                    {t(`memory.status.${entry.status}`)}
                    {" · "}
                    {new Date(entry.createdAt).toISOString().slice(0, 10)}
                    {sourceSessionOf(entry) ? ` · ${t("memory.fromSession")}` : ""}
                  </span>
                </div>
                {editing?.id === entry.id ? (
                  <Textarea
                    className="project-memory-entry-content"
                    value={editing.content}
                    aria-label={t("memory.editContent")}
                    disabled={busy}
                    onChange={(event) =>
                      setEditing({ id: entry.id, content: event.target.value })
                    }
                  />
                ) : (
                  <p className="learned-memory-content">{entry.content}</p>
                )}
                {entry.rationale ? (
                  <p className="project-memory-dialog-hint">{entry.rationale}</p>
                ) : null}
                <div className="learned-memory-actions">
                  {editing?.id === entry.id ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy || !editing.content.trim()}
                        onClick={() => saveEdit(entry)}
                      >
                        {t("memory.saveEdit")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        {t("settings.cancel")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setConflict(false);
                        setEditing({ id: entry.id, content: entry.content });
                      }}
                    >
                      {t("memory.edit")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void archive(entry)}
                  >
                    {entry.status === "archived" ? (
                      <>
                        <IconArchiveRestore size={14} aria-hidden />
                        {t("memory.restore")}
                      </>
                    ) : (
                      <>
                        <IconArchive size={14} aria-hidden />
                        {t("memory.archive")}
                      </>
                    )}
                  </Button>
                  {sourceSessionOf(entry) && onOpenSourceSession ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onOpenSourceSession(sourceSessionOf(entry)!)}
                    >
                      {t("memory.openSource")}
                    </Button>
                  ) : null}
                  <TooltipButton
                    type="button"
                    className="project-memory-remove"
                    tooltip={t("memory.delete")}
                    ariaLabel={t("memory.delete")}
                    disabled={busy}
                    onClick={() => setPendingDelete(entry.id)}
                  >
                    <IconTrash size={14} />
                  </TooltipButton>
                </div>
                {pendingDelete === entry.id ? (
                  <div className="learned-memory-delete" role="alertdialog">
                    <p>{t("memory.deleteConfirm")}</p>
                    <div className="learned-memory-actions">
                      <Button
                        type="button"
                        size="sm"
                        className="learned-memory-delete-confirm"
                        disabled={busy}
                        onClick={() => void remove(entry)}
                      >
                        {t("memory.deleteConfirmAction")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setPendingDelete(null)}
                      >
                        {t("settings.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
          </>
        )}
        {stats ? (
          <div className="learned-memory-stats">
            <h4 className="learned-memory-stats-title">{t("memory.statsTitle")}</h4>
            <ul className="learned-memory-stats-list">
              <li>
                {stats.index.capturedAt === null
                  ? t("memory.statsIndexNone")
                  : t("memory.statsIndex", {
                      entries: stats.index.entries,
                      size: formatIndexSize(stats.index.bytes),
                      omitted: stats.index.omitted,
                    })}
              </li>
              <li>
                {acceptanceRate === null
                  ? t("memory.statsSuggestionsNone")
                  : t("memory.statsSuggestions", {
                      accepted: stats.suggestions.accepted,
                      rejected: stats.suggestions.rejected,
                      percent: acceptanceRate,
                    })}
              </li>
              <li>
                {t("memory.statsBlocked", {
                  extraction: stats.tombstones.fromExtraction,
                  user: stats.tombstones.fromCreate,
                })}
              </li>
              <li>
                {spentToday === 0
                  ? t("memory.statsSpendNone")
                  : t("memory.statsSpend", {
                      tokens: spentToday.toLocaleString(),
                      runs: stats.extraction.day === localDay() ? stats.extraction.runs : 0,
                    })}
              </li>
            </ul>
          </div>
        ) : null}
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}
