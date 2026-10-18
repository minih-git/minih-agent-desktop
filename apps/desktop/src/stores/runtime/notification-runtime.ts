import i18n from "i18next";
import { api } from "../../lib/api";
import { playNotificationChime } from "../../lib/notification-sound";
import type { StoreGet } from "../slices/types";

export type InteractivePromptKind = "ask" | "permission" | "plan";

export type InteractivePromptPayload = {
  question?: string;
  toolName?: string;
  /** Runtime id of the pending request; the durable reminder is keyed by it. */
  requestId?: string;
  /** Turn that is blocked on the request, when the runtime reports one. */
  turnId?: string;
};

export type InteractivePromptNotifier = (
  sessionId: string,
  kind: InteractivePromptKind,
  payload?: InteractivePromptPayload,
) => void;

export function createInteractivePromptNotifier(
  get: StoreGet,
): InteractivePromptNotifier {
  return (sessionId, kind, payload) => {
    const session = get().sessions.find((item) => item.id === sessionId);
    const sessionTitle = session?.title || i18n.t("chat.untitledTask");
    let title = "";
    let body = "";
    if (kind === "ask") {
      // Session titles can contain generated/tool-call text; keep the native
      // banner title stable and let its body carry the actual question.
      title = i18n.t("notifications.askTitle");
      body = payload?.question?.trim() || i18n.t("notifications.askBodyFallback");
    } else if (kind === "permission") {
      title = i18n.t("notifications.permissionTitle", { sessionTitle });
      body = i18n.t("notifications.permissionBody", {
        toolName: payload?.toolName || "tool",
      });
    } else {
      title = i18n.t("notifications.planApprovalTitle", { sessionTitle });
      body = i18n.t("notifications.planApprovalBody");
    }
    playNotificationChime();
    // A prompt toast is sticky (`duration: 0`): the runtime is blocked on the
    // user, so the reminder stays until it is answered, declined, or dismissed
    // instead of disappearing after 8 s while the window was in the background.
    // `promptRequestId` lets the resolution close exactly this reminder.
    get().showToast(`${title}: ${body}`, {
      variant: "info",
      duration: 0,
      sound: false,
      sessionId,
      ...(payload?.requestId ? { promptRequestId: payload.requestId } : {}),
    });
    // The durable row is what survives a missed toast, a hidden window, or a
    // restart: the inbox keeps pointing at the conversation that is waiting.
    if (payload?.requestId) {
      void api
        .recordPromptNotification({
          sessionId,
          requestId: payload.requestId,
          kind,
          ...(payload.toolName ? { toolName: payload.toolName } : {}),
          ...(payload.turnId ? { turnId: payload.turnId } : {}),
        })
        .catch(() => undefined);
    }
    void api
      .showNativeNotification({
        id: crypto.randomUUID(),
        sessionId,
        kind: "interactive",
        title,
        body,
      })
      .catch(() => undefined);
  };
}
