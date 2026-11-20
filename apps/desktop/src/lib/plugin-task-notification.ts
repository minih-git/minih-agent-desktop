import type { AppNotification } from "@minih-agent/shared";

const PREFIX = "__minih_plugin_task__:";

/** The host validates the task, owner and session before returning stored rows. */
export function pluginTaskNotification(notification: AppNotification): {
  sessionId: string;
  taskTitle: string;
  employeeName: string;
  pluginId: string;
  permissionMode?: "ask" | "accept-edits" | "auto";
} | null {
  const taskId = notification.dedupeKey?.startsWith(PREFIX)
    ? notification.dedupeKey.slice(PREFIX.length)
    : "";
  if (!taskId || notification.kind !== "plugin.alert" || !notification.pluginId || !notification.body || !notification.linkJson) return null;
  try {
    const body = JSON.parse(notification.body);
    const link = JSON.parse(notification.linkJson);
    const params = body?.i18n?.params;
    if (body?.schema !== "minih.hostNotification" || body.version !== 1 ||
      body.i18n?.key !== "notifications.pluginTaskCreated" || body.taskId !== taskId ||
      body.pluginId !== notification.pluginId || link?.session !== body.sessionId ||
      typeof body.sessionId !== "string" || !body.sessionId ||
      typeof params?.taskTitle !== "string" || typeof params?.employeeName !== "string" ||
      params.pluginId !== notification.pluginId) return null;
    const permissionMode = body.permissionMode === "ask" || body.permissionMode === "accept-edits" || body.permissionMode === "auto"
      ? body.permissionMode
      : undefined;
    return { sessionId: body.sessionId, taskTitle: params.taskTitle, employeeName: params.employeeName, pluginId: notification.pluginId, ...(permissionMode ? { permissionMode } : {}) };
  } catch {
    return null;
  }
}
