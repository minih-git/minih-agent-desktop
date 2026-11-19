import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginCredentialStatus } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button, Input, PasswordInput } from "../ui";

function localized(value: string | { en: string; "zh-CN": string }, locale: string): string {
  return typeof value === "string" ? value : value[locale.startsWith("zh") ? "zh-CN" : "en"];
}

function CredentialSlot({ slot, pluginId, refresh }: {
  slot: PluginCredentialStatus;
  pluginId: string;
  refresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setPluginCredential(pluginId, slot.id, values);
      setValues({});
      try {
        await refresh();
      } catch {
        setError(t("pluginCredentials.loadFailed"));
      }
    } catch {
      setError(t("pluginCredentials.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.clearPluginCredential(pluginId, slot.id);
      setValues({});
      try {
        await refresh();
      } catch {
        setError(t("pluginCredentials.loadFailed"));
      }
    } catch {
      setError(t("pluginCredentials.clearFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="plugin-credential-slot">
      <div className="plugin-credential-heading">
        <strong>{localized(slot.title, i18n.resolvedLanguage ?? "en")}</strong>
        <span>{slot.kind} · {t(slot.configured ? "pluginCredentials.configured" : "pluginCredentials.notConfigured")}</span>
      </div>
      {slot.lastUsedAt ? <p>{t("pluginCredentials.lastUsed", { time: new Date(slot.lastUsedAt).toLocaleString(i18n.resolvedLanguage) })}</p> : null}
      {slot.fields.map((field) => {
        const label = localized(field.label, i18n.resolvedLanguage ?? "en");
        const props = {
          value: values[field.key] ?? "",
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValues((current) => ({ ...current, [field.key]: event.target.value })),
          autoComplete: "off",
          "aria-label": label,
        };
        return <div className="plugin-credential-field" key={field.key}>
          <span>{label}</span>
          {field.secret ? <PasswordInput {...props} showLabel={t("pluginCredentials.show")} hideLabel={t("pluginCredentials.hide")} /> : <Input {...props} />}
        </div>;
      })}
      {error ? <p role="alert" className="plugins-settings-error">{error}</p> : null}
      <div className="plugin-credential-actions">
        <Button variant="primary" disabled={busy || slot.fields.some((field) => !values[field.key])} onClick={() => void save()}>{t("pluginCredentials.save")}</Button>
        <Button variant="secondary" disabled={busy || !slot.configured} onClick={() => void clear()}>{t("pluginCredentials.clear")}</Button>
      </div>
    </section>
  );
}

/** User-entered values are held only in local form state and cleared after saving. */
export function PluginCredentials({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation();
  const [slots, setSlots] = useState<PluginCredentialStatus[] | null>(null);
  const [error, setError] = useState(false);
  const refresh = async () => {
    const result = await api.getPluginCredentials(pluginId);
    setSlots(result.slots);
    setError(false);
  };
  useEffect(() => {
    let active = true;
    setSlots(null);
    setError(false);
    api.getPluginCredentials(pluginId).then(
      (result) => { if (active) setSlots(result.slots); },
      () => { if (active) setError(true); },
    );
    return () => { active = false; };
  }, [pluginId]);
  if (slots?.length === 0 && !error) return null;
  return <section className="plugin-credentials">
    <h3>{t("pluginCredentials.title")}</h3>
    <p>{t("pluginCredentials.hint")}</p>
    {error ? <p role="alert">{t("pluginCredentials.loadFailed")}</p> : null}
    {slots?.map((slot) => <CredentialSlot key={slot.id} slot={slot} pluginId={pluginId} refresh={refresh} />)}
  </section>;
}
