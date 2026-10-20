/**
 * The last-resort screen when the client cannot start at all (PR-5).
 * Reskinned with Screen and ResultState for Stage 1.
 */
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ResultState, Screen, ScreenContent } from "./ui/index.js";

export function BootFailure({ reason }: { reason: string }) {
  const { t } = useTranslation();
  return (
    <Screen>
      <ScreenContent className="flex items-center justify-center">
        <ResultState
          status="error"
          icon={
            <div className="grid h-[72px] w-[72px] place-items-center rounded-full bg-[color-mix(in_srgb,var(--rm-error)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-error)]">
              <AlertCircle className="h-10 w-10 stroke-[2]" aria-hidden="true" />
            </div>
          }
          title={t("boot.failedTitle")}
          description={t("boot.failed", { reason })}
        />
      </ScreenContent>
    </Screen>
  );
}
