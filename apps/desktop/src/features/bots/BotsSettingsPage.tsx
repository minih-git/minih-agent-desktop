import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  hireModelChoices,
  type BotHireDraft,
  type BotListItem,
  type BotProfileInput,
  type HireTemplate,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Badge, Button, SettingsToggle } from "../../components/ui";
import { SettingsCard } from "../settings/primitives";
import { IconPencil, IconPlus, IconTrash } from "../../components/icons";
import { botInitials, botStatusView } from "./bot-status";
import {
  EMPTY_BOT_DRAFT,
  botModelPatch,
  draftForTemplate,
  draftFromBot,
  type BotDraft,
} from "./bot-draft";
import { useBots } from "./use-bots";
import { BotFormCard } from "./BotFormCard";
import { EmployeeExperienceSection } from "./EmployeeExperienceSection";
import { HireSection, hasSteward } from "./HireSection";
import { TeamNormsSection } from "./TeamNormsSection";
import { useBotDefinitions } from "./use-bot-definitions";
/**
 * Settings → Employees (ADR bot-sessions-and-steward §1/§5, slice 6).
 *
 * The page never seeds on mount: creating a session because someone opened a
 * settings page is exactly the surprise `bot.seedDefaults` is explicit about.
 * Slice 6 replaced the "default crew" button with **hiring**: templates and a
 * one-sentence draft pre-fill the form, and the person confirms it. The only
 * thing the host still creates by itself is the Super Agent, offered as its own
 * button while there is none.
 */
export function BotsSettingsPage({
  bots: providedBots,
}: {
  /** Data seam: the settings shell omits it and the page reads the host. */
  bots?: readonly BotListItem[];
} = {}) {
  const { t } = useTranslation();
  const loaded = useBots();
  const bots = providedBots ?? loaded.bots;
  const { loading, error, reload } = loaded;
  const definitions = useBotDefinitions();
  /** `null` = closed, `"new"` = create, otherwise the session being edited. */
  const [editing, setEditing] = useState<"new" | string | null>(null);
  /** The form a template or a draft pre-filled, for the create path only. */
  const [newDraft, setNewDraft] = useState<BotDraft>(EMPTY_BOT_DRAFT);
  /** Why the form looks like that: the draft's own sentence, when there is one. */
  const [hireNote, setHireNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The projects a person can bind an employee to. Read here rather than in the
  // form so the list is fetched once per page, not once per open.
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);
  // The models the person configured: a hire suggests one per template, and the
  // picker is the only place that choice is made.
  const [models, setModels] = useState<ReturnType<typeof hireModelChoices>>([]);
  useEffect(() => {
    let live = true;
    void api
      .listProjects()
      .then((result) => {
        if (!live) return;
        setProjects(result.projects.map((project) => ({ path: project.path, name: project.name })));
      })
      // A failed read leaves the picker with only "unbound": the employee form
      // still works, and the person is not blocked from editing anything else.
      .catch(() => undefined);
    void api
      .listProviders()
      .then((result) => {
        if (live) setModels(hireModelChoices(result.providers ?? []));
      })
      // No models is a valid state: the picker then offers only "app default".
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [pendingDismiss, setPendingDismiss] = useState<string | null>(null);
  const [enablingSteward, setEnablingSteward] = useState(false);
  const [seedNote, setSeedNote] = useState<string | null>(null);

  const editingBot = editing && editing !== "new" ? bots.find((bot) => bot.sessionId === editing) : undefined;
  const creating = editing === "new";
  const initialDraft = useMemo(
    () => (creating ? newDraft : editingBot ? draftFromBot(editingBot) : EMPTY_BOT_DRAFT),
    [creating, editingBot, newDraft],
  );

  const save = async (profile: BotProfileInput, projectPath: string | null) => {
    setBusy(true);
    setFormError(null);
    try {
      if (creating) {
        await api.createBot({
          profile,
          ...(projectPath ? { projectPath } : {}),
          // The model is a hire decision: the form offered it, so it is sent.
          ...botModelPatch(newDraft),
        });
      } else if (editing) {
        // Always sent: `null` is the person unbinding the project, which must not
        // look like an omitted field that keeps the old value.
        await api.updateBot({ sessionId: editing, profile, projectPath });
      }
      setEditing(null);
      setNewDraft(EMPTY_BOT_DRAFT);
      setHireNote(null);
      await reload();
    } catch (cause) {
      setFormError(t("bots.settings.saveFailed", { name: profile.name, reason: reasonOf(cause) }));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (bot: BotListItem) => {
    setBusy(true);
    try {
      await api.dismissBot(bot.sessionId);
      setPendingDismiss(null);
      await reload();
    } catch (cause) {
      setSeedNote(t("bots.settings.dismissFailed", { name: bot.profile.name, reason: reasonOf(cause) }));
    } finally {
      setBusy(false);
    }
  };

  /** The one host action left in this page: make sure the dispatcher exists. */
  const enableSteward = async () => {
    setEnablingSteward(true);
    setSeedNote(null);
    try {
      const result = await api.seedDefaultBots();
      const created = result.created.map((item) => item.name).join(", ");
      const skipped = result.skipped.map((item) => item.name).join(", ");
      setSeedNote(
        [
          created ? t("bots.settings.seedCreated", { names: created }) : null,
          skipped ? t("bots.settings.seedSkipped", { names: skipped }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      await reload();
    } catch (cause) {
      setSeedNote(t("bots.settings.seedFailed", { reason: reasonOf(cause) }));
    } finally {
      setEnablingSteward(false);
    }
  };

  /** A template card was clicked: open its prefilled form. */
  const openTemplate = (template: HireTemplate) => {
    setFormError(null);
    setHireNote(null);
    setNewDraft(
      draftForTemplate(template.id, {
        name: t(template.nameKey),
        duty: t(template.dutyKey),
        definitions,
        models,
      }) ?? EMPTY_BOT_DRAFT,
    );
    setEditing("new");
  };

  /** A one-sentence draft came back: open the form with it, reason included. */
  const openDraft = (draft: BotHireDraft) => {
    setFormError(null);
    const base =
      draftForTemplate(draft.templateId, {
        name: draft.name,
        duty: draft.duty,
        definitions,
        models,
      }) ?? EMPTY_BOT_DRAFT;
    // Main already narrowed the permission and the must-ask list to the
    // template's ceiling; the form shows that result and the person may change
    // any of it before saving.
    setNewDraft({
      ...base,
      name: draft.name,
      duty: draft.duty,
      permissionMode: draft.permissionMode,
      mustAsk: draft.mustAsk,
      projectPath: draft.projectPath ?? "",
    });
    setHireNote(draft.reason ? t("bots.hiring.draftReason", { reason: draft.reason }) : null);
    setEditing("new");
  };

  const definitionLabel = (handle: string | undefined) =>
    handle
      ? (definitions.find((item) => item.id === handle)?.label ?? handle)
      : t("bots.settings.definitionNone");
  const botProjectLabel = (path: string | undefined) =>
    path
      ? (projects.find((project) => project.path === path)?.name ?? path)
      : t("bots.settings.projectUnbound");

  return (
    <div className="settings-stack bot-settings">
      <SettingsCard title={t("bots.norms.title")} description={t("bots.norms.description")}>
        <TeamNormsSection />
      </SettingsCard>

      <SettingsCard title={t("bots.hiring.title")} description={t("bots.hiring.description")}>
        <HireSection
          bots={bots}
          onTemplate={openTemplate}
          onDraft={openDraft}
          onBlank={() => {
            setFormError(null);
            setHireNote(null);
            setNewDraft(EMPTY_BOT_DRAFT);
            setEditing("new");
          }}
          onEnableSteward={() => void enableSteward()}
          enabling={enablingSteward}
          note={seedNote}
        />
      </SettingsCard>

      <SettingsCard
        title={t("bots.settings.listTitle")}
        description={t("bots.settings.listDescription")}
        action={
          editing === null ? (
            <Button
              variant="secondary"
              onClick={() => {
                setFormError(null);
                setHireNote(null);
                setNewDraft(EMPTY_BOT_DRAFT);
                setEditing("new");
              }}
            >
              <IconPlus size={14} />
              {t("bots.settings.add")}
            </Button>
          ) : null
        }
      >
        {error ? (
          <p className="bot-form-error" role="alert">
            {t("bots.settings.loadFailed", { reason: error })}
          </p>
        ) : null}
        {loading && bots.length === 0 ? (
          <p className="bot-form-note">{t("common.loading")}</p>
        ) : null}
        <div className="bot-list" role="list">
          {bots.map((bot) => {
            const name = bot.profile.name || bot.title;
            const status = botStatusView(bot.status);
            const armed = pendingDismiss === bot.sessionId;
            return (
              <div key={bot.sessionId} className="bot-list-row" role="listitem">
                <span className="sidebar-bot-avatar" aria-hidden>
                  {bot.profile.avatar?.trim() || botInitials(name)}
                </span>
                <div className="bot-list-copy">
                  <div className="bot-list-name">
                    <span>{name}</span>
                    <Badge>{t(status.labelKey)}</Badge>
                  </div>
                  <div className="bot-list-meta">
                    {/* An employee without a duty keeps the row readable: an
                        em dash says "not set" without claiming there are no
                        employees at all. */}
                    <span>{bot.profile.duty?.trim() || "—"}</span>
                    <span>{t("bots.settings.homeLocal")}</span>
                    <span>{t(`bots.settings.permission${permissionSuffix(bot.profile.permissionMode)}`)}</span>
                    <span>{definitionLabel(bot.profile.definition)}</span>
                    {/* The project decides whether this employee can read any
                        code, so it is a row fact, not a hidden setting. */}
                    <span
                      className={bot.projectPath ? undefined : "bot-list-meta-warning"}
                      title={bot.projectPath ?? undefined}
                    >
                      {botProjectLabel(bot.projectPath)}
                    </span>
                  </div>
                </div>
                <div className="bot-list-actions">
                  <SettingsToggle
                    checked={!bot.profile.observe}
                    label={t("bots.settings.observe")}
                    disabled={busy}
                    onChange={() => {
                      // The harness flips the consent gate; everything else on
                      // this row keeps its stored value.
                      void api
                        .updateBot({ sessionId: bot.sessionId, profile: { observe: !bot.profile.observe } })
                        .then(() => reload());
                    }}
                  />
                  <Button
                    variant="ghost"
                    aria-label={t("bots.settings.edit", { name })}
                    onClick={() => {
                      setFormError(null);
                      setHireNote(null);
                      setEditing(bot.sessionId);
                    }}
                  >
                    <IconPencil size={14} />
                  </Button>
                  {armed ? (
                    <div className="bot-dismiss-confirm" role="alertdialog" aria-label={t("bots.settings.dismissConfirmTitle", { name })}>
                      <div className="bot-dismiss-copy">
                        <strong>{t("bots.settings.dismissConfirmTitle", { name })}</strong>
                        <span>{t("bots.settings.dismissConfirmBody")}</span>
                      </div>
                      <Button variant="secondary" disabled={busy} onClick={() => setPendingDismiss(null)}>
                        {t("bots.settings.dismissCancel")}
                      </Button>
                      <Button variant="primary" disabled={busy} onClick={() => void dismiss(bot)}>
                        {t("bots.settings.dismissConfirm")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      aria-label={t("bots.settings.dismiss")}
                      onClick={() => setPendingDismiss(bot.sessionId)}
                    >
                      <IconTrash size={14} />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      {editing !== null ? (
        <BotFormCard
          key={editing === "new" ? `new:${newDraft.name}:${newDraft.definition}` : editing}
          initial={initialDraft}
          definitions={definitions}
          projects={projects}
          models={models.map((model) => ({ key: model.key, label: model.label }))}
          title={creating ? t("bots.settings.addTitle") : t("bots.settings.editTitle")}
          busy={busy}
          error={formError}
          note={creating ? hireNote : null}
          showModel={creating}
          onCancel={() => {
            setEditing(null);
            setFormError(null);
            setHireNote(null);
            setNewDraft(EMPTY_BOT_DRAFT);
          }}
          onSubmit={(profile, project) => void save(profile, project)}
        />
      ) : null}

      {bots.length > 0 ? (
        <SettingsCard
          title={t("bots.experience.title")}
          description={t("bots.experience.description")}
        >
          <EmployeeExperienceSection bots={bots} />
        </SettingsCard>
      ) : null}


    </div>
  );
}

function permissionSuffix(mode: BotProfileInput["permissionMode"]): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "accept-edits":
      return "AcceptEdits";
    default:
      // `inherit` is session-only and never stored on an employee profile.
      return "Ask";
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type { BotDraft };
export { hasSteward };