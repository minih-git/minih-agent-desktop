/**
 * S4 My computers screen.
 *
 * Implements S4 My Computers per docs/spec/04-ux/13-remote-mobile-client.md §8.5
 * and apps/remote-web/design/prototype/redesign.html.
 */
import { Globe, Lock, Plus, Ticket, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Toast } from "../components/ui/Toast.js";
import { useAccountAvailability } from "../hooks/useAccountFlow.js";
import { usePullToRefresh } from "../hooks/usePullToRefresh.js";
import { watchForeground } from "../lib/app-state.js";
import { createForegroundRefresh } from "../lib/foreground-refresh.js";
import { forgetHost } from "../lib/forget.js";
import type { HostDisplayStatusKind } from "../lib/host-display.js";
import type { HostRegistryEntry } from "../lib/host-registry.js";
import {
  appStateSource,
  credentialPort,
  gatewayOrigin,
  hostRegistry,
  isNativeApp,
} from "../lib/runtime.js";

/**
 * How often a visible host list re-probes its computers.
 *
 * Slow on purpose: each row's probe is a real request to the Gateway, and this
 * only exists so a phone that stays open notices a computer that came or went.
 * The pull gesture and the row menu are the immediate paths.
 */
const FOREGROUND_REFRESH_MS = 30_000;

export function HostsScreen({
  hosts,
  onOpenHost,
  onAddHost,
  onAddAccount,
  onOpenSettings,
}: {
  hosts: HostRegistryEntry[];
  onOpenHost: (entry: HostRegistryEntry) => void;
  onAddHost: () => void;
  onAddAccount: () => void;
  /** The avatar/settings action on this root (ADR mobile-redesign §D3). */
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const accountMode = useAccountAvailability();

  const [expandedHostId, setExpandedHostId] = useState<string | null>(null);
  const [selectedHost, setSelectedHost] = useState<HostRegistryEntry | null>(null);
  const [selectedStatusKind, setSelectedStatusKind] = useState<HostDisplayStatusKind | undefined>(
    undefined,
  );
  const [selectedRefresh, setSelectedRefresh] = useState<(() => void) | null>(null);
  const [activeSheet, setActiveSheet] = useState<
    "connect" | "hostAction" | "forget" | "gateway" | null
  >(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const contentRef = useRef<HTMLElement>(null);
  const refreshAll = useCallback(() => setRefreshKey((key) => key + 1), []);

  // A computer's state changes without this phone being told: the Gateway keeps
  // no presence stream (§11.5) and this screen holds no long-lived connection.
  // `createForegroundRefresh` decides when to ask again — once per return, never
  // twice for the two foreground sources — while the rows keep what they show.
  useEffect(() => {
    const schedule = createForegroundRefresh({
      refresh: refreshAll,
      intervalMs: FOREGROUND_REFRESH_MS,
    });
    // A list that opens while the page is already visible never receives its
    // first visibility transition, so the schedule is primed once here. That
    // first report only starts the timer: every row probes itself on mount.
    if (document.visibilityState !== "hidden") schedule.visible();
    const stopWatching = watchForeground(
      { onVisible: () => schedule.visible(), onHidden: () => schedule.hidden() },
      {
        appState: appStateSource(),
        onError: (error) => console.warn("[remote-web] the native app-state listener failed", error),
      },
    );
    return () => {
      stopWatching();
      schedule.dispose();
    };
  }, [refreshAll]);

  const { pulling } = usePullToRefresh({ scrollRef: contentRef, onRefresh: refreshAll });

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
    <Screen aurora>
      <NavBar
        title={t("hosts.title")}
        largeTitle
        onAvatarClick={onOpenSettings}
        avatarLabel={t("hosts.settings")}
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

      <ScreenContent ref={contentRef} className="pt-1 space-y-3">
        {pulling ? (
          <div
            className="px-1 pt-1 text-center text-[12px] font-semibold text-[var(--rm-text-muted)]"
            role="status"
          >
            {t("hosts.sheet.refresh")}
          </div>
        ) : null}
        <div className="flex items-baseline justify-between px-1 pt-2 pb-1">
          <h1 className="text-[28px] font-bold leading-[1.12] tracking-[-0.5px] text-[var(--rm-text-primary)]">
            {t("hosts.title")}
          </h1>
          {hosts.length > 0 ? (
            <span className="text-[13px] font-semibold text-[var(--rm-text-muted)]">
              {hosts.length}
            </span>
          ) : null}
        </div>

        {hosts.length === 0 ? (
          <Callout tone="neutral">{t("hosts.empty")}</Callout>
        ) : (
          // No key: a re-probe must not remount the rows, which would clear their
          // status and session counts and break the sheet that holds their refresh.
          <div className="space-y-3">
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
                refreshSignal={refreshKey}
              />
            ))}
          </div>
        )}

        <div>
          <SectionHeader title={t("hosts.add")} />
          <ListGroup>
            {accountMode === "supported" ? (
              <ListRow
                leadingIcon={<User className="h-[18px] w-[18px]" aria-hidden="true" />}
                title={t("hosts.sheet.accountTitle")}
                subtitle={t("hosts.sheet.accountDesc")}
                chevron
                onClick={onAddAccount}
              />
            ) : null}
            <ListRow
              leadingIcon={<Ticket className="h-[18px] w-[18px]" aria-hidden="true" />}
              title={t("hosts.sheet.ticketTitle")}
              subtitle={t("hosts.sheet.ticketDesc")}
              chevron
              onClick={onAddHost}
            />
          </ListGroup>
        </div>

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
            <span>{t("hosts.switchGateway")}</span>
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
      <GatewaySheet open={activeSheet === "gateway"} onClose={() => setActiveSheet(null)} />

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
