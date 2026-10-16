import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { isMinihRouterVendorKey, MINIH_ROUTER_NAME } from "@minih-agent/shared";
import type { SettingsTabId } from "../lib/settings-search";
import { portalToBody } from "../lib/portal-visibility";
import { useAppStore } from "../stores/app-store";
import { Button } from "./ui";
import { IconChevronUp, IconCloudDown, IconRefresh, IconSettings, IconUser } from "./icons";
import { MinihRouterAccountSummary } from "./settings/MinihRouterAccountSummary";
import { endpointLabel } from "./settings/service-catalog";
import { useMinihRouterAccount } from "./settings/useMinihRouter";

/** Mount only while open: no quota polling, retained credentials or hidden requests. */
function AccountDetails({ providerId }: { providerId: string }) {
  const { t, i18n } = useTranslation();
  const [revision, setRevision] = useState(0);
  const account = useMinihRouterAccount(providerId, revision);
  return (
    <section className="sidebar-user-quota" aria-label={t("userMenu.quota")} aria-busy={account.state === "loading"}>
      <div className="sidebar-user-quota-heading">
        <span>{t("userMenu.quota")}</span>
        <Button type="button" variant="ghost" size="sm" disabled={account.state === "loading"}
          onClick={() => setRevision((value) => value + 1)} aria-label={t("settings.minihRouterRefresh")}>
          <IconRefresh size={13} /><span>{t("settings.minihRouterRefresh")}</span>
        </Button>
      </div>
      {account.state === "loading" ? <p role="status">{t("settings.minihRouterLoading")}</p> : null}
      {account.state === "error" ? <p role="alert">{t("settings.minihRouterAccountFailed")}</p> : null}
      <MinihRouterAccountSummary account={account.data} locale={i18n.resolvedLanguage ?? i18n.language} />
    </section>
  );
}

export function SidebarUserMenu({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const { t } = useTranslation();
  const providers = useAppStore((state) => state.providers);
  const page = useAppStore((state) => state.page);
  const settingsTab = useAppStore((state) => state.settingsTab);
  const setPage = useAppStore((state) => state.setPage);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const provider = providers.find((row) => isMinihRouterVendorKey(row.vendorKey) && row.hasSecret) ?? null;
  const name = provider?.oauthAccountLabel || provider?.name || t("userMenu.localUser");
  const subtitle = provider
    ? name === MINIH_ROUTER_NAME && provider.baseUrl
      ? endpointLabel(provider.baseUrl)
      : MINIH_ROUTER_NAME
    : t("userMenu.notConnected");
  const [open, setOpen] = useState(false);
  const avatarGlyph = provider ? Array.from(name)[0]?.toLocaleUpperCase() : <IconUser size={16} />;
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => { close(); }, [page, settingsTab, close]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(352, window.innerWidth - 24);
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        bottom: Math.min(window.innerHeight - 12, Math.max(12, window.innerHeight - rect.top + 8)),
      });
    };
    place();
    panel.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node &&
      (trigger.current?.contains(target) || panel.current?.contains(target));
    const dismiss = (event: PointerEvent) => { if (!inside(event.target)) close(); };
    const blur = (event: FocusEvent) => { if (!inside(event.target)) close(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", blur);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", blur);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close]);

  const navigate = (tab?: SettingsTabId) => {
    close();
    if (tab) setSettingsTab(tab);
    else setPage("settings");
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : index < 0 ? (event.key === "ArrowUp" ? buttons.length - 1 : 0)
      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <>
      <Button ref={trigger} type="button" variant="ghost" className="sidebar-user-trigger" data-nav="user"
        aria-label={t("userMenu.open", { name })} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => { if (open) close(); else { onBeforeOpen?.(); setOpen(true); } }}>
        <span className="sidebar-user-avatar" aria-hidden>{avatarGlyph}</span>
        <span className="sidebar-user-trigger-name">{name}</span>
        <IconChevronUp size={12} aria-hidden />
      </Button>
      {open ? portalToBody(
        <div ref={panel} id={id} role="dialog" aria-label={t("userMenu.title")} tabIndex={-1}
          className="sidebar-user-popover no-drag" data-sidebar-user-popover="true" onKeyDown={onKeyDown}
          style={{ left: position?.left ?? 12, bottom: position?.bottom ?? 56, maxHeight: position ? Math.max(0, window.innerHeight - position.bottom - 12) : undefined }}>
          <div className="sidebar-user-identity">
            <span className="sidebar-user-avatar is-large" aria-hidden>{avatarGlyph}</span>
            <div className="sidebar-user-identity-copy">
              <strong>{name}</strong>
              <span>{subtitle}</span>
            </div>
          </div>
          {provider ? <AccountDetails key={`${provider.id}:${provider.baseUrl ?? ""}:${provider.updatedAt}`} providerId={provider.id} />
            : <p className="sidebar-user-empty">{t("userMenu.connectHint")}</p>}
          <nav className="sidebar-user-links" aria-label={t("userMenu.title")}>
            <Button type="button" variant="ghost" data-nav="accounts" onClick={() => navigate("accounts")}><IconUser size={15} /><span>{t("userMenu.manageAccount")}</span></Button>
            <Button type="button" variant="ghost" data-nav="settings" onClick={() => navigate()}><IconSettings size={15} /><span>{t("nav.settings")}</span></Button>
            <Button type="button" variant="ghost" data-nav="configSync" onClick={() => navigate("sync")}><IconCloudDown size={15} /><span>{t("settings.configSync.title")}</span></Button>
          </nav>
        </div>,
      ) : null}
    </>
  );
}
