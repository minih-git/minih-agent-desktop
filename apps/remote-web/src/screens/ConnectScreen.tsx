import { CircleHelp, Lock, Shield, Square, Ticket, User } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../components/ui/Button.js";
import { ListGroup } from "../components/ui/ListGroup.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { useAccountAvailability } from "../hooks/useAccountFlow.js";
import { gatewayOrigin } from "../lib/runtime.js";

function ValueRow({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-3.5 py-3 px-4 min-h-[56px]">
      <div className="flex-none w-9 h-9 rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)] flex items-center justify-center">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold text-[var(--rm-text-primary)] leading-tight">
          {title}
        </div>
        <div className="text-[13px] text-[var(--rm-text-muted)] leading-snug mt-0.5">
          {description}
        </div>
      </div>
    </div>
  );
}

export function ConnectScreen({
  onAddHost,
  onAddAccount,
}: {
  onAddHost: () => void;
  onAddAccount: () => void;
}) {
  const { t } = useTranslation();
  const accountMode = useAccountAvailability();

  let gatewayHost = "rc.hmini.org";
  try {
    if (gatewayOrigin) {
      gatewayHost = new URL(gatewayOrigin).host;
    } else if (typeof window !== "undefined" && window.location.host) {
      gatewayHost = window.location.host;
    }
  } catch {
    gatewayHost = gatewayOrigin || "rc.hmini.org";
  }

  return (
    <Screen>
      <ScreenContent hasDock className="pt-[max(20px,env(safe-area-inset-top))]">
        <div className="pt-8 pb-6 px-2 flex flex-col items-center text-center">
          <img
            className="w-12 h-12 rounded-[14px] block mb-4 shadow-[0_4px_12px_rgba(0,0,0,0.08)]"
            src="/icon.png"
            alt="Minih"
          />
          <h1 className="text-[26px] leading-[32px] font-bold text-[var(--rm-text-primary)] tracking-tight whitespace-pre-line">
            {t("connect.title")}
          </h1>
          <p className="mt-2 text-[14px] leading-[20px] text-[var(--rm-text-secondary)] max-w-[300px]">
            {t("connect.subtitle")}
          </p>
        </div>

        <ListGroup>
          <ValueRow
            icon={<Shield className="w-5 h-5" />}
            title={t("connect.feature.shield.title")}
            description={t("connect.feature.shield.desc")}
          />
          <ValueRow
            icon={<CircleHelp className="w-5 h-5" />}
            title={t("connect.feature.help.title")}
            description={t("connect.feature.help.desc")}
          />
          <ValueRow
            icon={<Square className="w-5 h-5" />}
            title={t("connect.feature.square.title")}
            description={t("connect.feature.square.desc")}
          />
        </ListGroup>
      </ScreenContent>

      <ScreenDock>
        <div className="flex flex-col gap-2.5">
          {accountMode === "checking" ? (
            <div className="flex flex-col gap-2.5">
              <Skeleton className="h-[52px] w-full rounded-[12px]" />
              <Skeleton className="h-[52px] w-full rounded-[12px]" />
            </div>
          ) : accountMode === "supported" ? (
            <>
              <Button
                variant="primary"
                size="large"
                className="w-full"
                onClick={onAddAccount}
              >
                <User className="w-5 h-5" />
                <span>{t("account.entry")}</span>
              </Button>
              <Button
                variant="secondary"
                size="large"
                className="w-full"
                onClick={onAddHost}
              >
                <Ticket className="w-5 h-5" />
                <span>{t("connect.useTicket")}</span>
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="large"
              className="w-full"
              onClick={onAddHost}
            >
              <Ticket className="w-5 h-5" />
              <span>{t("connect.useTicket")}</span>
            </Button>
          )}

          <p className="flex items-center justify-center gap-1.5 text-xs text-[var(--rm-text-muted)] mt-2">
            <Lock className="w-3.5 h-3.5 flex-none" />
            <span>{t("connect.viaGateway", { gateway: gatewayHost })}</span>
          </p>
        </div>
      </ScreenDock>
    </Screen>
  );
}
