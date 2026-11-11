import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BotListItem, BotProfileInput } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Badge, Button, SettingsToggle } from "../../components/ui";
import { SettingsCard } from "../settings/primitives";
import { IconPencil, IconPlus, IconTrash } from "../../components/icons";
import { botInitials, botStatusView } from "./bot-status";
import { EMPTY_BOT_DRAFT, draftFromBot, type BotDraft } from "./bot-draft";
import { useBots } from "./use-bots";
import { BotFormCard } from "./BotFormCard";
import { useBotDefinitions } from "./use-bot-definitions";

/**
 * Settings → Employees (ADR bot-sessions-and-steward §5).
 *
 * The page never seeds on mount: creating four sessions because someone opened
 * a settings page is exactly the surprise `bot.seedDefaults` is explicit about.
 * The button is highlighted only while there is nothing to manage, because then
 * the crew is the useful starting point rather than a bulk action.
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
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDismiss, setPendingDismiss] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedNote, setSeedNote] = useState<string | null>(null);

  const editingBot = editing && editing !== "new" ? bots.find((bot) => bot.sessionId === editing) : undefined;

  const save = async (profile: BotProfileInput) => {
    setBusy(true);
    setFormError(null);
    try {
      if (editing === "new") {
        await api.createBot({ profile });
      } else if (editing) {
        await api.updateBot({ sessionId: editing, profile });
      }
      setEditing(null);
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

  const seed = async () => {
    setSeeding(true);
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
      setSeeding(false);
    }
  };

  const definitionLabel = (handle: string | undefined) =>
    handle ? (definitions.find((item) => item.id === handle)?.label ?? handle) : t("bots.settings.definitionNone");

  return (
    <div className="settings-stack bot-settings">
      {bots.length === 0 ? (
        <SettingsCard title={t("bots.settings.seed")} description={t("bots.settings.seedHint")}>
          <div className="bot-seed-row">
            <p className="bot-form-note">{t("bots.settings.empty")}</p>
            <Button variant="primary" disabled={seeding} onClick={() => void seed()}>
              {t("bots.settings.seed")}
            </Button>
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard
        title={t("bots.settings.listTitle")}
        description={t("bots.settings.listDescription")}
        action={
          editing === null ? (
            <Button
              variant="secondary"
              onClick={() => {
                setFormError(null);
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
          key={editing}
          initial={editing === "new" || !editingBot ? EMPTY_BOT_DRAFT : draftFromBot(editingBot)}
          definitions={definitions}
          title={editing === "new" ? t("bots.settings.addTitle") : t("bots.settings.editTitle")}
          busy={busy}
          error={formError}
          onCancel={() => {
            setEditing(null);
            setFormError(null);
          }}
          onSubmit={(profile) => void save(profile)}
        />
      ) : null}

      {bots.length > 0 ? (
        <SettingsCard title={t("bots.settings.seed")} description={t("bots.settings.seedHint")}>
          <div className="bot-seed-row">
            <Button variant="secondary" disabled={seeding} onClick={() => void seed()}>
              {t("bots.settings.seed")}
            </Button>
          </div>
        </SettingsCard>
      ) : null}

      {seedNote ? (
        <p className="bot-form-note" role="status">
          {seedNote}
        </p>
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
