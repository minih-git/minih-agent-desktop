/**
 * AI — chat experience, execution and permissions, instructions and memory.
 *
 * The four AI pages are separate destinations, not one long page: the model
 * catalog deliberately stays its own category, and voice keeps its own card.
 */

import type { AppSettings, GlobalPermissionMode, ProviderPublic } from "@minih-agent/shared";
import { useTranslation } from "react-i18next";
import {
  FollowUpSuggestionModelRow,
  FollowUpSuggestionThinkingRow,
  FollowUpSuggestionToggleRow,
} from "../../../components/settings/FollowUpSuggestionRows";
import { LearnedMemoryCard } from "../../../components/settings/LearnedMemoryCard";
import {
  SessionTitleModelRow,
  SessionTitleThinkingRow,
  SessionTitleToggleRow,
} from "../../../components/settings/SessionTitleRows";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { ShowThinkingRow } from "../../../components/settings/ShowThinkingRow";
import { TranscriptDensityRow } from "../../../components/settings/TranscriptDensityRow";
import { SegmentedControl, SettingsToggle } from "../../../components/ui";
import { AgentInstructionsSection } from "../agent-sections";
import {
  CommandShellRow,
  ContextUsageDisplayRow,
  LargePasteThresholdRow,
  LinkOpenTargetRow,
  SettingsCard,
  SettingsRow,
} from "../primitives";

type SaveSettings = (patch: Partial<AppSettings>) => Promise<void>;

export function ChatExperiencePanel({
  settings,
  saveSettings,
  providers,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
  providers: ProviderPublic[];
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.chatBehavior")}>
        <SettingsRow title={t("settings.enterToSend")} description={t("settings.enterToSendDesc")}>
          <SettingsToggle
            checked={settings.enterToSend}
            label={t("settings.enterToSend")}
            onChange={() => void saveSettings({ enterToSend: !settings.enterToSend })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.smoothStreaming")}
          description={t("settings.smoothStreamingDesc")}
        >
          <SettingsToggle
            checked={settings.smoothStreaming !== false}
            label={t("settings.smoothStreaming")}
            onChange={() => void saveSettings({ smoothStreaming: !(settings.smoothStreaming !== false) })}
          />
        </SettingsRow>
        <ShowThinkingRow settings={settings} saveSettings={saveSettings} />
        <TranscriptDensityRow settings={settings} saveSettings={saveSettings} />
        <ContextUsageDisplayRow settings={settings} saveSettings={saveSettings} />
        <LinkOpenTargetRow settings={settings} saveSettings={saveSettings} />
        <LargePasteThresholdRow settings={settings} saveSettings={saveSettings} />
      </SettingsCard>

      <SettingsCard title={t("settings.sessionTitleCard")}>
        <SessionTitleToggleRow settings={settings} saveSettings={saveSettings} />
        <SessionTitleModelRow
          settings={settings}
          providers={providers}
          saveSettings={saveSettings}
        />
        <SessionTitleThinkingRow
          settings={settings}
          providers={providers}
          saveSettings={saveSettings}
        />
      </SettingsCard>

      <SettingsCard title={t("settings.followUpSuggestionCard")}>
        <FollowUpSuggestionToggleRow settings={settings} saveSettings={saveSettings} />
        <FollowUpSuggestionModelRow
          settings={settings}
          providers={providers}
          saveSettings={saveSettings}
        />
        <FollowUpSuggestionThinkingRow
          settings={settings}
          providers={providers}
          saveSettings={saveSettings}
        />
      </SettingsCard>
    </div>
  );
}

export function ExecutionPanel({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.permissions")}>
        <SettingsRow
          title={t("settings.permissionMode")}
          description={t("settings.permissionModeDesc")}
        >
          <SettingsMenuSelect
            className="settings-permission-select"
            label={t("settings.permissionMode")}
            value={settings.defaultPermissionMode ?? "ask"}
            onChange={(mode) =>
              void saveSettings({
                defaultPermissionMode: mode as GlobalPermissionMode,
              })
            }
            options={[
              { id: "ask", label: t("settings.permissionModeAsk") },
              {
                id: "accept-edits",
                label: t("settings.permissionModeAcceptEdits"),
              },
              { id: "auto", label: t("settings.permissionModeAuto") },
            ]}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("settings.executionTitle")}>
        <SettingsRow title={t("settings.mode")} description={t("settings.modeDesc")}>
          <SegmentedControl
            value={settings.defaultMode ?? "agent"}
            onChange={(value) => void saveSettings({ defaultMode: value })}
            options={[
              { value: "agent", label: t("settings.modeAgent") },
              { value: "plan", label: t("settings.modePlan") },
              { value: "goal", label: t("settings.modeGoal") },
            ]}
            label={t("settings.mode")}
            role="group"
          />
        </SettingsRow>
        <CommandShellRow settings={settings} saveSettings={saveSettings} />
        <SettingsRow
          title={t("settings.infiniteProviderRetry")}
          description={t("settings.infiniteProviderRetryDesc")}
        >
          <SettingsToggle
            checked={settings.infiniteProviderRetry === true}
            label={t("settings.infiniteProviderRetry")}
            onChange={() =>
              void saveSettings({ infiniteProviderRetry: settings.infiniteProviderRetry !== true })
            }
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

export function InstructionsMemoryPanel({
  settings,
  saveSettings,
  providers,
  onOpenMemoryManager,
}: {
  settings: AppSettings;
  saveSettings: SaveSettings;
  providers: ProviderPublic[];
  onOpenMemoryManager: () => void;
}) {
  return (
    <div className="settings-stack">
      <AgentInstructionsSection />
      <LearnedMemoryCard
        settings={settings}
        providers={providers}
        saveSettings={saveSettings}
        onOpenManager={onOpenMemoryManager}
      />
    </div>
  );
}
