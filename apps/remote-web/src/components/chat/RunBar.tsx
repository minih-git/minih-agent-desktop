import { Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Chip, StatusDot } from "../ui/StatusDot.js";
import { Button } from "../ui/Button.js";
import type { TurnStatusDisplay } from "../../lib/session-format.js";

export interface RunBarProps {
  statusDisplay: TurnStatusDisplay | null;
  queuedCount?: number;
  stopping?: boolean;
  onStop: () => void;
}

export function RunBar({
  statusDisplay,
  queuedCount = 0,
  stopping = false,
  onStop,
}: RunBarProps) {
  const { t } = useTranslation();
  if (!statusDisplay) return null;

  return (
    <div
      role="status"
      className="flex min-h-[44px] items-center gap-2.5 border-b border-[var(--rm-separator)] bg-[var(--rm-bg-raised)] px-4 py-2"
    >
      <StatusDot status={statusDisplay.statusType} size="large" />
      <span className="text-[14px] font-semibold text-[var(--rm-text-primary)]">
        {t(statusDisplay.labelKey)}
      </span>

      {queuedCount > 0 ? (
        <Chip tone="neutral">
          {t("session.queuedCount", { count: queuedCount })}
        </Chip>
      ) : null}

      <div className="flex-1" />

      {statusDisplay.statusType === "running" ? (
        <Button
          variant="secondary"
          size="small"
          disabled={stopping}
          onClick={onStop}
          className="gap-1.5 px-2.5 font-medium"
        >
          <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          <span>{stopping ? t("session.stopping") : t("session.stop")}</span>
        </Button>
      ) : null}
    </div>
  );
}
