import { useTranslation } from "react-i18next";
import type { AppSettings, TranscriptDensity } from "@minih-agent/shared";
import {
  isTranscriptDensity,
  resolveTranscriptDensity,
} from "../../lib/transcript-density";
import { SettingsRow } from "../../features/settings/primitives";
import { SegmentedControl } from "../ui";

const DENSITY_OPTIONS: readonly { value: TranscriptDensity; key: string }[] = [
  { value: "compact", key: "settings.densityCompact" },
  { value: "standard", key: "settings.densityStandard" },
  { value: "detailed", key: "settings.densityDetailed" },
];

/**
 * How much of a turn's process the transcript shows.
 *
 * This is the one place the folded and flat presentations are chosen: the CLI
 * agents keep narration and step rows visible and hide only details, so that is
 * the default here too.
 */
export function TranscriptDensityRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const density = resolveTranscriptDensity(settings);
  return (
    <SettingsRow
      title={t("settings.transcriptDensity")}
      description={t("settings.transcriptDensityDesc")}
    >
      <SegmentedControl
        value={density}
        onChange={(value) => {
          if (!isTranscriptDensity(value) || value === density) return;
          void saveSettings({ transcriptDensity: value }).catch(() => undefined);
        }}
        options={DENSITY_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.key),
        }))}
        label={t("settings.transcriptDensity")}
      />
    </SettingsRow>
  );
}
