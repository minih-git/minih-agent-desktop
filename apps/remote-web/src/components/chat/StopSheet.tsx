import { Pause, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button.js";
import { Sheet } from "../ui/Sheet.js";

export interface StopSheetProps {
  open: boolean;
  onClose: () => void;
  onStopGraceful: () => void;
  onStopInterrupt: () => void;
}

export function StopSheet({
  open,
  onClose,
  onStopGraceful,
  onStopInterrupt,
}: StopSheetProps) {
  const { t } = useTranslation();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("session.stopSheet.title")}
      description={t("session.stopSheet.msg")}
    >
      <div className="space-y-2 pt-2">
        <button
          type="button"
          onClick={() => {
            onClose();
            onStopGraceful();
          }}
          className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-primary)]">
            <Pause className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-[20px] text-[var(--rm-text-primary)]">
              {t("session.stopSheet.afterStepTitle")}
            </div>
            <div className="text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("session.stopSheet.afterStepDesc")}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            onClose();
            onStopInterrupt();
          }}
          className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-error)]">
            <Square className="h-5 w-5 fill-current" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-[20px] text-[var(--rm-error)]">
              {t("session.stopSheet.nowTitle")}
            </div>
            <div className="text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("session.stopSheet.nowDesc")}
            </div>
          </div>
        </button>

        <div className="pt-2">
          <Button variant="plain" size="large" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
