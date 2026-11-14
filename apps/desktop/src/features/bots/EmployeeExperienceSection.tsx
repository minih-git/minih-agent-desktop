import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BotListItem, EmployeeLesson } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";
import { IconTrash } from "../../components/icons";

/**
 * One employee's lessons from its earlier tasks (employee mode 0.5 slice 5).
 *
 * Three things the ADR asks of this section, and nothing else:
 *
 * - **It shows what the employee learned**, one lesson per line, newest first.
 * - **Every lesson names the task it came from**, because "where did this come
 *   from" is the question a person asks before trusting it. The source is a
 *   button that opens that task's session.
 * - **A lesson can be deleted here**, through the same `memory.delete` every
 *   other note uses, so the tombstone keeps it from being learned again.
 *
 * When the learned-memory switch is off the section says so and links to the
 * settings that own the switch: there is nothing to show because nothing was
 * ever extracted, and pretending otherwise would look like a bug.
 */
export function EmployeeExperienceSection({
  bots,
  onOpenMemorySettings,
  onOpenSession,
}: {
  bots: readonly BotListItem[];
  /**
   * Navigate to the learned-memory settings, which own the switch. Optional: a
   * surface that cannot navigate still names where the switch lives, because a
   * hint without a destination is better than a button that does nothing.
   */
  onOpenMemorySettings?: () => void;
  /** Open a task session; absent means the source is shown as plain text. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lessons, setLessons] = useState<Record<string, EmployeeLesson[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getSettings()
      .then((settings) => {
        if (live) setEnabled(settings?.learnedMemory?.learn === true);
      })
      // A failed read leaves the section on "unknown": the note is the honest
      // answer, and the rest of the page still works.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    // A settings read that failed leaves `enabled` unknown: the section still
    // shows what the host holds, because a failed read is not a reason to hide
    // lessons the person may want to delete.
    if (enabled === false || bots.length === 0) return;
    let live = true;
    void Promise.all(
      bots.map(async (bot) => {
        try {
          const result = await api.listEmployeeExperience(bot.sessionId);
          return [bot.sessionId, result.entries] as const;
        } catch {
          return [bot.sessionId, [] as EmployeeLesson[]] as const;
        }
      }),
    ).then((pairs) => {
      if (live) setLessons(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [bots, enabled]);

  const remove = useCallback(
    async (employeeSessionId: string, lesson: EmployeeLesson) => {
      setBusy(lesson.id);
      setError(null);
      try {
        await api.deleteLearnedMemory(lesson.id);
        setLessons((current) => ({
          ...current,
          [employeeSessionId]: (current[employeeSessionId] ?? []).filter(
            (entry) => entry.id !== lesson.id,
          ),
        }));
      } catch {
        setError(t("bots.experience.deleteFailed"));
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  if (enabled === false) {
    return (
      <p className="bot-form-note" role="status">
        {t("bots.experience.disabled")}{" "}
        {onOpenMemorySettings ? (
          <Button type="button" variant="ghost" size="sm" onClick={onOpenMemorySettings}>
            {t("bots.experience.openSettings")}
          </Button>
        ) : (
          <span>{t("bots.experience.whereSettings")}</span>
        )}
      </p>
    );
  }

  return (
    <div className="bot-experience">
      {error ? (
        <p className="bot-form-error" role="alert">
          {error}
        </p>
      ) : null}
      {bots.map((bot) => {
        const entries = lessons[bot.sessionId];
        const name = bot.profile.name || bot.title;
        return (
          <section key={bot.sessionId} className="bot-experience-group">
            <h4 className="bot-experience-title">
              {t("bots.experience.forEmployee", { name })}
            </h4>
            {entries === undefined ? (
              <p className="bot-form-note">{t("common.loading")}</p>
            ) : entries.length === 0 ? (
              <p className="bot-form-note">{t("bots.experience.empty")}</p>
            ) : (
              <ul className="bot-experience-list" role="list">
                {entries.map((lesson) => (
                  <li key={lesson.id} className="bot-experience-row" role="listitem">
                    <span className="bot-experience-content">{lesson.content}</span>
                    <span className="bot-experience-source">
                      {/* The task is the citation: a lesson without one is a claim
                          the person cannot check. */}
                      {lesson.sourceTaskShortId ? (
                        <button
                          type="button"
                          className="bot-experience-source-button"
                          onClick={() =>
                            lesson.sourceSessionId
                              ? onOpenSession?.(lesson.sourceSessionId)
                              : undefined
                          }
                          disabled={!onOpenSession || !lesson.sourceSessionId}
                          title={lesson.sourceTaskTitle}
                        >
                          {t("bots.experience.source", {
                            shortId: lesson.sourceTaskShortId,
                            date: lesson.sourceTaskArchivedAt
                              ? lesson.sourceTaskArchivedAt.slice(0, 10)
                              : "—",
                          })}
                        </button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("bots.experience.deleteLabel")}
                        disabled={busy === lesson.id}
                        onClick={() => void remove(bot.sessionId, lesson)}
                      >
                        <IconTrash size={14} />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}