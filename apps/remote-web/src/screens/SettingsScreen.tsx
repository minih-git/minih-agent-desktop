/**
 * S8 Settings, first release (ADR mobile-direct-gateway-chat §1, §2).
 *
 * Pushed from the gear on either root, and back returns to that root. This
 * release has two sections and one honest note about the rest:
 *
 * - Model gateway: connected (the gateway, the key's label, when it was verified)
 *   or a row that opens D2; unlinking asks first, because it deletes a secret.
 * - Chat history: the count on this phone, clearing the current account's
 *   history behind a confirmation that names the account, and a read-only way
 *   into older accounts' conversations. A scope's history is never merged with
 *   another's, and the clear action says which one it deletes.
 */
import { ChevronRight, History, Router } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import { scopeKey, type DirectChatScope } from "../lib/direct-chat/history-store.js";
import {
  directChatHistory,
  directChatScope as currentScope,
  notifyDirectChatChanged,
  subscribeDirectChat,
} from "../lib/runtime.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Sheet } from "../components/ui/Sheet.js";

export type SettingsScreenProps = {
  connection: DirectChatConnection | null;
  /** Whether this build has a model gateway at all. */
  gatewayConfigured: boolean;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => Promise<void>;
};

export function SettingsScreen({
  connection,
  gatewayConfigured,
  onBack,
  onConnect,
  onDisconnect,
}: SettingsScreenProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearingConfirm, setClearingConfirm] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [olderScopes, setOlderScopes] = useState<Array<{ scope: DirectChatScope; count: number }>>([]);
  const history = directChatHistory();
  const scope = currentScope();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!scope) {
        setCount(0);
        setOlderScopes([]);
        return;
      }
      const mine = await history.list(scope);
      const archived = await history.list(scope, { archived: true });
      // Every other scope that has history: read-only, never sent under this key.
      const others: Array<{ scope: DirectChatScope; count: number }> = [];
      for (const other of await history.scopes()) {
        if (scopeKey(other) === scopeKey(scope)) continue;
        const rows = await history.list(other);
        if (rows.length > 0) others.push({ scope: other, count: rows.length });
      }
      if (cancelled) return;
      setCount(mine.length + archived.length);
      setOlderScopes(others);
    };
    void load();
    const unsubscribe = subscribeDirectChat(() => void load());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [history, scope]);

  /**
   * Clear this account's conversations, all of them or none.
   *
   * The history decides: a reply still arriving in any of them refuses the whole
   * action, because a half-cleared history is a lie about what is gone.
   */
  async function clearHistory() {
    if (!scope) return;
    setClearing(true);
    const cleared = await history.clearScope(scope);
    setClearing(false);
    if (!cleared.ok) {
      setClearError(cleared.reason === "busy" ? t("settings.history.clearBusy") : t("directChat.saveFailed"));
      return;
    }
    setClearError(null);
    setClearingConfirm(false);
    notifyDirectChatChanged();
  }
  /** Unlink failed: the key may still be on this phone, and the user must know. */
  const [unlinkFailed, setUnlinkFailed] = useState(false);

  async function unlink() {
    setBusy(true);
    setUnlinkFailed(false);
    try {
      await onDisconnect();
      setConfirming(false);
    } catch {
      setUnlinkFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <NavBar title={t("settings.title")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent>
        <SectionHeader title={t("settings.modelGateway.section")} />
        <ListGroup>
          {connection ? (
            <>
              <ListRow
                leading={<Router className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
                title={t("settings.modelGateway.connected")}
                subtitle={
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span className="inline-block h-2 w-2 rounded-full bg-[var(--rm-success,#34c759)]" aria-hidden="true" />
                    <span>{connection.keyName || t("settings.modelGateway.unnamedKey")}</span>
                    <span className="text-[var(--rm-text-faint)]">·</span>
                    <span className="break-all font-mono">{connection.gatewayRoot}</span>
                  </span>
                }
              />
              <ListRow
                title={<span className="text-[var(--rm-error)]">{t("settings.modelGateway.disconnect")}</span>}
                chevron
                onClick={() => setConfirming(true)}
              />
            </>
          ) : (
            <ListRow
              leading={<Router className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
              title={t("settings.modelGateway.connect")}
              subtitle={
                gatewayConfigured ? t("settings.modelGateway.notConnected") : t("directChat.unavailable")
              }
              trailing={<ChevronRight className="h-4 w-4 text-[var(--rm-text-faint)]" aria-hidden="true" />}
              onClick={gatewayConfigured ? onConnect : undefined}
            />
          )}
        </ListGroup>
        <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
          {t("settings.modelGateway.note")}
        </p>

        <SectionHeader title={t("settings.history.section")} />
        <ListGroup>
          <ListRow
            leading={<History className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
            title={t("settings.history.local")}
            subtitle={
              count > 0 ? t("settings.history.count", { count }) : t("settings.history.none")
            }
          />
          <ListRow
            title={<span className="text-[var(--rm-error)]">{t("settings.history.clear")}</span>}
            subtitle={scope ? scope.accessKeyId : undefined}
            chevron
            onClick={count > 0 ? () => setClearingConfirm(true) : undefined}
          />
        </ListGroup>
        <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
          {t("settings.history.localHint")}
        </p>

        {olderScopes.length > 0 ? (
          <>
            <SectionHeader title={t("settings.history.otherAccounts")} />
            <ListGroup>
              {olderScopes.map(({ scope: older, count: olderCount }) => (
                <ListRow
                  key={scopeKey(older)}
                  title={t("settings.history.otherAccountRow", {
                    account: older.accessKeyId,
                    count: olderCount,
                  })}
                  subtitle={<span className="break-all font-mono">{older.gatewayRoot}</span>}
                />
              ))}
            </ListGroup>
          </>
        ) : null}

        <SectionHeader title={t("settings.other.section")} />
        <ListGroup>
          <ListRow title={t("settings.other.computers")} subtitle={t("settings.other.later")} />
          <ListRow title={t("settings.other.notifications")} subtitle={t("settings.other.later")} />
          <ListRow title={t("settings.other.appearance")} subtitle={t("settings.other.later")} />
          <ListRow title={t("settings.other.about")} subtitle={t("settings.other.later")} />
        </ListGroup>
      </ScreenContent>

      <Sheet
        open={clearingConfirm}
        onClose={() => setClearingConfirm(false)}
        title={t("settings.history.clearTitle")}
      >
        <p className="px-1 pb-4 text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
          {t("settings.history.clearBody", { account: scope?.accessKeyId ?? "" })}
        </p>
        {clearError ? (
          <p className="mb-3 px-1 text-[13px] leading-[18px] text-[var(--rm-error)]">{clearError}</p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button variant="destructive" size="large" disabled={clearing} onClick={() => void clearHistory()}>
            {t("settings.history.clear")}
          </Button>
          <Button variant="secondary" size="large" disabled={clearing} onClick={() => setClearingConfirm(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>

      <Sheet open={confirming} onClose={() => setConfirming(false)} title={t("settings.modelGateway.disconnectTitle")}>
        <p className="px-1 pb-4 text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
          {t("settings.modelGateway.disconnectBody")}
        </p>
        {unlinkFailed ? (
          <p role="alert" className="px-1 pb-4 text-[14px] leading-[20px] text-[var(--rm-error)]">
            {t("settings.modelGateway.disconnectFailed")}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button variant="destructive" size="large" disabled={busy} onClick={() => void unlink()}>
            {t("settings.modelGateway.disconnect")}
          </Button>
          <Button variant="secondary" size="large" disabled={busy} onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>
    </Screen>
  );
}
