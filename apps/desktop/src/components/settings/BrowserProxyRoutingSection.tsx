import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@minih-agent/shared";
import { emptyBrowserProxyRouting } from "@minih-agent/shared";
import { Button, SettingsToggle } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { useAppStore } from "../../stores/app-store";
import { BrowserProxyRoutingDialog } from "./BrowserProxyRoutingDialog";

export function BrowserProxyRoutingSection({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const saved = useMemo(
    () => settings.browserProxyRouting ?? emptyBrowserProxyRouting(),
    [settings.browserProxyRouting],
  );
  const toggle = async () => {
    setBusy(true);
    try {
      await saveSettings({ browserProxyRouting: { ...saved, enabled: !saved.enabled } });
    } catch (error) {
      showToast(t("settings.browserProxyApplyFailed", {
        reason: error instanceof Error ? error.message : String(error),
      }), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsCard title={t("settings.browserProxyRouting")}>
        <SettingsRow
          title={t("settings.browserProxyRouting")}
          description={t("settings.browserProxyRoutingDesc")}
          detail={t("settings.browserProxySummary", {
            profiles: saved.profiles.length, rules: saved.rules.length,
          })}
        >
          <div className="settings-routing-controls">
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              {t("settings.browserProxyConfigure")}
            </Button>
            <SettingsToggle checked={saved.enabled} busy={busy}
              label={t("settings.browserProxyRouting")} onChange={() => void toggle()} />
          </div>
        </SettingsRow>
      </SettingsCard>
      {open ? <BrowserProxyRoutingDialog saved={saved} saveSettings={saveSettings}
        onClose={() => setOpen(false)} /> : null}
    </>
  );
}
