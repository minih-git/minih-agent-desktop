import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginCredentialStatus } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { Button, Input, PasswordInput, Select } from "../ui";

type CredentialField = PluginCredentialStatus["fields"][number];

export type CredentialValues = Record<string, string>;

function localized(value: string | { en: string; "zh-CN": string }, locale: string): string {
  return typeof value === "string" ? value : value[locale.startsWith("zh") ? "zh-CN" : "en"];
}

/** The control a field renders with, by the same rule the host applies. */
function fieldControl(field: CredentialField): "text" | "password" | "select" {
  if (field.type) return field.type;
  return field.secret ? "password" : "text";
}

/**
 * The declared fields of one credential slot as inputs.
 *
 * Shared by the Settings sheet and the host-owned dialog a plugin can ask for, so
 * a slot is filled the same way whichever surface asked. Values live in the
 * caller's state and are cleared once they are saved.
 */
export function CredentialFieldsForm({
  fields,
  values,
  onChange,
  locale,
  disabled,
}: {
  fields: CredentialField[];
  values: CredentialValues;
  onChange: (key: string, value: string) => void;
  locale: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {fields.map((field) => {
        const label = localized(field.label, locale);
        const control = fieldControl(field);
        const value = values[field.key] ?? "";
        const common = {
          value,
          onChange: (
            event: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLSelectElement>,
          ) => onChange(field.key, event.target.value),
          autoComplete: "off",
          "aria-label": label,
          disabled,
        };
        return (
          <div className="plugin-credential-field" key={field.key}>
            <span>{label}</span>
            {control === "select" ? (
              <Select {...common}>
                <option value="" disabled>
                  {t("pluginCredentials.selectPlaceholder")}
                </option>
                {(field.options ?? []).map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : control === "password" ? (
              <PasswordInput
                {...common}
                showLabel={t("pluginCredentials.show")}
                hideLabel={t("pluginCredentials.hide")}
              />
            ) : (
              <Input {...common} />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Whether every declared field has a value, so a save button can stay disabled. */
export function valuesComplete(fields: CredentialField[], values: CredentialValues): boolean {
  return fields.every((field) => Boolean((values[field.key] ?? "").trim()));
}

/**
 * One slot's stored accounts. Only the label and the configured state are shown:
 * the host never hands a stored value to any surface, and this list is the whole
 * of what the user can see of an account they already saved.
 */
function InstanceList({
  slot,
  busy,
  onRemove,
}: {
  slot: PluginCredentialStatus;
  busy: boolean;
  onRemove: (instanceId: string) => void;
}) {
  const { t } = useTranslation();
  const instances = slot.instances ?? [];
  if (!instances.length) return <p>{t("pluginCredentials.noInstances")}</p>;
  return (
    <ul className="plugin-credential-instances">
      {instances.map((instance, index) => (
        <li className="plugin-credential-instance" key={instance.instanceId}>
          <span className="plugin-credential-instance-label">
            {instance.label || t("pluginCredentials.instanceFallback", { index: index + 1 })}
          </span>
          <span className="plugin-credential-instance-state">
            {t(instance.configured ? "pluginCredentials.configured" : "pluginCredentials.notConfigured")}
          </span>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onRemove(instance.instanceId)}
          >
            {t("pluginCredentials.remove")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** A slot that holds one value: the released form, unchanged. */
function SingleValueSlot({
  slot,
  pluginId,
  refresh,
}: {
  slot: PluginCredentialStatus;
  pluginId: string;
  refresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [values, setValues] = useState<CredentialValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locale = i18n.resolvedLanguage ?? "en";
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
        <strong>{localized(slot.title, locale)}</strong>
        <span>
          {slot.kind} · {t(slot.configured ? "pluginCredentials.configured" : "pluginCredentials.notConfigured")}
        </span>
      </div>
      {slot.lastUsedAt ? (
        <p>
          {t("pluginCredentials.lastUsed", {
            time: new Date(slot.lastUsedAt).toLocaleString(i18n.resolvedLanguage),
          })}
        </p>
      ) : null}
      <CredentialFieldsForm
        fields={slot.fields}
        values={values}
        onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
        locale={locale}
      />
      {error ? <p role="alert" className="plugins-settings-error">{error}</p> : null}
      <div className="plugin-credential-actions">
        <Button
          variant="primary"
          disabled={busy || !valuesComplete(slot.fields, values)}
          onClick={() => void save()}
        >
          {t("pluginCredentials.save")}
        </Button>
        <Button variant="secondary" disabled={busy || !slot.configured} onClick={() => void clear()}>
          {t("pluginCredentials.clear")}
        </Button>
      </div>
    </section>
  );
}

/**
 * A slot that holds several accounts (`multiple`): the stored ones, and a form
 * under an Add button. Removing one account asks the host to delete it, and the
 * host is what decides whether the slot may hold another.
 */
function MultiValueSlot({
  slot,
  pluginId,
  refresh,
}: {
  slot: PluginCredentialStatus;
  pluginId: string;
  refresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState<CredentialValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locale = i18n.resolvedLanguage ?? "en";
  const instances = slot.instances ?? [];
  const max = slot.max ?? instances.length;
  const full = instances.length >= max;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.setPluginCredential(pluginId, slot.id, values);
      setValues({});
      setAdding(false);
      try {
        await refresh();
      } catch {
        setError(t("pluginCredentials.loadFailed"));
      }
    } catch {
      setError(t("pluginCredentials.addFailed"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (instanceId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.clearPluginCredential(pluginId, slot.id, instanceId);
      try {
        await refresh();
      } catch {
        setError(t("pluginCredentials.loadFailed"));
      }
    } catch {
      setError(t("pluginCredentials.removeFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="plugin-credential-slot">
      <div className="plugin-credential-heading">
        <strong>{localized(slot.title, locale)}</strong>
        <span>
          {t("pluginCredentials.instanceCount", { count: instances.length, max })}
        </span>
      </div>
      <InstanceList slot={slot} busy={busy} onRemove={(instanceId) => void remove(instanceId)} />
      {error ? <p role="alert" className="plugins-settings-error">{error}</p> : null}
      {adding ? (
        <div className="plugin-credential-add">
          <CredentialFieldsForm
            fields={slot.fields}
            values={values}
            onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
            locale={locale}
            disabled={busy}
          />
          <div className="plugin-credential-actions">
            <Button
              variant="primary"
              disabled={busy || !valuesComplete(slot.fields, values)}
              onClick={() => void add()}
            >
              {t("pluginCredentials.save")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setValues({});
              }}
            >
              {t("pluginCredentials.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="plugin-credential-actions">
          <Button
            variant="secondary"
            disabled={busy || full}
            onClick={() => {
              setValues({});
              setAdding(true);
            }}
          >
            {t("pluginCredentials.add")}
          </Button>
          {full ? <p>{t("pluginCredentials.limitReached", { max })}</p> : null}
        </div>
      )}
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
    {slots?.map((slot) => (
      slot.multiple ? (
        <MultiValueSlot key={slot.id} slot={slot} pluginId={pluginId} refresh={refresh} />
      ) : (
        <SingleValueSlot key={slot.id} slot={slot} pluginId={pluginId} refresh={refresh} />
      )
    ))}
  </section>;
}