import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type TaskCardDraftView } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { IconChevronDown, IconChevronUp } from "../../components/icons";
import {
  classifyConfirmError,
  confirmRequest,
  dispatchedLine,
  visibleCards,
} from "./task-card-dock";

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
  onReload = () => api.listTaskCards(sessionId),
}: {
  sessionId: string;
  /** Data seam: the composer omits it and the dock reads the host. */
  drafts?: readonly TaskCardDraftView[];
  onConfirm?: (draft: TaskCardDraftView) => Promise<unknown>;
  onDrop?: (draft: TaskCardDraftView) => Promise<unknown>;
  onReload?: () => Promise<{ drafts: TaskCardDraftView[] }>;
}) {
  const { t } = useTranslation();
  const readHost = providedDrafts === undefined;
  const [loadedDrafts, setLoadedDrafts] = useState<TaskCardDraftView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

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
    };
    void load();
    // Only this session's cards move this dock: another steward's event must
    // not refetch, or blank, the transcript the person is reading.
    return api.onTaskCardsChanged((event) => {
      if (event.sessionId && event.sessionId !== sessionId) return;
      void load();
    });
  }, [readHost, sessionId]);

  const drafts = providedDrafts ?? loadedDrafts;
  const visible = useMemo(() => visibleCards(drafts), [drafts]);

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
    if (readHost) setLoadedDrafts(result.drafts ?? []);
    return result.drafts ?? [];
  };

  const confirm = async (draft: TaskCardDraftView) => {
    if (busyId) return;
    setBusyId(draft.id);
    setError(draft.id, null);
    try {
      await onConfirm(draft);
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

  if (visible.length === 0 && !loadError) return null;

  return (
    <div className="task-card-dock" data-testid="task-card-dock">
      {loadError ? (
        <section className="task-card" role="region" aria-label={t("bots.card.title")}>
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
      {visible.map((draft) =>
        draft.status === "confirmed" ? (
          <div key={draft.id} className="task-card-dispatched" data-draft-id={draft.id}>
            {dispatchedLine(draft, t)}
          </div>
        ) : (
          <TaskCard
            key={draft.id}
            draft={draft}
            busy={busyId === draft.id}
            error={errors[draft.id] ?? null}
            onConfirm={() => void confirm(draft)}
            onDrop={() => void drop(draft)}
          />
        ),
      )}
    </div>
  );
}

function TaskCard({
  draft,
  busy,
  error,
  onConfirm,
  onDrop,
}: {
  draft: TaskCardDraftView;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onDrop: () => void;
}) {
  const { t } = useTranslation();
  const [sourceOpen, setSourceOpen] = useState(false);
  const { card } = draft;

  return (
    <section
      className="task-card"
      role="region"
      aria-label={t("bots.card.title")}
      aria-busy={busy || undefined}
      data-draft-id={draft.id}
      data-card-hash={draft.cardHash}
    >
      <div className="task-card-header">
        <span>{t("bots.card.title")}</span>
        <span aria-hidden>·</span>
        <span>{t(riskKey(card.risk))}</span>
      </div>
      <p className="task-card-goal">{card.goal}</p>

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
        <span>
          {t("bots.card.target")}: {draft.targetTitle ?? t("bots.card.targetUnknown")}
        </span>
        <span>
          {t("bots.card.permission")}: {t(permissionKey(card.permissionMode))}
        </span>
        {card.mustAsk.length > 0 ? <span>{t("bots.card.mustAsk")}</span> : null}
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
        <Button variant="secondary" disabled={busy} onClick={onDrop}>
          {busy ? t("bots.card.dropping") : t("bots.card.drop")}
        </Button>
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {busy ? t("bots.card.confirming") : t("bots.card.confirm")}
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
