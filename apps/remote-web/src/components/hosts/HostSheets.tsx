import { RefreshCw, Smartphone, Ticket, Trash2, User } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { HostDisplayStatusKind } from "../../lib/host-display.js";
import type { HostRegistryEntry } from "../../lib/host-registry.js";
import { Button } from "../ui/Button.js";
import { Sheet } from "../ui/Sheet.js";

export interface ConnectSheetProps {
  open: boolean;
  accountSupported: boolean;
  onClose: () => void;
  onSelectAccount: () => void;
  onSelectPair: () => void;
}

export function ConnectSheet({
  open,
  accountSupported,
  onClose,
  onSelectAccount,
  onSelectPair,
}: ConnectSheetProps) {
  const { t } = useTranslation();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("hosts.sheet.connectTitle")}
      description={t("hosts.sheet.connectMsg")}
    >
      <div className="space-y-2 pt-2">
        {accountSupported ? (
          <button
            type="button"
            onClick={() => {
              onClose();
              onSelectAccount();
            }}
            className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-accent)]">
              <User className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold leading-[20px] text-[var(--rm-text-primary)]">
                {t("hosts.sheet.accountTitle")}
              </div>
              <div className="text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                {t("hosts.sheet.accountDesc")}
              </div>
            </div>
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => {
            onClose();
            onSelectPair();
          }}
          className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-accent)]">
            <Ticket className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold leading-[20px] text-[var(--rm-text-primary)]">
              {t("hosts.sheet.ticketTitle")}
            </div>
            <div className="text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("hosts.sheet.ticketDesc")}
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

export interface HostActionSheetProps {
  open: boolean;
  entry: HostRegistryEntry | null;
  statusKind?: HostDisplayStatusKind;
  onClose: () => void;
  onRefresh: () => void;
  onAskAgain: () => void;
  onForget: () => void;
}

export function HostActionSheet({
  open,
  entry,
  statusKind,
  onClose,
  onRefresh,
  onAskAgain,
  onForget,
}: HostActionSheetProps) {
  const { t } = useTranslation();
  if (!entry) return null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={entry.label}
      description={t(`hosts.status.${statusKind ?? "checking"}`)}
    >
      <div className="space-y-2 pt-2">
        <button
          type="button"
          onClick={() => {
            onClose();
            onRefresh();
          }}
          className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]">
            <RefreshCw className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1 text-[15px] font-semibold text-[var(--rm-text-primary)]">
            {t("hosts.sheet.refresh")}
          </div>
        </button>

        {statusKind === "unaccepted" ? (
          <button
            type="button"
            onClick={() => {
              onClose();
              onAskAgain();
            }}
            className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]">
              <Smartphone className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-[var(--rm-text-primary)]">
                {t("hosts.sheet.askAgain")}
              </div>
              <div className="text-[13px] text-[var(--rm-text-muted)]">
                {t("hosts.sheet.askAgainDesc")}
              </div>
            </div>
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => {
            onClose();
            onForget();
          }}
          className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-error)]">
            <Trash2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-[var(--rm-error)]">
              {t("hosts.sheet.forget")}
            </div>
            <div className="text-[13px] text-[var(--rm-text-muted)]">
              {t("hosts.sheet.forgetDesc")}
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

export interface ForgetConfirmSheetProps {
  open: boolean;
  entry: HostRegistryEntry | null;
  onClose: () => void;
  onConfirmForget: () => void;
}

export function ForgetConfirmSheet({
  open,
  entry,
  onClose,
  onConfirmForget,
}: ForgetConfirmSheetProps) {
  const { t } = useTranslation();
  if (!entry) return null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("hosts.sheet.forgetTitle", { label: entry.label })}
      description={t("hosts.sheet.forgetMsg")}
    >
      <div className="space-y-3 pt-3">
        <Button
          variant="destructive-filled"
          size="large"
          onClick={() => {
            onClose();
            onConfirmForget();
          }}
        >
          {t("hosts.sheet.forgetConfirmBtn")}
        </Button>
        <Button variant="plain" size="large" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </Sheet>
  );
}
