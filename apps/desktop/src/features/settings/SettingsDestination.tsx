/**
 * One settings destination's body, plus the plugin theme page.
 *
 * The panel shell (search, categories, second level) stays in SettingsPage;
 * this file owns what a destination renders, so neither keeps growing with the
 * other's concerns.
 */
import type { AppSettings, AppVersionInfo, PluginScenicThemesDestinationMeta, ProviderPublic, ShortcutPlatform } from "@minih-agent/shared";
import type { TFunction } from "i18next";
import { Badge, Button } from "../../components/ui";
import { ModelsPage } from "../../components/settings/ModelConfigPage";
import { AccountsPage } from "../../components/settings/AccountsPage";
import { DevicesPage } from "../../components/settings/DevicesPage";
import { AccountsAdvancedPage } from "../../components/settings/AccountsAdvancedPage";
import { KeyboardShortcutsSection } from "../../components/settings/KeyboardShortcutsSection";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { AgentSkillsPage } from "../../components/settings/AgentSkillsPage";
import { AgentMcpPage } from "../../components/settings/AgentMcpPage";
import { AgentSubagentsPage } from "../../components/settings/AgentSubagentsPage";
import { PluginScenicThemesDestination } from "../../components/settings/PluginScenicThemesDestination";
import { ConfigSyncPage } from "../../components/settings/ConfigSyncPage";
import type { SettingsTabId } from "../../lib/settings-search";
import { AppearancePanel, HabitsPanel } from "./panels/general-panels";
import { ChatExperiencePanel, ExecutionPanel, InstructionsMemoryPanel } from "./panels/ai-panels";
import { AboutPanel, NetworkPanel, StoragePanel } from "./panels/system-panels";
import { VoiceSettingsSection } from "./voice/VoiceSettingsSection";

/** Destinations that read `AppSettings` and therefore need the recovery state. */
const SETTINGS_READING_TABS: ReadonlySet<string> = new Set([
  "general",
  "habits",
  "ai",
  "execution",
  "instructions",
  "shortcuts",
  "voice",
  "agent",
  "network",
  "about",
]);

export function SettingsDestination({
  t,
  tab,
  titleKey,
  badgeKey,
  tabHidden,
  activeExtension,
  extensions,
  settings,
  providers,
  version,
  platform,
  recoveringSettings,
  settingsRecoveryFailed,
  recoverSettings,
  saveSettings,
  selectPluginTheme,
  onOpenExtension,
  onOpenMemoryManager,
}: {
  t: TFunction;
  tab: SettingsTabId;
  titleKey: string;
  badgeKey?: string;
  tabHidden: boolean;
  activeExtension: PluginScenicThemesDestinationMeta | null;
  extensions: PluginScenicThemesDestinationMeta[];
  settings: AppSettings | undefined;
  providers: ProviderPublic[];
  version?: AppVersionInfo;
  platform: ShortcutPlatform;
  recoveringSettings: boolean;
  settingsRecoveryFailed: boolean;
  recoverSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  selectPluginTheme: (theme: string) => Promise<void>;
  onOpenExtension: (extension: PluginScenicThemesDestinationMeta) => void;
  onOpenMemoryManager: () => void;
}) {
  const tabNeedsSettings = SETTINGS_READING_TABS.has(tab);

  return (
    <>
    <h2 className="settings-section-title">
      <span>{activeExtension?.label ?? t(titleKey)}</span>
      {activeExtension ? (
        <Badge>{t("settings.category.general")}</Badge>
      ) : badgeKey ? (
        <Badge tone="warning">{t(badgeKey)}</Badge>
      ) : null}
    </h2>

    {activeExtension ? (
      <PluginScenicThemesDestination
        destination={activeExtension}
        selectTheme={selectPluginTheme}
      />
    ) : (
      <>
        {tabNeedsSettings && !settings ? (
          <div className="settings-recovery" role="status" aria-live="polite">
            {recoveringSettings ? (
              <>
                <span className="route-pending-indicator" aria-hidden />
                <span>{t("common.loading")}</span>
              </>
            ) : settingsRecoveryFailed ? (
              <>
                <span>{t("errors.HOST_UNAVAILABLE")}</span>
                <Button variant="secondary" onClick={() => void recoverSettings()}>
                  {t("errors.action.retry")}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {tab === "general" && settings && (
          <AppearancePanel
            settings={settings}
            saveSettings={saveSettings}
            platform={platform}
            extensions={extensions}
            onOpenExtension={onOpenExtension}
          />
        )}

        {tab === "habits" && settings && (
          <HabitsPanel
            settings={settings}
            saveSettings={saveSettings}
            platform={platform}
          />
        )}

        {tab === "shortcuts" && settings && (
          <div className="settings-stack">
            <KeyboardShortcutsSection
              settings={settings}
              platform={platform}
              saveSettings={saveSettings}
            />
          </div>
        )}

        {tab === "ai" && settings && (
          <ChatExperiencePanel
            settings={settings}
            saveSettings={saveSettings}
            providers={providers}
          />
        )}

        {tab === "execution" && settings && (
          <ExecutionPanel settings={settings} saveSettings={saveSettings} />
        )}

        {tab === "instructions" && settings && (
          <InstructionsMemoryPanel
            settings={settings}
            saveSettings={saveSettings}
            providers={providers}
            onOpenMemoryManager={onOpenMemoryManager}
          />
        )}

        {tab === "voice" && !tabHidden && settings && (
          <VoiceSettingsSection
            t={t}
            settings={settings}
            saveSettings={saveSettings}
          />
        )}

        {tab === "agent" && <ModelsPage />}
        {tab === "skills" && <AgentSkillsPage />}
        {tab === "mcp" && <AgentMcpPage />}
        {tab === "subagents" && <AgentSubagentsPage />}

        {tab === "accounts" && <AccountsPage />}
        {tab === "devices" && <DevicesPage />}
        {tab === "sync" && !tabHidden && <ConfigSyncPage />}
        {tab === "advanced" && !tabHidden && <AccountsAdvancedPage />}

        {tab === "projects" && <ProjectsPage />}

        {tab === "network" && settings && (
          <NetworkPanel settings={settings} saveSettings={saveSettings} />
        )}
        {tab === "storage" && <StoragePanel />}
        {tab === "about" && (
          <AboutPanel
            settings={settings ?? null}
            saveSettings={saveSettings}
            version={version}
          />
        )}
      </>
    )}
    </>
  );
}
