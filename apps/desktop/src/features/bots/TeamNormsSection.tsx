import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_TEAM_NORMS_CHARS,
  MAX_TEAM_NORM_SECTION_CHARS,
  TEAM_NORM_SECTIONS,
  type TeamNormSection,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button } from "../../components/ui";

type NormsForm = Record<TeamNormSection, string>;

const EMPTY: NormsForm = { communication: "", scope: "", delivery: "" };

const SECTION_KEYS: Record<TeamNormSection, { label: string; hint: string; placeholder: string }> = {
  communication: {
    label: "bots.norms.communication",
    hint: "bots.norms.communicationHint",
    placeholder: "bots.norms.communicationPlaceholder",
  },
  scope: {
    label: "bots.norms.scope",
    hint: "bots.norms.scopeHint",
    placeholder: "bots.norms.scopePlaceholder",
  },
  delivery: {
    label: "bots.norms.delivery",
    hint: "bots.norms.deliveryHint",
    placeholder: "bots.norms.deliveryPlaceholder",
  },
};

function totalOf(norms: NormsForm): number {
  return TEAM_NORM_SECTIONS.reduce((sum, key) => sum + norms[key].trim().length, 0);
}

/**
 * The team norms: the working rules every employee follows (employee mode 0.5
 * slice 6).
 *
 * Three sections because that is how a person states a working agreement —
 * communication, scope, delivery — and because a single blob gives neither the
 * page nor the prompt anything to point at. The initial value is **empty**: the
 * placeholders show what a rule might look like, and nothing is written for the
 * person. Saving is explicit, and the counters say how much room is left before
 * the host refuses the write.
 *
 * The note under the fields is the same boundary the prompt states: these are
 * team rules, and they cannot widen a permission or override a safety rule.
 */
export function TeamNormsSection() {
  const { t } = useTranslation();
  const [norms, setNorms] = useState<NormsForm>(EMPTY);
  const [saved, setSaved] = useState<string>(JSON.stringify(EMPTY));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .getTeamNorms()
      .then((view) => {
        if (!live) return;
        const loaded: NormsForm = {
          communication: view?.norms?.communication ?? "",
          scope: view?.norms?.scope ?? "",
          delivery: view?.norms?.delivery ?? "",
        };
        setNorms(loaded);
        setSaved(JSON.stringify(loaded));
      })
      // A read that failed leaves the fields empty and says so on save: an
      // empty editor must not look like "this team has no rules".
      .catch((cause) => {
        if (live) setError(t("bots.norms.loadFailed", { reason: reasonOf(cause) }));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [t]);

  const dirty = JSON.stringify(norms) !== saved;
  const total = totalOf(norms);
  const tooLong =
    TEAM_NORM_SECTIONS.some((key) => norms[key].trim().length > MAX_TEAM_NORM_SECTION_CHARS) ||
    total > MAX_TEAM_NORMS_CHARS;

  const save = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const view = await api.setTeamNorms({
        communication: norms.communication,
        scope: norms.scope,
        delivery: norms.delivery,
      });
      const stored: NormsForm = {
        communication: view?.norms?.communication ?? "",
        scope: view?.norms?.scope ?? "",
        delivery: view?.norms?.delivery ?? "",
      };
      setNorms(stored);
      setSaved(JSON.stringify(stored));
      setNote(
        TEAM_NORM_SECTIONS.every((key) => !stored[key].trim())
          ? t("bots.norms.cleared")
          : t("bots.norms.saved"),
      );
    } catch (cause) {
      setError(t("bots.norms.saveFailed", { reason: reasonOf(cause) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bot-norms">
      {loading ? <p className="bot-form-note">{t("common.loading")}</p> : null}
      {TEAM_NORM_SECTIONS.map((key) => {
        const keys = SECTION_KEYS[key];
        const used = norms[key].trim().length;
        return (
          <div className="bot-norms-field" key={key}>
            <div className="bot-norms-label">
              <span>{t(keys.label)}</span>
              <span className={used > MAX_TEAM_NORM_SECTION_CHARS ? "bot-form-error" : "bot-form-note"}>
                {t("bots.norms.sectionCount", { used, max: MAX_TEAM_NORM_SECTION_CHARS })}
              </span>
            </div>
            <p className="bot-form-note">{t(keys.hint)}</p>
            <textarea
              className="bot-norms-input"
              aria-label={t(keys.label)}
              value={norms[key]}
              rows={3}
              maxLength={MAX_TEAM_NORM_SECTION_CHARS}
              placeholder={t(keys.placeholder)}
              onChange={(event) => {
                setNote(null);
                setNorms({ ...norms, [key]: event.target.value });
              }}
            />
          </div>
        );
      })}
      <p className="bot-form-note" role={tooLong ? "alert" : undefined}>
        {t("bots.norms.totalCount", { used: total, max: MAX_TEAM_NORMS_CHARS })}
      </p>
      <p className="bot-form-note">{t("bots.norms.boundary")}</p>
      {error ? (
        <p className="bot-form-error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="bot-form-note" role="status">
          {note}
        </p>
      ) : null}
      <div className="bot-form-actions">
        <Button
          variant="primary"
          disabled={busy || !dirty || tooLong || loading}
          onClick={() => void save()}
        >
          {busy ? t("bots.norms.saving") : t("bots.norms.save")}
        </Button>
      </div>
    </div>
  );
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}