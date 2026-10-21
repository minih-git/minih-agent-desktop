/** A launch-bound macOS preference, compared against the applied window state. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { SettingsRow } from "../../features/settings/primitives";
import { Badge, SettingsToggle } from "../ui";

export function MacosWindowTranslucencyRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const translucent = settings.macosWindowTranslucency !== false;
  const [applied, setApplied] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ operation: "read" | "save"; reason: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    void api.windowControl("getState").then((state) => {
      if (mounted && typeof state.macosWindowTranslucency === "boolean") {
        setApplied(state.macosWindowTranslucency);
      }
    }).catch((error: unknown) => {
      if (mounted) setError({ operation: "read", reason: error instanceof Error ? error.message : String(error) });
    });
    return () => { mounted = false; };
  }, []);

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({ macosWindowTranslucency: !translucent });
    } catch (error: unknown) {
      setError({ operation: "save", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsRow
      title={t("settings.windowTranslucency")}
      description={t("settings.windowTranslucencyDesc")}
      detail={error ? (
        <span role="alert">{t(error.operation === "read"
          ? "settings.windowTranslucencyReadError"
          : "settings.windowTranslucencySaveError", { reason: error.reason })}</span>
      ) : applied !== null && applied !== translucent ? (
        <Badge tone="warning">{t("settings.windowTranslucencyRestart")}</Badge>
      ) : undefined}
    >
      <SettingsToggle
        checked={translucent}
        busy={saving}
        label={t("settings.windowTranslucency")}
        onChange={() => void toggle()}
      />
    </SettingsRow>
  );
}
