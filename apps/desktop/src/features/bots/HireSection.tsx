import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  HIRE_TEMPLATES,
  MAX_HIRE_UTTERANCE_CHARS,
  type BotHireDraft,
  type BotListItem,
  type HireTemplate,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button, Input } from "../../components/ui";
import { IconPlus } from "../../components/icons";
import { stewardSessionIdOf } from "./steward-name";

/**
 * Whether the crew already has a dispatcher: the enable button is for "none".
 *
 * The question is the same one every other surface asks — "is there a session
 * whose role is `steward`" — so it goes through the same helper. It must never be
 * a name comparison: the person can rename their dispatcher (#254), and a rename
 * that made this answer "none" would offer to hire a second one.
 */
export function hasSteward(bots: readonly BotListItem[]): boolean {
  return stewardSessionIdOf(bots) !== null;
}

/**
 * Hiring (employee mode 0.5 slice 6).
 *
 * Two ways to hire and one to start from nothing, and all three end in the same
 * place: a **form the person confirms**. A template only pre-fills it; the
 * one-sentence draft only pre-fills it; nothing here creates an employee.
 *
 * The templates are the six jobs of the plan. What each card shows beyond the
 * name is what changes the decision — whether the job is read-only, whether it
 * binds a repository, and which model family suits it — because those are the
 * facts a person cannot guess from a job title.
 *
 * "启用 Super Agent" appears only while there is no dispatcher: with one on the
 * crew, the button would be a second way to do what already exists, and the host
 * has nothing left to create.
 */
export function HireSection({
  bots,
  onTemplate,
  onDraft,
  onBlank,
  onEnableSteward,
  enabling,
  note,
}: {
  bots: readonly BotListItem[];
  /** A template was clicked: open the prefilled form. */
  onTemplate: (template: HireTemplate) => void;
  /** A draft came back from Main: open the form with it. */
  onDraft: (draft: BotHireDraft) => void;
  onBlank: () => void;
  onEnableSteward: () => void;
  enabling: boolean;
  /** The outcome of the last "enable Super Agent" click. */
  note: string | null;
}) {
  const { t } = useTranslation();
  const [utterance, setUtterance] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const draft = async () => {
    const sentence = utterance.trim();
    if (!sentence) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const result = await api.draftHire(sentence);
      onDraft(result.draft);
      setUtterance("");
    } catch (cause) {
      // Main writes these messages for the person ("the Super Agent has no model
      // yet"), so they are shown as they arrive instead of being rephrased.
      setDraftError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDrafting(false);
    }
  };

  return (
    <div className="bot-hire">
      <div className="bot-hire-grid" role="list" aria-label={t("bots.hiring.templates")}>
        {HIRE_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            role="listitem"
            className="bot-hire-template"
            data-template-id={template.id}
            onClick={() => onTemplate(template)}
          >
            <span className="bot-hire-template-name">{t(template.nameKey)}</span>
            <span className="bot-hire-template-duty">{t(template.dutyKey)}</span>
            <span className="bot-hire-template-meta">
              {template.readOnly ? (
                <span className="bot-hire-chip">{t("bots.hiring.readOnly")}</span>
              ) : null}
              {template.bindsRepository ? null : (
                <span className="bot-hire-chip">{t("bots.hiring.noRepository")}</span>
              )}
              {template.modelPreference === "ui" ? (
                <span className="bot-hire-chip">{t("bots.hiring.prefersUiModel")}</span>
              ) : null}
              {template.modelPreference === "coding" ? (
                <span className="bot-hire-chip">{t("bots.hiring.avoidsUiModel")}</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>

      <div className="bot-hire-actions">
        <Button variant="secondary" onClick={onBlank}>
          <IconPlus size={14} />
          {t("bots.hiring.fromBlank")}
        </Button>
        {hasSteward(bots) ? null : (
          <Button variant="primary" disabled={enabling} onClick={onEnableSteward}>
            {enabling ? t("bots.hiring.enablingSteward") : t("bots.hiring.enableSteward")}
          </Button>
        )}
      </div>
      {hasSteward(bots) ? null : (
        <p className="bot-form-note">{t("bots.hiring.enableStewardHint")}</p>
      )}
      {note ? (
        <p className="bot-form-note" role="status">
          {note}
        </p>
      ) : null}

      <div className="bot-hire-draft">
        <div className="bot-hire-draft-row">
          <Input
            value={utterance}
            maxLength={MAX_HIRE_UTTERANCE_CHARS}
            placeholder={t("bots.hiring.draftPlaceholder")}
            aria-label={t("bots.hiring.draftPlaceholder")}
            onChange={(event) => {
              setDraftError(null);
              setUtterance(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void draft();
              }
            }}
          />
          <Button
            variant="secondary"
            disabled={drafting || !utterance.trim()}
            onClick={() => void draft()}
          >
            {drafting ? t("bots.hiring.drafting") : t("bots.hiring.draft")}
          </Button>
        </div>
        <p className="bot-form-note">{t("bots.hiring.draftHint")}</p>
        {draftError ? (
          <p className="bot-form-error" role="alert">
            {draftError}
          </p>
        ) : null}
      </div>
    </div>
  );
}