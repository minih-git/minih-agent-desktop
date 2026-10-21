import { Check, Globe, RefreshCw, Smartphone, Ticket, Trash2, User } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { normalizeUserGatewayOrigin } from "../../lib/gateway-origin.js";
import type { HostDisplayStatusKind } from "../../lib/host-display.js";
import type { HostRegistryEntry } from "../../lib/host-registry.js";
import {
  defaultGatewayOrigin,
  gatewayOrigin,
  getSavedGatewayOrigins,
  removeSavedGatewayOrigin,
  switchGatewayOrigin,
} from "../../lib/runtime.js";
import { Button } from "../ui/Button.js";
import { Sheet } from "../ui/Sheet.js";

export interface ConnectSheetProps {
  open: boolean;
  accountSupported: boolean;
  onClose: () => void;
  onSelectAccount: () => void;
  onSelectPair: () => void;
  onSelectGateway?: () => void;
}

export function ConnectSheet({
  open,
  accountSupported,
  onClose,
  onSelectAccount,
  onSelectPair,
  onSelectGateway,
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

        {onSelectGateway ? (
          <button
            type="button"
            onClick={() => {
              onClose();
              onSelectGateway();
            }}
            className="flex w-full items-center gap-3.5 rounded-[12px] bg-[var(--rm-bg-surface)] p-3.5 text-left shadow-[inset_0_0_0_1px_var(--rm-separator)] active:opacity-70"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]">
              <Globe className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold leading-[20px] text-[var(--rm-text-primary)]">
                切换网关环境
              </div>
              <div className="truncate font-mono text-[12px] leading-[18px] text-[var(--rm-text-muted)]">
                当前：{gatewayOrigin || "默认"}
              </div>
            </div>
          </button>
        ) : null}

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

export function GatewaySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState(gatewayOrigin);
  const [saved, setSaved] = useState<string[]>(() => getSavedGatewayOrigins());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setInput(gatewayOrigin);
      setSaved(getSavedGatewayOrigins());
      setError(null);
    }
  }, [open]);

  const handleSave = () => {
    const normalized = normalizeUserGatewayOrigin(input);
    if (!normalized) {
      setError("请输入有效的网关地址（如 https://rc.hmini.org）");
      return;
    }
    onClose();
    switchGatewayOrigin(normalized);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="切换网关环境"
      description="支持配置多套远程网关地址，每个网关各自保存已连接的电脑与凭证，可随时一键切换。"
    >
      <div className="space-y-3 pt-2">
        {saved.length > 0 ? (
          <div className="space-y-1.5">
            <div className="px-1 text-[12px] font-medium text-[var(--rm-text-muted)]">
              已保存的网关
            </div>
            <div className="space-y-1.5">
              {saved.map((origin) => {
                const isCurrent = origin === gatewayOrigin;
                const isDefault = origin === defaultGatewayOrigin;
                return (
                  <div
                    key={origin}
                    className={`flex items-center gap-2 rounded-[12px] p-2.5 pl-3 shadow-[inset_0_0_0_1px_var(--rm-separator)] ${
                      isCurrent ? "bg-[var(--rm-bg-inset)]" : "bg-[var(--rm-bg-surface)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!isCurrent) {
                          onClose();
                          switchGatewayOrigin(origin);
                        }
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left active:opacity-70"
                    >
                      <Globe className="h-4 w-4 shrink-0 text-[var(--rm-accent)]" aria-hidden="true" />
                      <span className="truncate font-mono text-[13px] font-medium text-[var(--rm-text-primary)]">
                        {origin}
                      </span>
                      {isDefault ? (
                        <span className="shrink-0 rounded-full bg-[var(--rm-bg-surface)] px-2 py-0.5 text-[11px] text-[var(--rm-text-muted)] ring-1 ring-[var(--rm-separator)]">
                          默认
                        </span>
                      ) : null}
                    </button>
                    {isCurrent ? (
                      <Check className="mr-1 h-4 w-4 shrink-0 text-[var(--rm-accent)]" aria-hidden="true" />
                    ) : !isDefault ? (
                      <button
                        type="button"
                        onClick={() => {
                          removeSavedGatewayOrigin(origin);
                          setSaved(getSavedGatewayOrigins());
                        }}
                        aria-label="删除网关"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--rm-text-muted)] active:opacity-60"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5 pt-1">
          <label
            htmlFor="gateway-origin-input"
            className="block px-1 text-[12px] font-medium text-[var(--rm-text-muted)]"
          >
            输入新网关地址
          </label>
          <input
            id="gateway-origin-input"
            type="url"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            placeholder="https://rc.hmini.org"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-[12px] border border-[var(--rm-separator)] bg-[var(--rm-bg-surface)] px-3.5 py-2.5 font-mono text-[14px] text-[var(--rm-text-primary)] placeholder-[var(--rm-text-faint)] outline-none focus:border-[var(--rm-accent)]"
          />
          {error ? (
            <p className="px-1 text-[12px] text-[var(--rm-error)]">{error}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <Button variant="primary" size="large" onClick={handleSave}>
            保存并切换网关
          </Button>
          {defaultGatewayOrigin && gatewayOrigin !== defaultGatewayOrigin ? (
            <Button
              variant="secondary"
              size="large"
              onClick={() => {
                onClose();
                switchGatewayOrigin(defaultGatewayOrigin);
              }}
            >
              恢复默认（{defaultGatewayOrigin}）
            </Button>
          ) : null}
          <Button variant="plain" size="large" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
