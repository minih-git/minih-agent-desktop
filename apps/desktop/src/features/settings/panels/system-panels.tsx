/**
 * 系统 — network, storage, and about & updates.
 *
 * Network and storage used to sit on the general page; they are system
 * concerns, and Info keeps the logs, feedback, update preference, and the
 * developer tools behind it.
 */
import { useTranslation } from "react-i18next";
import type { AppSettings, AppVersionInfo } from "@minih-agent/shared";
import { Button } from "../../../components/ui";
import { NetworkProxySection } from "../../../components/settings/NetworkProxySection";
import { api } from "../../../lib/api";
import { UpdatesRow } from "../agent-sections";
import { DeveloperSection } from "../developer-sections";
import { SettingsCard, SettingsRow } from "../primitives";
import { StorageSettingsSection } from "../StorageSettingsSection";

type SaveSettings = (patch: Partial<AppSettings>) => Promise<void>;

export function NetworkPanel({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
}) {
  return (
    <div className="settings-stack">
      <NetworkProxySection settings={settings} saveSettings={saveSettings} />
    </div>
  );
}

export function StoragePanel() {
  return (
    <div className="settings-stack">
      <StorageSettingsSection />
    </div>
  );
}

export function AboutPanel({
  settings,
  saveSettings,
  version,
}: {
  settings: AppSettings | null;
  saveSettings: SaveSettings;
  version?: AppVersionInfo;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <div className="settings-about-hero">
        <div className="settings-about-hero-name">
          {version?.name || "Minih-Agent-Desktop"}
        </div>
        <div className="settings-about-hero-version">
          {t("settings.aboutVersion", { version: version?.version ?? "" })}
        </div>
        <div className="settings-about-hero-meta">
          protocol {version?.protocolVersion} · host {version?.hostVersion}
        </div>
      </div>
      <UpdatesRow
        currentVersion={version?.version}
        settings={settings ?? null}
        saveSettings={saveSettings}
      />
      <SettingsCard>
        <SettingsRow title={t("settings.logs")}>
          <Button variant="secondary" onClick={() => void api.openLogs()}>
            {t("settings.openLogs")}
          </Button>
        </SettingsRow>
        <SettingsRow title={t("settings.feedback")} description={t("settings.feedbackDesc")}>
          <Button
            variant="secondary"
            onClick={() => void api.openFeedback().catch(() => undefined)}
          >
            {t("settings.openFeedback")}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {settings && <DeveloperSection settings={settings} saveSettings={saveSettings} />}
    </div>
  );
}
