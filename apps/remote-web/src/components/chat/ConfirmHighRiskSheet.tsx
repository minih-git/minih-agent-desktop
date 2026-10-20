import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button.js";
import { Sheet } from "../ui/Sheet.js";

export interface ConfirmHighRiskSheetProps {
  open: boolean;
  hostLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmHighRiskSheet({
  open,
  hostLabel,
  onClose,
  onConfirm,
}: ConfirmHighRiskSheetProps) {
  const { t } = useTranslation();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("session.sheet.confirmHighRiskTitle")}
      description={t("session.sheet.confirmHighRiskMsg", { host: hostLabel })}
    >
      <div className="space-y-3 pt-3">
        <Button
          variant="destructive-filled"
          size="large"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {t("session.sheet.confirmHighRiskBtn")}
        </Button>
        <Button variant="plain" size="large" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </Sheet>
  );
}
