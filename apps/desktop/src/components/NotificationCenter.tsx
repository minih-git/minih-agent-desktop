import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { portalToBody } from "../lib/portal-visibility";
import {
  bellNotifications,
  isSessionNotification,
  pluginNotificationTarget,
  unreadNotificationCount,
  unreadSessionIds,
  type AppNotification,
} from "@minih-agent/shared";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { IconBell, IconCheckCheck, IconTrash } from "./icons";
import { NotificationRow, type NotificationRowPlugin } from "./NotificationRow";
import { TooltipButton } from "./ui";

type NotificationFilter = "all" | "unread";

export function NotificationCenter({
  onBeforeOpen,
}: {
  onBeforeOpen?: () => void;
}) {
  const { t } = useTranslation();
  const storedNotifications = useAppStore((state) => state.notifications);
  const pluginViews = useAppStore((state) => state.pluginViews);
  const plugins = useAppStore((state) => state.plugins);
  // The bell is a per-conversation surface (D664, amending D295): every
  // retained conversation gets one row — its newest notification — and a
  // conversation counts as unread while any of its rows is unread. Plugin rows
  // (schema v43) belong to no conversation, so each one keeps a row of its own.
  const notifications = useMemo(
    () => bellNotifications(storedNotifications),
    [storedNotifications],
  );
  const unreadSessions = useMemo(
    () => unreadSessionIds(storedNotifications),
    [storedNotifications],
  );
  // The badge counts the same destinations the list shows: unread
  // conversations plus the unread plugin rows. The shell badge uses this same
  // projection, so the bell and the OS badge cannot disagree.
  const unreadCount = useMemo(
    () => unreadNotificationCount(storedNotifications),
    [storedNotifications],
  );
  const rows = useMemo(
    () =>
      notifications.map((notification) => {
        if (isSessionNotification(notification)) {
          return {
            notification,
            unread: unreadSessions.has(notification.sessionId),
            plugin: undefined,
          };
        }
        // A plugin row shows the plugin's own name and, when the plugin is
        // loaded, the icon it declares for itself. A view's token icon is only
        // the fallback, so one plugin never borrows another plugin's mark.
        const target = pluginNotificationTarget(notification, pluginViews);
        const installed = plugins.find(
          (item) => item.id === notification.pluginId,
        );
        const name =
          installed?.name ??
          pluginViews.find((view) => view.pluginId === notification.pluginId)
            ?.pluginName ??
          notification.pluginId;
        const plugin: NotificationRowPlugin = {
          name: name ?? "",
          ...(installed?.iconUrl ? { iconUrl: installed.iconUrl } : {}),
          ...(target?.kind === "view" && target.icon
            ? { icon: target.icon }
            : {}),
        };
        return {
          notification,
          unread: !notification.readAt,
          plugin,
        };
      }),
    [notifications, pluginViews, plugins, unreadSessions],
  );
  // Row-level unread still decides whether Mark all read has work to do.
  const allUnreadCount = useAppStore((state) => state.unreadNotificationCount);
  const refreshNotifications = useAppStore((state) => state.refreshNotifications);
  const markAllNotificationsRead = useAppStore(
    (state) => state.markAllNotificationsRead,
  );
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const openNotification = useAppStore((state) => state.openNotification);
  const showToast = useAppStore((state) => state.showToast);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [popoverPos, setPopoverPos] = useState<{ bottom: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const visibleNotifications = useMemo(
    () =>
      filter === "unread" ? rows.filter((row) => row.unread) : rows,
    [filter, rows],
  );

  const closePopover = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      setPopoverPos({
        bottom: Math.max(12, window.innerHeight - rect.top + 8),
        left,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setBusy(true);
    void refreshNotifications()
      .catch(() =>
        showToast(t("notifications.actionFailed"), { variant: "error" }),
      )
      .finally(() => {
        setBusy(false);
        requestAnimationFrame(() => {
          popoverRef.current
            ?.querySelector<HTMLButtonElement>(
              ".notification-item.unread, .notification-item, .notification-filter.active",
            )
            ?.focus();
        });
      });
  }, [open, refreshNotifications, showToast, t]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      closePopover(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePopover();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closePopover, open]);

  const onPopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ".notification-item:not(:disabled)",
      ),
    );
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowUp") {
      next = Math.max(0, current < 0 ? 0 : current - 1);
    } else if (event.key === "ArrowDown") {
      next = Math.min(buttons.length - 1, current < 0 ? 0 : current + 1);
    }
    buttons[next]?.focus();
  };

  const focusActiveFilter = () => {
    requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLButtonElement>(".notification-filter.active")
        ?.focus();
    });
  };

  const runToolbarAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      focusActiveFilter();
    } catch {
      showToast(t("notifications.actionFailed"), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  const activateNotification = async (notification: AppNotification) => {
    closePopover();
    try {
      await openNotification(notification.id);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const message = code === "PLUGIN_NOTIFICATION_VIEW_REQUIRES_SESSION"
        ? "notifications.pluginViewNeedsSession"
        : code === "PLUGIN_NOTIFICATION_TARGET_UNAVAILABLE"
          ? "notifications.pluginTargetUnavailable"
          : "notifications.actionFailed";
      showToast(t(message), { variant: "error" });
    }
  };

  const unreadLabel =
    unreadCount > 0
      ? t("notifications.openUnread", { count: unreadCount })
      : t("notifications.open");
  const emptyUnread = filter === "unread";

  return (
    <div className="notification-center" ref={rootRef}>
      <TooltipButton
        ref={triggerRef}
        type="button"
        className={`footer-notification notification-trigger ${open ? "active" : ""}`}
        tooltip={unreadLabel}
        ariaLabel={unreadLabel}
        aria-haspopup="dialog"
        aria-controls="notification-popover"
        aria-expanded={open}
        onClick={() => {
          if (open) closePopover();
          else {
            onBeforeOpen?.();
            setOpen(true);
          }
        }}
      >
        <IconBell size={14} aria-hidden />
        {unreadCount > 0 ? (
          <span className="notification-badge" aria-hidden>
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </TooltipButton>
      <span className="sr-only" role="status" aria-live="polite">
        {unreadLabel}
      </span>

      {open && popoverPos && typeof document !== "undefined"
        ? portalToBody(
            <div
              ref={popoverRef}
              id="notification-popover"
              className="notification-popover notification-popover-portaled"
              role="dialog"
              aria-labelledby="notification-title"
              onKeyDown={onPopoverKeyDown}
              style={{ bottom: popoverPos.bottom, left: popoverPos.left }}
            >
          <header className="notification-header">
            <h2 id="notification-title">{t("notifications.title")}</h2>
            <div className="notification-actions">
              <TooltipButton
                type="button"
                className="notification-action"
                tooltip={t("notifications.markAllRead")}
                ariaLabel={t("notifications.markAllRead")}
                disabled={busy || allUnreadCount === 0}
                onClick={() => void runToolbarAction(markAllNotificationsRead)}
              >
                <IconCheckCheck size={15} aria-hidden />
              </TooltipButton>
              <TooltipButton
                type="button"
                className="notification-action"
                tooltip={t("notifications.clearAll")}
                ariaLabel={t("notifications.clearAll")}
                disabled={busy || storedNotifications.length === 0}
                onClick={() => void runToolbarAction(clearNotifications)}
              >
                <IconTrash size={15} aria-hidden />
              </TooltipButton>
            </div>
          </header>

          <div
            className="notification-filters"
            role="group"
            aria-label={t("notifications.title")}
          >
            {(["all", "unread"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`notification-filter ${filter === value ? "active" : ""}`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(`notifications.${value}`)}
              </button>
            ))}
          </div>

          {visibleNotifications.length > 0 ? (
            <ul className="notification-list">
              {visibleNotifications.map((row) => (
                <NotificationRow
                  key={row.notification.id}
                  notification={row.notification}
                  unread={row.unread}
                  disabled={busy}
                  plugin={row.plugin}
                  onActivate={(notification) => void activateNotification(notification)}
                />
              ))}
            </ul>
          ) : (
            <div className="notification-empty" role="status">
              <IconBell size={22} aria-hidden />
              <strong>
                {t(
                  emptyUnread
                    ? "notifications.emptyUnreadTitle"
                    : "notifications.emptyTitle",
                )}
              </strong>
              <span>
                {t(
                  emptyUnread
                    ? "notifications.emptyUnreadBody"
                    : "notifications.emptyBody",
                )}
              </span>
            </div>
          )}
            </div>,
          )
        : null}
    </div>
  );
}