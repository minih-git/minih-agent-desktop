/**
 * S4 My computers screen.
 *
 * Implements S4 My Computers per docs/spec/04-ux/13-remote-mobile-client.md §8.5
 * and apps/remote-web/design/prototype/index.html.
 */
import { Globe, Lock, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { HostRow } from "../components/hosts/HostRow.js";
import {
  ConnectSheet,
  ForgetConfirmSheet,
  GatewaySheet,
  HostActionSheet,
} from "../components/hosts/HostSheets.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Toast } from "../components/ui/Toast.js";
import { useAccountAvailability } from "../hooks/useAccountFlow.js";
import { forgetHost } from "../lib/forget.js";
import type { HostDisplayStatusKind } from "../lib/host-display.js";
import type { HostRegistryEntry } from "../lib/host-registry.js";
import {
  credentialPort,
  gatewayOrigin,
  hostRegistry,
  isNativeApp,
} from "../lib/runtime.js";

export function HostsScreen({
  hosts,
  onOpenHost,
  onAddHost,
  onAddAccount,
}: {
  hosts: HostRegistryEntry[];
  onOpenHost: (entry: HostRegistryEntry) => void;
  onAddHost: () => void;
  onAddAccount: () => void;
}) {
  const { t } = useTranslation();
  const accountMode = useAccountAvailability();

  const [expandedHostId, setExpandedHostId] = useState<string | null>(null);
  const [selectedHost, setSelectedHost] = useState<HostRegistryEntry | null>(null);
  const [selectedStatusKind, setSelectedStatusKind] = useState<HostDisplayStatusKind | undefined>(
    undefined,
  );
  const [selectedRefresh, setSelectedRefresh] = useState<(() => void) | null>(null);
  const [activeSheet, setActiveSheet] = useState<"connect" | "hostAction" | "forget" | "gateway" | null>(
    null,
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Background to foreground re-probe per §8.5 & §9
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        setRefreshKey((k) => k + 1);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const handleOpenMore = (
    entry: HostRegistryEntry,
    statusKind: HostDisplayStatusKind,
    refreshFn: () => void,
  ) => {
    setSelectedHost(entry);
    setSelectedStatusKind(statusKind);
    setSelectedRefresh(() => refreshFn);
    setActiveSheet("hostAction");
  };

  const handleConfirmForget = async () => {
    if (!selectedHost) return;
    const target = selectedHost;
    setActiveSheet(null);
    try {
      await forgetHost(target.hostId, {
        registry: hostRegistry,
        credentialPort,
        ...(isNativeApp ? { push: { gatewayOrigin } } : {}),
      });
      setToastMessage(t("hosts.sheet.forgetConfirmBtn"));
      setTimeout(() => setToastMessage(null), 2500);
    } catch {
      // Handled via state or UI if needed
    }
  };

  return (
    <Screen>
      <NavBar
        title={t("hosts.title")}
        trailing={
          <Button
            variant="plain"
            size="icon"
            aria-label={t("hosts.add")}
            onClick={() => setActiveSheet("connect")}
          >
            <Plus className="h-6 w-6 stroke-[2]" aria-hidden="true" />
          </Button>
        }
      />

      <ScreenContent className="pt-2 space-y-3">
        <SectionHeader
          title={t("hosts.title")}
          action={
            hosts.length > 0 ? (
              <span className="text-[var(--rm-text-muted)]">{hosts.length}</span>
            ) : undefined
          }
        />

        {hosts.length === 0 ? (
          <Callout tone="neutral">
            {t("hosts.empty")}
          </Callout>
        ) : (
          <div key={refreshKey} className="space-y-3">
            {hosts.map((entry) => (
              <HostRow
                key={entry.hostId}
                entry={entry}
                isExpanded={expandedHostId === entry.hostId}
                onToggleExpand={() =>
                  setExpandedHostId((prev) => (prev === entry.hostId ? null : entry.hostId))
                }
                onOpen={() => onOpenHost(entry)}
                onOpenMore={(statusKind, refreshFn) =>
                  handleOpenMore(entry, statusKind, refreshFn)
                }
                onAskAgain={onAddAccount}
                onForgetAndPair={() => {
                  setSelectedHost(entry);
                  setActiveSheet("forget");
                }}
              />
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-1 pt-2 pb-6 text-[12px] leading-[16px] text-[var(--rm-text-muted)]">
          <div className="flex min-w-0 items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {isNativeApp
                ? t("hosts.footerStorageNative", { gateway: gatewayOrigin })
                : t("hosts.footerStorageWeb", { gateway: gatewayOrigin })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setActiveSheet("gateway")}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--rm-bg-surface)] px-2.5 py-1 text-[12px] font-medium text-[var(--rm-link)] ring-1 ring-[var(--rm-separator)] active:bg-[var(--rm-bg-inset)]"
          >
            <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            <span>切换网关</span>
          </button>
        </div>
      </ScreenContent>

      {/* Connect sheet (+) */}
      <ConnectSheet
        open={activeSheet === "connect"}
        accountSupported={accountMode === "supported"}
        onClose={() => setActiveSheet(null)}
        onSelectAccount={onAddAccount}
        onSelectPair={onAddHost}
        onSelectGateway={() => setActiveSheet("gateway")}
      />

      {/* Gateway configuration sheet */}
      <GatewaySheet
        open={activeSheet === "gateway"}
        onClose={() => setActiveSheet(null)}
      />

      {/* Host more action sheet (⋯) */}
      <HostActionSheet
        open={activeSheet === "hostAction"}
        entry={selectedHost}
        statusKind={selectedStatusKind}
        onClose={() => setActiveSheet(null)}
        onRefresh={() => {
          if (selectedRefresh) selectedRefresh();
        }}
        onAskAgain={() => {
          onAddAccount();
        }}
        onForget={() => {
          setActiveSheet("forget");
        }}
      />

      {/* Forget confirmation sheet */}
      <ForgetConfirmSheet
        open={activeSheet === "forget"}
        entry={selectedHost}
        onClose={() => setActiveSheet(null)}
        onConfirmForget={() => void handleConfirmForget()}
      />

      {/* Confirmation Toast */}
      <Toast
        visible={Boolean(toastMessage)}
        message={toastMessage}
        onDismiss={() => setToastMessage(null)}
      />
    </Screen>
  );
}
