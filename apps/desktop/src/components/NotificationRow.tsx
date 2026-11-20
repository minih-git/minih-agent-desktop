import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  collapsedNotificationCount,
  isPluginNotification,
  type AppNotification,
} from "@minih-agent/shared";
import {
  IconCircleAlert,
  IconCircleCheck,
  IconInfo,
  IconPlug,
} from "./icons";
import { pluginViewIcon } from "../lib/plugin-view-icons";
import { pluginTaskNotification } from "../lib/plugin-task-notification";
import { PERMISSION_MODE_I18N_KEYS } from "../lib/permission-mode-labels";

/** Host-resolved identity of the plugin that delivered a `plugin.*` row. */
export type NotificationRowPlugin = {
  name: string;
  /** The plugin's own declared icon, as a host-scheme URL (never a path). */
  iconUrl?: string;
  /** Icon token of the view the row's link declares, when it declares one. */
  icon?: string;
};

function formatRelativeTime(
  value: string,
  locale: string,
  justNow: string,
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return justNow;

  const delta = timestamp - Date.now();
  const absoluteDelta = Math.abs(delta);
  if (absoluteDelta < 45_000) return justNow;

  try {
    const formatter = new Intl.RelativeTimeFormat(locale || undefined, {
      numeric: "auto",
    });
    if (absoluteDelta < 60 * 60_000) {
      return formatter.format(Math.round(delta / 60_000), "minute");
    }
    if (absoluteDelta < 24 * 60 * 60_000) {
      return formatter.format(Math.round(delta / (60 * 60_000)), "hour");
    }
    if (absoluteDelta < 7 * 24 * 60 * 60_000) {
      return formatter.format(Math.round(delta / (24 * 60 * 60_000)), "day");
    }
    return new Intl.DateTimeFormat(locale || undefined, {
      month: "short",
      day: "numeric",
      year:
        new Date(timestamp).getFullYear() === new Date().getFullYear()
          ? undefined
          : "numeric",
    }).format(timestamp);
  } catch {
    return justNow;
  }
}

/**
 * One bell row. The two inbox families share the row shell — icon, copy, time,
 * unread dot — and differ only in where their words come from: a conversation
 * row is described by the host's own vocabulary, while a plugin row (schema
 * v43) shows what its plugin wrote, under the plugin's name, with the host's
 * icon token so plugin markup never reaches host chrome.
 *
 * The overflow row is host-authored (its dedupe key is reserved) and folds the
 * digests it stands for into one localized count.
 */
export function NotificationRow({
  notification,
  unread,
  disabled,
  plugin,
  onActivate,
}: {
  notification: AppNotification;
  unread: boolean;
  disabled: boolean;
  plugin?: NotificationRowPlugin;
  onActivate: (notification: AppNotification) => void;
}) {
  const { t, i18n } = useTranslation();
  const failed = notification.kind === "task.failed";
  // A prompt row means the runtime is still blocked on the user: it reads as a
  // call to action, not as an outcome.
  const prompt = notification.kind.startsWith("prompt.")
    ? notification.kind
    : null;
  const pluginRow = isPluginNotification(notification);
  const sessionTitle = notification.sessionTitle || t("chat.untitledTask");

  let title = "";
  let body = "";
  if (pluginRow) {
    const taskNotice = pluginTaskNotification(notification);
    const collapsed = collapsedNotificationCount(notification);
    const pluginName = plugin?.name?.trim() || notification.pluginId || "";
    title = collapsed === null
      ? notification.title?.trim() || pluginName
      : t("notifications.pluginCollapsed", { count: collapsed });
    body = taskNotice
      ? taskNotice.permissionMode
        ? t("notifications.pluginTaskCreated", {
            ...taskNotice,
            pluginName,
            permissionMode: t(PERMISSION_MODE_I18N_KEYS[taskNotice.permissionMode]),
          })
        : t("notifications.pluginTaskCreatedNoMode", { ...taskNotice, pluginName })
      : collapsed === null ? notification.body ?? "" : "";
  } else if (prompt === "prompt.permission") {
    title = t("notifications.permissionTitle", { sessionTitle });
    body = t("notifications.permissionBody", {
      toolName: notification.toolName || "tool",
    });
  } else if (prompt === "prompt.plan") {
    title = t("notifications.planApprovalTitle", { sessionTitle });
    body = t("notifications.planApprovalBody");
  } else if (prompt === "prompt.ask") {
    title = t("notifications.promptAskTitle", { sessionTitle });
    body = t("notifications.promptAskBody");
  } else {
    title = t(
      failed ? "notifications.failedTitle" : "notifications.completedTitle",
      { sessionTitle },
    );
    body = failed
      ? notification.errorCode
        ? t("notifications.failedBodyWithCode", {
            code: notification.errorCode,
          })
        : t("notifications.failedBody")
      : t("notifications.completedBody");
  }

  // The plugin's own icon is an image the host serves over `plugin-asset:`;
  // a failed load falls back to the view token (or the host's plug mark).
  const [iconFailed, setIconFailed] = useState(false);
  const pluginIconUrl = pluginRow && !iconFailed ? plugin?.iconUrl : undefined;
  const PluginIcon = pluginRow
    ? pluginViewIcon(plugin?.icon) ?? IconPlug
    : null;
  const kindClass = pluginRow
    ? " plugin"
    : failed
      ? " failed"
      : prompt
        ? " prompt"
        : "";

  return (
    <li>
      <button
        type="button"
        className={`notification-item ${unread ? "unread" : ""}`}
        data-notification-id={notification.id}
        data-notification-kind={notification.kind}
        disabled={disabled}
        onClick={() => onActivate(notification)}
      >
        <span className={`notification-kind-icon${kindClass}`} aria-hidden>
          {pluginIconUrl ? (
            <img
              className="notification-plugin-avatar"
              src={pluginIconUrl}
              alt=""
              onError={() => setIconFailed(true)}
            />
          ) : PluginIcon ? (
            <PluginIcon size={17} />
          ) : failed ? (
            <IconCircleAlert size={17} />
          ) : prompt ? (
            <IconInfo size={17} />
          ) : (
            <IconCircleCheck size={17} />
          )}
        </span>
        <span className="notification-copy">
          {pluginRow ? (
            <span className="notification-plugin-name">
              {plugin?.name || notification.pluginId}
            </span>
          ) : null}
          <span className="notification-item-title">{title}</span>
          <span className="notification-item-body">{body}</span>
        </span>
        <time className="notification-time" dateTime={notification.createdAt}>
          {formatRelativeTime(
            notification.createdAt,
            i18n.resolvedLanguage || i18n.language,
            t("notifications.justNow"),
          )}
        </time>
        {unread ? (
          <span className="notification-unread-dot" aria-hidden />
        ) : null}
      </button>
    </li>
  );
}