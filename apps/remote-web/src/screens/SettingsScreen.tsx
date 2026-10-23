/**
 * S8 Settings (ADR mobile-redesign §D6, §D2, §D4; bugs B9, B10, B13).
 *
 * Every row performs a real action backed by live state:
 * - Account card: connected Router key identity and model count (no balance,
 *   because `GET /api/auth/session` returns key identity only).
 * - Default models: chat and image rows formatted with model name and vendor
 *   (B13), opening `ModelSheet` to star/select defaults.
 * - Model gateway: connected status + confirmed unlink, or connect action.
 * - Notifications: real push state and master switch from `usePushRegistration`
 *   (B10), registration diagnostics, and a one-line explanation that the
 *   gateway does not support per-event filter toggles.
 * - Appearance: `system | light | dark` segmented control persisted via
 *   `lib/theme.ts` and reactive to OS `prefers-color-scheme` changes.
 * - Local history & Other accounts: conversation count, scoped clear with
 *   account-named confirmation, and read-only older account scopes.
 * - About: build version + active gateway origin, and a real privacy-policy link.
 */
import {
  Bell,
  ChevronRight,
  ExternalLink,
  History,
  Image as ImageIcon,
  Info,
  Router,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelSheet } from "../components/ModelSheet.js";
import { Button } from "../components/ui/Button.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Sheet } from "../components/ui/Sheet.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import {
  usePushRegistrationState,
  type PushRegistrationSnapshot,
} from "../hooks/usePushRegistration.js";
import type { DirectChatConnection } from "../lib/direct-chat/connection.js";
import { scopeDependency, scopeKey, type DirectChatScope } from "../lib/direct-chat/history-store.js";
import {
  directChatHistory,
  directChatScope as currentScope,
  directChatService,
  gatewayOrigin,
  notifyDirectChatChanged,
  subscribeDirectChat,
} from "../lib/runtime.js";
import {
  APP_VERSION,
  buildAccountCardView,
  describePushSettingsView,
  formatDefaultModelRow,
  resolvePrivacyPolicyUrl,
  selectThemePreference,
  type DefaultModelRowView,
} from "../lib/settings-view.js";
import { readThemePreference, type ThemePreference } from "../lib/theme.js";

export type SettingsScreenProps = {
  connection: DirectChatConnection | null;
  /** Whether this build has a model gateway at all. */
  gatewayConfigured: boolean;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => Promise<void>;
  /**
   * Open an older account's conversations. They are history this device keeps
   * for reference: listed read-only, never sent under the key held today.
   */
  onOpenScope: (scope: DirectChatScope) => void;
  onConnectionChanged?: () => void;
  /** Optional override for unit tests; defaults to `usePushRegistrationState()`. */
  pushRegistration?: PushRegistrationSnapshot;
};

const THEME_OPTIONS: readonly ThemePreference[] = ["system", "light", "dark"];

export function SettingsScreen({
  connection,
  gatewayConfigured,
  onBack,
  onConnect,
  onDisconnect,
  onOpenScope,
  onConnectionChanged,
  pushRegistration,
}: SettingsScreenProps) {
  const { t } = useTranslation();
  const [defaultModelSheet, setDefaultModelSheet] = useState<"chat" | "image" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unlinkFailed, setUnlinkFailed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearingConfirm, setClearingConfirm] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [olderScopes, setOlderScopes] = useState<Array<{ scope: DirectChatScope; count: number }>>([]);
  const [themePref, setThemePref] = useState<ThemePreference>(() => readThemePreference());

  const sharedPush = usePushRegistrationState();
  const push = pushRegistration ?? sharedPush;
  const pushView = describePushSettingsView(push);

  const history = directChatHistory();
  const scope = currentScope();
  /**
   * The stable identity of the scope: `currentScope()` builds a new object on
   * every call, so depending on the object itself reloads on every render.
   */
  const scopeKeyValue = scopeDependency(scope);

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
  }, [history, scopeKeyValue]);

  /**
   * Appearance is applied here and, for `"system"`, kept in step with the OS by
   * the application-level watcher in `main.tsx`; Settings owns only the choice.
   */
  function handleThemeChange(next: ThemePreference) {
    setThemePref(next);
    selectThemePreference(next);
  }

  async function clearHistory() {
    if (!scope) return;
    setClearing(true);
    const cleared = await history.clearScope(scope);
    setClearing(false);
    if (!cleared.ok) {
      setClearError(
        cleared.reason === "busy" ? t("settings.history.clearBusy") : t("directChat.saveFailed"),
      );
      return;
    }
    setClearError(null);
    setClearingConfirm(false);
    notifyDirectChatChanged();
  }

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

  const accountCard = buildAccountCardView(connection, gatewayConfigured);
  const chatDefaultRow = connection
    ? formatDefaultModelRow(connection.models, connection.defaultChatModelId, "chat")
    : null;
  const imageDefaultRow = connection
    ? formatDefaultModelRow(connection.models, connection.defaultImageModelId, "image")
    : null;
  const themeIndex = Math.max(0, THEME_OPTIONS.indexOf(themePref));
  const privacyUrl = resolvePrivacyPolicyUrl(import.meta.env.VITE_PRIVACY_POLICY_URL);
  // The version comes from the build (`define` in vite.config.ts), never from a
  // second copy in the source that would drift from package.json.
  const versionText = APP_VERSION;

  const renderDefaultModelRow = (
    mode: "chat" | "image",
    row: DefaultModelRowView,
    fallbackIcon: React.ReactNode,
  ) => {
    const label =
      mode === "chat" ? t("settings.defaultModels.chat") : t("settings.defaultModels.image");
    const subtitle = !row.configured
      ? t("settings.defaultModels.notSet")
      : !row.usable
        ? `${row.vendor ? `${row.vendor} · ` : ""}${t("settings.defaultModels.unavailable")}`
        : (row.vendor ?? row.name);
    const valueNode = row.configured ? (
      <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--rm-text-primary)]">
        {row.monogram && row.gradientClass ? (
          <span
            aria-hidden="true"
            className={`grid h-5 w-5 place-items-center rounded-[6px] text-[10px] font-extrabold text-white ${row.gradientClass}`}
          >
            {row.monogram}
          </span>
        ) : null}
        <span className="max-w-[150px] truncate">{row.name}</span>
      </span>
    ) : undefined;

    return (
      <ListRow
        leading={fallbackIcon}
        title={label}
        subtitle={subtitle}
        value={valueNode}
        chevron
        onClick={() => setDefaultModelSheet(mode)}
      />
    );
  };

  return (
    <Screen>
      <NavBar title={t("settings.title")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent>
        {/* Account Card */}
        {accountCard.connected ? (
          <div className="relative mb-2 flex items-center gap-3.5 overflow-hidden rounded-[24px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] p-[18px]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[image:var(--rm-aurora)] opacity-[0.16]"
            />
            <span
              aria-hidden="true"
              className="relative grid h-[54px] w-[54px] shrink-0 place-items-center rounded-full bg-[image:var(--rm-aurora)] text-[20px] font-bold text-white shadow-[0_0_0_2px_var(--rm-bg-page),0_0_0_3.5px_rgba(124,92,255,0.5)]"
            >
              {accountCard.avatarInitial}
            </span>
            <div className="relative min-w-0 flex-1">
              <div className="truncate text-[18px] font-bold leading-[23px] text-[var(--rm-text-primary)]">
                {accountCard.keyName ?? t("settings.modelGateway.unnamedKey")}
              </div>
              <div className="mt-0.5 truncate font-mono text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                {accountCard.maskedKey
                  ? `${accountCard.maskedKey} · #${accountCard.accessKeyId}`
                  : `#${accountCard.accessKeyId}`}
              </div>
            </div>
            <div className="relative shrink-0 text-right">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--rm-bg-surface-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--rm-text-primary)]">
                <StatusDot status="online" />
                <span>{t("settings.account.modelsCount", { count: accountCard.modelCount })}</span>
              </span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={!gatewayConfigured}
            onClick={gatewayConfigured ? onConnect : undefined}
            className="relative mb-2 flex w-full items-center gap-3.5 overflow-hidden rounded-[24px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] p-[18px] text-left transition-transform duration-150 ease-[var(--rm-ease-out)] active:scale-[0.985] disabled:opacity-60"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[image:var(--rm-aurora)] opacity-[0.1]"
            />
            <span
              aria-hidden="true"
              className="relative grid h-[54px] w-[54px] shrink-0 place-items-center rounded-full bg-[var(--rm-bg-surface-2)] text-[20px] font-bold text-[var(--rm-text-secondary)]"
            >
              M
            </span>
            <div className="relative min-w-0 flex-1">
              <div className="truncate text-[17px] font-bold leading-[22px] text-[var(--rm-text-primary)]">
                {t("settings.account.notConnectedTitle")}
              </div>
              {/* The build-level explanation belongs to the Model gateway row
                  below; repeating it here made the same paragraph appear twice. */}
              {gatewayConfigured ? (
                <div className="mt-0.5 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
                  {t("settings.account.notConnectedSub")}
                </div>
              ) : null}
            </div>
            {gatewayConfigured ? (
              <ChevronRight className="relative h-5 w-5 shrink-0 text-[var(--rm-text-faint)]" aria-hidden="true" />
            ) : null}
          </button>
        )}

        {/* Default Models (B13) */}
        {connection && chatDefaultRow && imageDefaultRow ? (
          <>
            <SectionHeader title={t("settings.defaultModels.section")} />
            <ListGroup>
              {renderDefaultModelRow(
                "chat",
                chatDefaultRow,
                <Sparkles className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />,
              )}
              {renderDefaultModelRow(
                "image",
                imageDefaultRow,
                <ImageIcon className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />,
              )}
            </ListGroup>
            <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("settings.defaultModels.hint")}
            </p>
          </>
        ) : null}

        {/* Model Gateway */}
        <SectionHeader title={t("settings.modelGateway.section")} />
        <ListGroup>
          {connection ? (
            <>
              <ListRow
                leading={<Router className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
                title={t("settings.modelGateway.connected")}
                subtitle={
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <StatusDot status="online" />
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
              // A row that cannot be opened must not look openable: no chevron
              // when the build has no gateway to connect to.
              trailing={
                gatewayConfigured ? (
                  <ChevronRight className="h-4 w-4 text-[var(--rm-text-faint)]" aria-hidden="true" />
                ) : undefined
              }
              onClick={gatewayConfigured ? onConnect : undefined}
            />
          )}
        </ListGroup>
        <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
          {t("settings.modelGateway.note")}
        </p>

        {/* Notifications (B10) */}
        <SectionHeader title={t("settings.notifications.section")} />
        <ListGroup>
          <ListRow
            leading={<Bell className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
            title={t("settings.notifications.pushTitle")}
            subtitle={t(pushView.statusKey)}
            trailing={
              <button
                type="button"
                role="switch"
                aria-checked={pushView.checked}
                aria-label={t("settings.notifications.pushTitle")}
                disabled={pushView.disabled}
                onClick={() => void push.setEnabled(!pushView.checked)}
                className={`relative h-[31px] w-[51px] shrink-0 rounded-[16px] border border-[var(--rm-hair)] transition-colors duration-200 ease-[var(--rm-ease-out)] focus-visible:ring-2 focus-visible:ring-[var(--rm-accent-1)] disabled:opacity-45 ${
                  pushView.checked ? "bg-[image:var(--rm-aurora)]" : "bg-[var(--rm-bg-surface-2)]"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute left-[2px] top-[2px] h-[25px] w-[25px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.3)] transition-transform duration-300 ease-[var(--rm-ease-spring)] ${
                    pushView.checked ? "translate-x-[20px]" : "translate-x-0"
                  }`}
                />
              </button>
            }
          />
          <ListRow
            leading={<ShieldCheck className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
            title={t("settings.notifications.diagnosticsTitle")}
            subtitle={
              push.registered
                ? t("settings.notifications.diagnosticsRegistered", {
                    count: push.registeredCount,
                    gateway: gatewayOrigin,
                  })
                : t("settings.notifications.diagnosticsIdle", { gateway: gatewayOrigin })
            }
          >
            {pushView.errorKey ? (
              <p role="alert" className="mt-1 text-[13px] leading-[18px] text-[var(--rm-error)]">
                {t(pushView.errorKey)}
                {pushView.errorDetail ? ` (${pushView.errorDetail})` : ""}
              </p>
            ) : null}
          </ListRow>
        </ListGroup>
        <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
          {t("settings.notifications.noEventFilterNote")}
        </p>

        {/* Appearance (D4, D6) */}
        <SectionHeader title={t("settings.appearance.section")} />
        <ListGroup className="p-3">
          <div
            role="radiogroup"
            aria-label={t("settings.appearance.section")}
            className="relative flex w-full rounded-[12px] bg-[var(--rm-bg-surface-2)] p-[3px]"
          >
            <span
              aria-hidden="true"
              className="rm-seg-slider pointer-events-none"
              style={{
                width: "calc((100% - 6px) / 3)",
                transform: `translateX(${themeIndex * 100}%)`,
              }}
            />
            {THEME_OPTIONS.map((option) => {
              const active = themePref === option;
              const labelKey =
                option === "system"
                  ? "settings.appearance.system"
                  : option === "light"
                    ? "settings.appearance.light"
                    : "settings.appearance.dark";
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-theme-option={option}
                  onClick={() => handleThemeChange(option)}
                  className={`relative z-10 h-[34px] flex-1 text-[14px] font-semibold transition-colors duration-200 ${
                    active ? "text-[var(--rm-text-primary)]" : "text-[var(--rm-text-muted)]"
                  }`}
                >
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
        </ListGroup>

        {/* Local History */}
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
            // Nothing saved means nothing to clear: the row stays a statement of
            // the count instead of looking like a destructive action.
            title={
              count > 0 ? (
                <span className="text-[var(--rm-error)]">{t("settings.history.clear")}</span>
              ) : (
                t("settings.history.clear")
              )
            }
            subtitle={scope ? scope.accessKeyId : undefined}
            chevron={count > 0}
            onClick={count > 0 ? () => setClearingConfirm(true) : undefined}
          />
        </ListGroup>
        <p className="mt-2 px-4 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
          {t("settings.history.localHint")}
        </p>

        {/* Other Accounts */}
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
                  chevron
                  onClick={() => onOpenScope(older)}
                />
              ))}
            </ListGroup>
          </>
        ) : null}

        {/* About */}
        <SectionHeader title={t("settings.about.section")} />
        <ListGroup>
          <ListRow
            leading={<Info className="h-5 w-5 text-[var(--rm-text-secondary)]" aria-hidden="true" />}
            title={t("settings.about.version")}
            subtitle={<span className="break-all font-mono">{gatewayOrigin}</span>}
            value={<span className="font-mono text-[var(--rm-text-primary)]">{versionText}</span>}
          />
          {/* No row at all when the build was not told where the policy lives:
              a link that goes nowhere is worse than no link. */}
          {privacyUrl ? (
            <a
              href={privacyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3 text-left no-underline transition-colors duration-150 ease-[var(--rm-ease-out)] active:bg-[var(--rm-bg-surface-2)] focus-visible:bg-[var(--rm-bg-surface-2)]"
            >
              <span className="text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
                {t("settings.about.privacyPolicy")}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-[var(--rm-text-muted)]">
                <ExternalLink className="h-4 w-4 text-[var(--rm-text-faint)]" aria-hidden="true" />
              </span>
            </a>
          ) : null}
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
          <p role="alert" className="mb-3 px-1 text-[13px] leading-[18px] text-[var(--rm-error)]">
            {clearError}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            variant="destructive"
            size="large"
            disabled={clearing}
            onClick={() => void clearHistory()}
          >
            {t("settings.history.clear")}
          </Button>
          <Button
            variant="secondary"
            size="large"
            disabled={clearing}
            onClick={() => setClearingConfirm(false)}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("settings.modelGateway.disconnectTitle")}
      >
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
          <Button
            variant="secondary"
            size="large"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </Sheet>

      {connection && defaultModelSheet ? (
        <ModelSheet
          open={true}
          mode={defaultModelSheet}
          models={connection.models}
          title={
            defaultModelSheet === "chat"
              ? t("settings.defaultModels.chat")
              : t("settings.defaultModels.image")
          }
          selectedId={
            defaultModelSheet === "chat"
              ? (connection.defaultChatModelId ?? null)
              : (connection.defaultImageModelId ?? null)
          }
          defaultChatModelId={connection.defaultChatModelId}
          defaultImageModelId={connection.defaultImageModelId}
          onClose={() => setDefaultModelSheet(null)}
          onSetDefault={(model, pickedMode) => {
            if (pickedMode === "image") {
              directChatService().setDefaultImageModel(model.id);
            } else {
              directChatService().setDefaultChatModel(model.id);
            }
            onConnectionChanged?.();
          }}
          onSelect={(model, pickedMode) => {
            const targetMode = pickedMode ?? defaultModelSheet;
            if (targetMode === "image") {
              directChatService().setDefaultImageModel(model.id);
            } else {
              directChatService().setDefaultChatModel(model.id);
            }
            setDefaultModelSheet(null);
            onConnectionChanged?.();
          }}
        />
      ) : null}
    </Screen>
  );
}
