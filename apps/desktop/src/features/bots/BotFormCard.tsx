import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ALWAYS_MUST_ASK, BOT_MUST_ASK, type BotMustAsk } from "@minih-agent/shared";
import {
  Button,
  Checkbox,
  Field,
  Input,
  SegmentedControl,
  SettingsToggle,
} from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../settings/primitives";
import {
  botProfileInput,
  botProjectPatch,
  draftIsValid,
  isMustAskLocked,
  toggleMustAsk,
  type BotDraft,
} from "./bot-draft";

/** Spelled out rather than derived, so each option names its own i18n key. */
const MUST_ASK_LABEL_KEYS: Record<BotMustAsk, string> = {
  push: "bots.settings.mustAskPush",
  merge: "bots.settings.mustAskMerge",
  deploy: "bots.settings.mustAskDeploy",
  delete: "bots.settings.mustAskDelete",
  spend: "bots.settings.mustAskSpend",
  "criteria-change": "bots.settings.mustAskCriteriaChange",
};

/**
 * The employee form, shared by "new" and "edit" (ADR bot-sessions-and-steward
 * §1). One form for both paths keeps "what an employee is" in one place: name,
 * duty, permission ceiling, the actions that must come back to the person, the
 * consent gate, and the definition that supplies its prompt and tools.
 *
 * The always-asked three are rendered checked and disabled: the executing side
 * adds them to every card regardless, so a control that let the person untick
 * them would promise something the host does not honour.
 */
export function BotFormCard({
  initial,
  definitions,
  projects = [],
  title,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  initial: BotDraft;
  /** Definition handles `Task` would offer; the steward is one of them. */
  definitions: readonly { id: string; label: string }[];
  /** Projects the person can bind; an employee without one cannot read code. */
  projects?: readonly { path: string; name: string }[];
  title: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (profile: ReturnType<typeof botProfileInput>, projectPath: string | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<BotDraft>(initial);

  return (
    <SettingsCard title={title}>
      <div className="bot-form">
        <Field label={t("bots.settings.name")}>
          <Input
            value={draft.name}
            maxLength={80}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label={t("bots.settings.duty")} hint={t("bots.settings.dutyHint")}>
          <Input
            value={draft.duty}
            maxLength={500}
            onChange={(event) => setDraft({ ...draft, duty: event.target.value })}
          />
        </Field>
        <Field label={t("bots.settings.permission")}>
          <SegmentedControl
            label={t("bots.settings.permission")}
            value={draft.permissionMode}
            options={[
              { value: "ask", label: t("bots.settings.permissionAsk") },
              { value: "accept-edits", label: t("bots.settings.permissionAcceptEdits") },
              { value: "auto", label: t("bots.settings.permissionAuto") },
            ]}
            onChange={(permissionMode) => setDraft({ ...draft, permissionMode })}
          />
        </Field>
        <div className="bot-form-group">
          <div className="bot-form-group-title">
            <span>{t("bots.settings.mustAsk")}</span>
            <span className="bot-form-note">{t("bots.settings.mustAskHint")}</span>
          </div>
          <div className="bot-must-ask-list" role="group" aria-label={t("bots.settings.mustAsk")}>
            {BOT_MUST_ASK.map((value) => {
              const locked = isMustAskLocked(value);
              return (
                <div key={value} className="bot-must-ask-item">
                  <Checkbox
                    checked={locked || draft.mustAsk.includes(value)}
                    disabled={locked}
                    aria-label={t(MUST_ASK_LABEL_KEYS[value])}
                    onChange={() =>
                      setDraft({ ...draft, mustAsk: toggleMustAsk(draft.mustAsk, value) })
                    }
                    label={t(MUST_ASK_LABEL_KEYS[value])}
                  />
                  {locked ? (
                    <span className="bot-form-note">{t("bots.settings.mustAskForced")}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        <SettingsRow
          title={t("bots.settings.observe")}
          description={t("bots.settings.observeHint")}
        >
          <SettingsToggle
            checked={draft.observe}
            label={t("bots.settings.observe")}
            onChange={() => setDraft({ ...draft, observe: !draft.observe })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("bots.settings.project")}
          description={t("bots.settings.projectHint")}
        >
          <SettingsMenuSelect
            label={t("bots.settings.project")}
            value={draft.projectPath}
            options={[
              { id: "", label: t("bots.settings.projectNone") },
              ...projects.map((project) => ({ id: project.path, label: project.name })),
            ]}
            onChange={(projectPath) => setDraft({ ...draft, projectPath })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("bots.settings.definition")}
          description={t("bots.settings.definitionHint")}
        >
          <SettingsMenuSelect
            label={t("bots.settings.definition")}
            value={draft.definition}
            options={[
              { id: "", label: t("bots.settings.definitionNone") },
              ...definitions.map((definition) => ({
                id: definition.id,
                label: definition.label,
              })),
            ]}
            onChange={(definition) => setDraft({ ...draft, definition })}
          />
        </SettingsRow>
        {error ? (
          <p className="bot-form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bot-form-actions">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {t("bots.settings.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !draftIsValid(draft)}
            onClick={() => onSubmit(botProfileInput(draft), botProjectPatch(draft).projectPath)}
          >
            {busy ? t("bots.settings.saving") : t("bots.settings.save")}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

/** The three the host always adds; exported so the page's copy stays honest. */
export { ALWAYS_MUST_ASK };
