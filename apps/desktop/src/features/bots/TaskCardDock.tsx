import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type TaskCardDraftView, type TaskOverlap, type TaskView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { IconChevronDown, IconChevronUp } from "../../components/icons";
import {
  classifyConfirmError,
  confirmRequest,
  dispatchedLine,
  visibleCards,
} from "./task-card-dock";
import {
  followsLine,
  overlapHint,
  predecessorStarted,
  shortLabel,
  taskOfDraft,
  waitingForPreviousLine,
} from "./task-relay";
import { DEFAULT_STEWARD_NAME, stewardNameOf } from "./steward-name";

/**
 * The steward's task cards, docked above the composer (ADR
 * bot-sessions-and-steward §3).
 *
 * Two rules are the whole point of this component:
 *
 * - **"Start" is the confirmation.** There is no second dialog: the person
 *   reading the card and clicking is the act that freezes it into a Mandate.
 * - **The hash that is displayed is the hash that is sent.** If the card was
 *   revised in between, the host answers `CONFLICT` and this reloads and asks
 *   the person to look again. It never retries the confirmation by itself,
 *   because a silent retry would approve text nobody read.
 */
export function TaskCardDock({
  sessionId,
  drafts: providedDrafts,
  onConfirm = (draft) => api.confirmTaskCard(confirmRequest(draft)),
  onDrop = (draft) => api.dropTaskCard(draft.id),
  onAssign = (draft, targetSessionId) =>
    api.reassignTaskCard({ draftId: draft.id, targetSessionId }),
  onReload = () => api.listTaskCards(sessionId),
}: {
  sessionId: string;
  /** Data seam: the composer omits it and the dock reads the host. */
  drafts?: readonly TaskCardDraftView[];
  onConfirm?: (draft: TaskCardDraftView) => Promise<unknown>;
  onDrop?: (draft: TaskCardDraftView) => Promise<unknown>;
  /**
   * The person changing the employee on a proposed card (slice 3).
   *
   * It is a click like confirming, and the host answers with a new `cardHash`
   * plus whether the card's repository is reachable from the new employee — the
   * dock shows the warning and still waits for "开工".
   */
  onAssign?: (draft: TaskCardDraftView, targetSessionId: string) => Promise<unknown>;
  onReload?: () => Promise<{ drafts: TaskCardDraftView[] }>;
}) {
  const { t } = useTranslation();
  const readHost = providedDrafts === undefined;
  const [loadedDrafts, setLoadedDrafts] = useState<TaskCardDraftView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Target session id → its project path (empty when unbound). */
  const [targetProjects, setTargetProjects] = useState<Record<string, string>>({});
  /** The employees the dropdown offers, as the sidebar's roster read returns them. */
  const [employees, setEmployees] = useState<readonly { sessionId: string; name: string }[]>([]);
  /**
   * The steward's current name, read from its own employee profile: every label
   * about that role interpolates it, so a rename shows up here too.
   */
  const [stewardName, setStewardName] = useState(DEFAULT_STEWARD_NAME);
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});
  /**
   * The tasks these cards became.
   *
   * A confirmed card folds into one line, and a relay step that is waiting for
   * the step before it folds into a different one: the confirmation is done and
   * the work is authorized, but the host has not started it. Only the task says
   * which of the two a card is.
   */
  const [tasks, setTasks] = useState<TaskView[]>([]);
  /**
   * What other tasks in one repository are changing, per project.
   *
   * Read once per project the dock's cards name, never per card: it is a hint
   * above the start button, and the person is looking at several cards at once.
   */
  const [overlaps, setOverlaps] = useState<Record<string, TaskOverlap | null>>({});

  useEffect(() => {
    if (!readHost) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await api.listTaskCards(sessionId);
        if (cancelled) return;
        setLoadedDrafts(result.drafts ?? []);
        setLoadError(null);
      } catch (cause) {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      }
      // The tasks are read in their own try: a card list is still worth showing
      // when the board cannot be read, and the only thing lost is the sentence
      // that tells a waiting step apart from a running one.
      try {
        const listed = await api.listTasks({});
        if (cancelled) return;
        setTasks(listed.tasks ?? []);
      } catch {
        // Left as it was: no task, no line.
      }
    };
    void load();
    // The employee's project decides whether the card can be carried out, so the
    // dock reads it once and keeps it current with the roster's own event.
    const loadProjects = async () => {
      try {
        const roster = await api.listBots();
        if (cancelled) return;
        setTargetProjects(
          Object.fromEntries(
            (roster.bots ?? []).map((bot) => [bot.sessionId, bot.projectPath ?? ""]),
          ),
        );
        setEmployees(
          (roster.bots ?? []).map((bot) => ({
            sessionId: bot.sessionId,
            name: bot.profile?.name?.trim() || bot.title,
          })),
        );
        setStewardName(stewardNameOf(roster.bots));
      } catch {
        // A failed read only costs the project line, never the card itself.
      }
    };
    void loadProjects();
    const stopBots = api.onBotsChanged(() => void loadProjects());
    // Only this session's cards move this dock: another steward's event must
    // not refetch, or blank, the transcript the person is reading.
    const stopCards = api.onTaskCardsChanged((event) => {
      if (event.sessionId && event.sessionId !== sessionId) return;
      void load();
    });
    return () => {
      stopCards?.();
      stopBots?.();
    };
  }, [readHost, sessionId]);

  const drafts = providedDrafts ?? loadedDrafts;
  const visible = useMemo(() => visibleCards(drafts), [drafts]);

  /**
   * The projects the dock's proposed cards name.
   *
   * One read of "what else is changing here" per project, because the hint is
   * about the repository and several cards can name the same one. A card whose
   * employee has no project contributes nothing: there is nothing to compare.
   */
  const cardProjects = useMemo(() => {
    const paths = new Set<string>();
    for (const draft of visible) {
      if (draft.status !== "proposed") continue;
      const path = targetProjects[draft.targetSessionId];
      if (path) paths.add(path);
    }
    return [...paths].sort();
  }, [visible, targetProjects]);
  const projectsKey = cardProjects.join("\n");

  useEffect(() => {
    if (!readHost || !projectsKey) return undefined;
    let cancelled = false;
    const load = async () => {
      const next: Record<string, TaskOverlap | null> = {};
      for (const path of projectsKey.split("\n")) {
        try {
          next[path] = await api.checkTaskOverlap({ projectPath: path });
        } catch {
          // A read that threw is the same fact the host reports as
          // `readable: false`: nobody could tell, and the card says so.
          next[path] = { readable: false, tasks: [], intersections: [] };
        }
      }
      if (!cancelled) setOverlaps((current) => ({ ...current, ...next }));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [readHost, projectsKey]);

  const setError = (draftId: string, message: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (message) next[draftId] = message;
      else delete next[draftId];
      return next;
    });
  };

  const reload = async () => {
    const result = await onReload();
    if (readHost) {
      setLoadedDrafts(result.drafts ?? []);
      // The confirmation changed a card into a task, so the line the card folds
      // into is read back rather than assumed.
      try {
        const listed = await api.listTasks({});
        setTasks(listed.tasks ?? []);
      } catch {
        // Keep the tasks that were already known.
      }
    }
    return result.drafts ?? [];
  };

  /**
   * The person's click. **Every** outcome reloads afterwards, success and
   * failure alike: a success must show the host's confirmed card, and any
   * failure may have come from a screen that had gone stale, so reloading
   * resolves that without the person guessing. What a reload never does is
   * re-send the confirmation — that is the person's act alone, so a conflict
   * only repaints the card and asks them to look again.
   */
  const confirm = async (draft: TaskCardDraftView) => {
    if (busyId) return;
    setBusyId(draft.id);
    setError(draft.id, null);
    try {
      const result = (await onConfirm(draft)) as { startError?: string } | undefined;
      // A card can be dispatched and still not start (a busy target). The
      // confirmation stands, so the dock says what happened instead of showing a
      // calm "dispatched" line over work that is not running.
      if (result?.startError) {
        setStartErrors((current) => ({ ...current, [draft.id]: result.startError! }));
      }
      await reload();
    } catch (cause) {
      const outcome = classifyConfirmError(cause);
      const conflict = outcome.kind === "conflict";
      try {
        // Either way the screen must show what the host holds now; only a
        // conflict adds the "review it again" sentence.
        await reload();
      } catch {
        // A failed reload leaves the old card on screen with its message.
      }
      setError(
        draft.id,
        conflict
          ? t("bots.card.conflict")
          : t("bots.card.confirmFailed", {
              reason: outcome.kind === "failed" ? outcome.reason : "",
            }),
      );
    } finally {
      setBusyId(null);
    }
  };

  const drop = async (draft: TaskCardDraftView) => {
    if (busyId) return;
    setBusyId(draft.id);
    setError(draft.id, null);
    try {
      await onDrop(draft);
      await reload();
    } catch (cause) {
      setError(draft.id, t("bots.card.dropFailed", { reason: reasonOf(cause) }));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * The person picking a different employee (slice 3).
   *
   * Only the host decides what that means: it narrows the card to what the new
   * employee may do, recomputes the hash, and answers with the project it could
   * resolve. The dock then reloads, because the card on screen is no longer the
   * card the host holds — sending the old hash would be refused, and re-sending
   * it here would approve text nobody re-read.
   */
  const assign = async (draft: TaskCardDraftView, targetSessionId: string) => {
    if (busyId || !targetSessionId || targetSessionId === draft.targetSessionId) return;
    setBusyId(draft.id);
    setError(draft.id, null);
    setStartErrors((current) => {
      const next = { ...current };
      delete next[draft.id];
      return next;
    });
    try {
      await onAssign(draft, targetSessionId);
      await reload();
    } catch (cause) {
      setError(draft.id, t("bots.card.assignFailed", { reason: reasonOf(cause) }));
    } finally {
      setBusyId(null);
    }
  };

  if (visible.length === 0 && !loadError) return null;

  return (
    <div className="task-card-dock" data-testid="task-card-dock">
      {loadError ? (
        <section className="task-card" role="region" aria-label={t("bots.card.title", { name: stewardName })}>
          <p className="task-card-error" role="alert">
            {t("bots.card.loadFailed", { reason: loadError })}
          </p>
          <div className="task-card-actions">
            <Button
              variant="secondary"
              onClick={() =>
                void reload()
                  .then(() => setLoadError(null))
                  .catch(() => undefined)
              }
            >
              {t("bots.card.retry")}
            </Button>
          </div>
        </section>
      ) : null}
      {visible.map((draft) => {
        if (draft.status !== "confirmed") {
          const follows = followsLine(draft, drafts, t);
          const project = targetProjects[draft.targetSessionId] ?? "";
          return (
            <TaskCard
              key={draft.id}
              draft={draft}
              busy={busyId === draft.id}
              error={errors[draft.id] ?? null}
              stewardName={stewardName}
              onConfirm={() => void confirm(draft)}
              onAssign={(targetSessionId) => void assign(draft, targetSessionId)}
              employees={employees}
              project={project}
              previousShortId={follows?.shortId ?? null}
              canStart={predecessorStarted(draft, drafts)}
              overlap={project ? (overlaps[project] ?? null) : null}
              onDrop={() => void drop(draft)}
            />
          );
        }
        // A confirmed card folds into one line. Two lines are possible, and
        // which one it is comes from the task: work in motion, or a relay step
        // that is authorized and waiting for the step before it to hand off.
        const task = taskOfDraft(draft, tasks);
        const waiting = task
          ? waitingForPreviousLine(
              task,
              tasks,
              (sessionId) => employees.find((one) => one.sessionId === sessionId)?.name ?? "",
              t,
            )
          : null;
        return (
          <div
            key={draft.id}
            className={`task-card-dispatched${
              draft.confirmedBy === "policy" ? " task-card-auto" : ""
            }`}
            data-draft-id={draft.id}
            data-auto-started={draft.confirmedBy === "policy" ? "true" : undefined}
            data-relay-waiting={waiting ? "true" : undefined}
          >
            <span>
              {waiting
                ? waiting
                : draft.confirmedBy === "policy"
                  ? t("bots.card.autoStarted", {
                      name: draft.targetTitle ?? t("bots.card.targetUnknown"),
                    })
                  : dispatchedLine(draft, t)}
            </span>
            {startErrors[draft.id] ? (
              <span className="task-card-error" role="alert">
                {t("bots.card.startFailed", { reason: startErrors[draft.id] })}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({
  draft,
  busy,
  error,
  project,
  stewardName,
  previousShortId = null,
  canStart = true,
  overlap = null,
  employees = [],
  onAssign,
  onConfirm,
  onDrop,
}: {
  draft: TaskCardDraftView;
  busy: boolean;
  error: string | null;
  /** The target employee's project; empty or absent means unbound. */
  project?: string;
  /** The steward's current name; the card's heading names it. */
  stewardName: string;
  /** The card this one follows, as a short label, or null when it starts a chain. */
  previousShortId?: string | null;
  /** False while the card this one follows has not been started (slice 7). */
  canStart?: boolean;
  /** What other tasks in this project are changing; a hint, never a refusal. */
  overlap?: TaskOverlap | null;
  /** The roster the dropdown offers (slice 3). */
  employees?: readonly { sessionId: string; name: string }[];
  /** The person's pick; the host re-narrows and re-hashes the card. */
  onAssign?: (targetSessionId: string) => void;
  onConfirm: () => void;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  const [sourceOpen, setSourceOpen] = useState(false);
  const { card } = draft;
  // A card the steward could not attribute has no employee yet; starting it is
  // refused by the host until the person picks one, so the button says so
  // instead of failing on the click.
  const hasTarget = Boolean(draft.targetSessionId.trim());
  const overlapLine = overlapHint(overlap, t);
  const startLabel = !hasTarget
    ? t("bots.card.pickEmployee")
    : canStart
      ? t("bots.card.confirm")
      : t("bots.card.needPreviousFirst");

  return (
    <section
      className="task-card"
      role="region"
      aria-label={t("bots.card.title", { name: stewardName })}
      aria-busy={busy || undefined}
      data-draft-id={draft.id}
      data-card-hash={draft.cardHash}
    >
      <div className="task-card-header">
        <span>{t("bots.card.title", { name: stewardName })}</span>
        <span aria-hidden>·</span>
        <span>{t(riskKey(card.risk))}</span>
      </div>
      <p className="task-card-goal">{card.goal}</p>

      {previousShortId ? (
        // The card this one follows: a chain is read in order, so the person sees
        // where this step sits before reading what it asks for (slice 7).
        <p className="task-card-relay" data-card-follows={previousShortId}>
          {t("bots.card.follows", { shortId: previousShortId })}
        </p>
      ) : null}

      {card.reason ? (
        // Why this employee: the steward's one-sentence justification, read
        // before the person decides. It is the card's own field, not a log.
        <p className="task-card-reason" data-card-reason="">
          {card.reason}
        </p>
      ) : null}

      {card.criteria.length > 0 ? (
        <div className="task-card-section">
          <div className="task-card-section-title">{t("bots.card.criteria")}</div>
          <ul className="task-card-list">
            {card.criteria.map((criterion) => (
              <li key={criterion.id}>{criterion.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {card.boundaries.length > 0 ? (
        <div className="task-card-section">
          <div className="task-card-section-title">{t("bots.card.boundaries")}</div>
          <ul className="task-card-list">
            {card.boundaries.map((boundary) => (
              <li key={boundary}>{boundary}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="task-card-meta">
        <span className="task-card-assign">
          <label htmlFor={`task-card-assign-${draft.id}`}>{t("bots.card.target")}</label>
          {onAssign && employees.length > 0 ? (
            <select
              id={`task-card-assign-${draft.id}`}
              className="task-card-assign-select"
              value={draft.targetSessionId}
              disabled={busy}
              data-card-assign=""
              onChange={(event) => onAssign(event.currentTarget.value)}
            >
              {/* A card with nobody on it starts here: the person picks the
                  employee, and the host narrows the card to what that one may
                  do before anything can be started. */}
              <option value="" disabled>
                {t("bots.card.targetUnknown")}
              </option>
              {employees.map((employee) => (
                <option key={employee.sessionId} value={employee.sessionId}>
                  {employee.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{draft.targetTitle ?? t("bots.card.targetUnknown")}</span>
          )}
        </span>
        <span>
          {t("bots.card.permission")}: {t(permissionKey(card.permissionMode))}
        </span>
        {/* The one card the host may start without a person, said where the
            person checks its permission rather than left to be inferred from a
            mode. `auto` is not read-only, so the badge is the claim, not the
            mode (review S1). */}
        {card.readOnly ? (
          <span className="task-card-readonly" data-card-readonly="">
            {t("bots.card.readOnly")}
          </span>
        ) : null}

        <span className={hasTarget && project ? undefined : "task-card-warning"}>
          {t("bots.card.project")}:{" "}
          {!hasTarget
            ? t("bots.card.projectUnknownTarget")
            : project
              ? project
              : t("bots.card.projectUnbound")}
        </span>
      </div>

      <div className="task-card-source">
        <Button
          variant="ghost"
          aria-expanded={sourceOpen}
          onClick={() => setSourceOpen((value) => !value)}
        >
          {sourceOpen ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
          {sourceOpen ? t("bots.card.sourceHide") : t("bots.card.sourceShow")}
        </Button>
        {sourceOpen ? <p className="task-card-source-text">{draft.sourceUtterance}</p> : null}
      </div>

      {error ? (
        <p className="task-card-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="task-card-actions">
        {overlapLine ? (
          // A warning, not a refusal: the person who is told can still decide
          // the two changes are unrelated (slice 7).
          <p className="task-card-overlap" data-card-overlap="">
            {overlapLine}
          </p>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={onDrop}>
          {busy ? t("bots.card.dropping") : t("bots.card.drop")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !hasTarget || !canStart}
          onClick={onConfirm}
        >
          {busy ? t("bots.card.confirming") : startLabel}
        </Button>
      </div>
    </section>
  );
}

function riskKey(risk: "low" | "medium" | "high"): string {
  return risk === "high"
    ? "bots.card.riskHigh"
    : risk === "medium"
      ? "bots.card.riskMedium"
      : "bots.card.riskLow";
}

function permissionKey(mode: "ask" | "accept-edits" | "auto"): string {
  return mode === "auto"
    ? "bots.settings.permissionAuto"
    : mode === "accept-edits"
      ? "bots.settings.permissionAcceptEdits"
      : "bots.settings.permissionAsk";
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
