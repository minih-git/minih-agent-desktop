import { rememberModelInList, saveRecentModels } from "../../lib/recent-models";
import {
  isPluginNotification,
  pluginNotificationTarget,
  type AppNotification,
  type SessionSummary,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { latestSessionOutcomes } from "../../lib/sidebar-session-status";
import { pluginWorkPanelTab } from "../../lib/work-panel-tabs";
import { isRemoteSession } from "../../lib/remote-session-safety";
import type { AppState } from "../app-state";
import type { CatalogRuntime } from "../runtime/catalog-runtime";
import type { SessionRuntime } from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

/**
 * A work-panel plugin view needs a local conversation to own its tab. The code
 * is the stable part — the bell localizes the reason from it — and the message
 * stays a developer-facing detail.
 */
function pluginNotificationViewError(): Error & { code: string } {
  const error = new Error(
    "PLUGIN_NOTIFICATION_VIEW_REQUIRES_SESSION: open a local chat session before opening this plugin view",
  ) as Error & { code: string };
  error.code = "PLUGIN_NOTIFICATION_VIEW_REQUIRES_SESSION";
  return error;
}

/**
 * The row links to a target its plugin no longer offers. The bell localizes the
 * reason from the code; the row itself was still acknowledged as read.
 */
function pluginNotificationTargetError(): Error & { code: string } {
  const error = new Error(
    "PLUGIN_NOTIFICATION_TARGET_UNAVAILABLE: the plugin that delivered this notification no longer offers its target",
  ) as Error & { code: string };
  error.code = "PLUGIN_NOTIFICATION_TARGET_UNAVAILABLE";
  return error;
}

export type CatalogSliceDependencies = StoreAccess & {
  catalogRuntime: CatalogRuntime;
  sessionRuntime: SessionRuntime;
  decorateSessions: (
    sessions: SessionSummary[],
    meta: AppState["sessionMeta"],
  ) => SessionSummary[];
  withoutRecordKey: <T>(record: Record<string, T>, key: string) => Record<string, T>;
};

export function createCatalogSlice({
  get,
  set,
  catalogRuntime,
  sessionRuntime,
  decorateSessions,
  withoutRecordKey,
}: CatalogSliceDependencies): Pick<
  AppState,
  | "rememberModel"
  | "rememberMinihRouterKeyName"
  | "refreshProviders"
  | "loadProviderModels"
  | "refreshPlugins"
  | "refreshPluginThemes"
  | "refreshPluginViews"
  | "refreshNotifications"
  | "receiveNotification"
  | "markNotificationRead"
  | "markAllNotificationsRead"
  | "clearNotifications"
  | "openNotification"
  | "acknowledgeSessionOutcome"
  | "acknowledgePrompt"
> {
  return {
    rememberModel: (model) => {
      const recentModels = rememberModelInList(get().recentModels, model);
      set({ recentModels });
      try {
        saveRecentModels(recentModels);
      } catch (error) {
        console.warn("Could not persist recent model selection", error);
      }
    },
    // In-memory display cache only: the gateway key name fills the sidebar
    // trigger after the first account read, without adding a standing request.
    rememberMinihRouterKeyName: (name) => {
      const keyName = name?.trim() || null;
      if (get().minihRouterKeyName === keyName) return;
      set({ minihRouterKeyName: keyName });
    },
    refreshProviders: async () => {
      const generation = catalogRuntime.beginProviderRefresh();
      const [providers, sessions, settings, onboarding] = await Promise.all([
        api.listProviders(),
        api.listSessions(),
        api.getSettings(),
        api.getOnboarding(),
      ]);
      if (generation !== catalogRuntime.providerGeneration()) return;
      set((state) => ({
        providers: providers.providers,
        providerModels: {},
        sessions: decorateSessions(sessions.sessions, state.sessionMeta),
        settings,
        onboarding,
      }));
    },

    loadProviderModels: async (providerId) => {
      const { refreshedProviderModels, providerModelLoads } = catalogRuntime;
      if (refreshedProviderModels.has(providerId)) return;
      const generation = catalogRuntime.providerGeneration();
      const existing = providerModelLoads.get(providerId);
      if (existing) {
        await existing;
        if (providerModelLoads.get(providerId) === existing) {
          providerModelLoads.delete(providerId);
        }
        if (!refreshedProviderModels.has(providerId)) {
          await get().loadProviderModels(providerId);
        }
        return;
      }

      const load = (async () => {
        let hydrated = (get().providerModels[providerId]?.length ?? 0) > 0;
        if (!hydrated) {
          try {
            const cached = await api.listProviderModels({
              providerId,
              source: "cache",
            });
            if (generation !== catalogRuntime.providerGeneration()) return;
            hydrated = cached.models.length > 0;
            set((state) => ({
              providerModels: {
                ...state.providerModels,
                [providerId]: cached.models,
              },
            }));
          } catch {
            // Continue to live discovery when the local cache is unavailable.
          }
        }

        try {
          const refreshed = await api.listProviderModels({
            providerId,
            source: "refresh",
          });
          if (generation !== catalogRuntime.providerGeneration()) return;
          if (
            (refreshed.source === "remote" || refreshed.source === "fallback") &&
            refreshed.models.length > 0
          ) {
            set((state) => ({
              providerModels: {
                ...state.providerModels,
                [providerId]: refreshed.models,
              },
            }));
          } else if (!hydrated && refreshed.models.length > 0) {
            set((state) => ({
              providerModels: {
                ...state.providerModels,
                [providerId]: refreshed.models,
              },
            }));
          }
        } catch {
          // Keep the cached catalog; the menu already has a usable fallback.
        } finally {
          if (generation === catalogRuntime.providerGeneration()) {
            refreshedProviderModels.add(providerId);
          }
        }
      })();
      providerModelLoads.set(providerId, load);
      try {
        await load;
      } finally {
        if (providerModelLoads.get(providerId) === load) {
          providerModelLoads.delete(providerId);
        }
      }
    },

    refreshPlugins: async () => {
      const existing = catalogRuntime.getPluginRefresh();
      if (existing) return existing;
      const load = (async () => {
        const plugins = await api.listPlugins();
        set({ plugins: plugins.plugins });
      })();
      catalogRuntime.setPluginRefresh(load);
      try {
        await load;
      } finally {
        if (catalogRuntime.getPluginRefresh() === load) {
          catalogRuntime.setPluginRefresh(null);
        }
      }
    },

    refreshPluginThemes: async () => {
      try {
        set({ pluginThemes: await api.listPluginThemes() });
      } catch {
        set({ pluginThemes: [] });
      }
    },

    refreshPluginViews: async () => {
      try {
        set({ pluginViews: await api.listPluginViews() });
      } catch {
        set({ pluginViews: [] });
      }
    },

    refreshNotifications: async () => {
      const generation = catalogRuntime.notificationGeneration();
      const result = await api.listNotifications({ limit: 200 });
      if (generation !== catalogRuntime.notificationGeneration()) return;
      const clearedAt = catalogRuntime.notificationClearedAt();
      const readBefore = catalogRuntime.notificationReadBefore();
      const readIds = catalogRuntime.notificationReadIds;
      // A plugin row names no conversation, so it touches no session outcome.
      const touchedSessionIds = new Set(
        result.notifications
          .map((notification) => notification.sessionId)
          .filter((sessionId): sessionId is string => sessionId !== null),
      );
      const notifications = result.notifications
        .filter((notification) => {
          const createdAt = Date.parse(notification.createdAt);
          return !(
            clearedAt !== null &&
            Number.isFinite(createdAt) &&
            createdAt <= clearedAt
          );
        })
        .map((notification) => {
          // A plugin row is versioned by `createdAt`, not by the click's clock:
          // the host already reports whether the row it holds was read. Letting
          // the local acknowledgement or the read watermark colour it would
          // hide a re-delivered newer version, so plugin rows take the host's
          // answer as it is.
          if (isPluginNotification(notification)) return notification;
          const createdAt = Date.parse(notification.createdAt);
          const acknowledgedById = readIds.has(notification.id);
          const acknowledgedByTime =
            readBefore !== null &&
            Number.isFinite(createdAt) &&
            createdAt <= readBefore;
          if (
            (acknowledgedById || acknowledgedByTime) &&
            !notification.readAt
          ) {
            const acknowledgedAt =
              acknowledgedByTime && readBefore !== null
                ? readBefore
                : Date.now();
            return {
              ...notification,
              readAt: new Date(acknowledgedAt).toISOString(),
            };
          }
          return notification;
        });
      const rawUnreadCount = result.notifications.reduce(
        (count, notification) => count + (notification.readAt ? 0 : 1),
        0,
      );
      const effectiveUnreadCount = notifications.reduce(
        (count, notification) => count + (notification.readAt ? 0 : 1),
        0,
      );
      set((state) => {
        const sessionOutcomes = { ...state.sessionOutcomes };
        for (const sessionId of touchedSessionIds) {
          delete sessionOutcomes[sessionId];
        }
        Object.assign(sessionOutcomes, latestSessionOutcomes(notifications));
        return {
          notifications,
          // Host count includes rows hidden by a local acknowledgement
          // watermark; adjust only for rows present in this response.
          unreadNotificationCount: Math.max(
            0,
            result.unreadCount - rawUnreadCount + effectiveUnreadCount,
          ),
          sessionOutcomes,
        };
      });
    },

    receiveNotification: (notification: AppNotification) => {
      const createdAt = Date.parse(notification.createdAt);
      if (!Number.isFinite(createdAt)) return false;
      const clearedAt = catalogRuntime.notificationClearedAt();
      // A clear is a user decision about everything it covered: a row from that
      // era is not re-lit by a delayed or replayed event.
      if (clearedAt !== null && createdAt <= clearedAt) return false;
      const previous = get().notifications.find(
        (item) => item.id === notification.id,
      );
      if (!isPluginNotification(notification)) {
        // Task and prompt rows are exactly-once per id: a replayed event for a
        // row the user already has (read or not) must not re-light it or replay
        // its native toast, whatever timestamp it carries.
        if (previous) return false;
        if (catalogRuntime.notificationReadIds.has(notification.id)) return false;
        const readBefore = catalogRuntime.notificationReadBefore();
        if (readBefore !== null && createdAt <= readBefore) return false;
      } else if (previous) {
        // A plugin's dedupe key re-delivers the same row: same id, a strictly
        // newer createdAt, unread again. That is a new event for the user, so
        // the id guard and the read watermark must not reject it. The same or an
        // older timestamp is a replay of what the user already settled.
        const previousCreatedAt = Date.parse(previous.createdAt);
        if (
          !Number.isFinite(previousCreatedAt) ||
          createdAt <= previousCreatedAt
        ) {
          return false;
        }
      }
      // A notification event is a state mutation too. Invalidate any list
      // request that was already in flight so its older snapshot cannot erase
      // this newly accepted row when it resolves.
      catalogRuntime.invalidateNotificationRefresh();
      // The re-delivered row is unread again, so drop the local acknowledgement
      // that was recorded when the user read the previous version. Otherwise the
      // next list read would put the read flag back on it.
      if (!notification.readAt) {
        catalogRuntime.forgetNotificationRead(notification.id);
      }
      set((state) => {
        const current = state.notifications.find(
          (item) => item.id === notification.id,
        );
        // The newest version of the row owns its place at the top of the inbox.
        const notifications = [
          notification,
          ...state.notifications.filter((item) => item.id !== notification.id),
        ].slice(0, 200);
        // Prompt rows are reminders, not results: an arriving ask must not
        // replace the session's outcome badge with "completed". Recompute that
        // session from the shared rule so both entry points agree.
        const sessionOutcomes = { ...state.sessionOutcomes };
        const sessionId = notification.sessionId;
        if (sessionId) {
          delete sessionOutcomes[sessionId];
          Object.assign(
            sessionOutcomes,
            latestSessionOutcomes(
              notifications.filter((item) => item.sessionId === sessionId),
            ),
          );
        }
        const unreadDelta =
          (notification.readAt ? 0 : 1) - (current && !current.readAt ? 1 : 0);
        return {
          notifications,
          sessionOutcomes,
          unreadNotificationCount: Math.max(
            0,
            state.unreadNotificationCount + unreadDelta,
          ),
        };
      });
      return true;
    },

    markNotificationRead: async (id) => {
      const item = get().notifications.find((notification) => notification.id === id);
      if (!item || item.readAt) return;
      // A plugin row can be re-delivered under the same id while this call is in
      // flight. The click settles the version that was on screen, so its
      // `createdAt` goes with the request and the local read only applies while
      // the row is still that version. Task and prompt rows keep the old call.
      const pinnedCreatedAt = isPluginNotification(item) ? item.createdAt : null;
      const generation = catalogRuntime.invalidateNotificationRefresh();
      let acknowledged = true;
      try {
        const result = await api.markNotificationRead(
          id,
          pinnedCreatedAt ?? undefined,
        );
        acknowledged = result?.ok !== false;
      } catch (error) {
        if (generation === catalogRuntime.notificationGeneration()) {
          await get().refreshNotifications().catch(() => undefined);
        }
        throw error;
      }
      if (!acknowledged) return;
      const current = get().notifications.find(
        (notification) => notification.id === id,
      );
      if (!current || current.readAt) return;
      if (pinnedCreatedAt !== null && current.createdAt !== pinnedCreatedAt) {
        // A newer version arrived after the click. It is unread, and the user has
        // not seen it, so the acknowledgement ends with the old version.
        return;
      }
      catalogRuntime.rememberNotificationRead(id);
      const readAt = new Date().toISOString();
      set((state) => {
        const notifications = state.notifications.map((notification) =>
          notification.id === id ? { ...notification, readAt } : notification,
        );
        const sessionId = state.notifications.find(
          (notification) => notification.id === id,
        )?.sessionId;
        const sessionOutcomes = { ...state.sessionOutcomes };
        if (sessionId) {
          delete sessionOutcomes[sessionId];
          Object.assign(
            sessionOutcomes,
            latestSessionOutcomes(
              notifications.filter(
                (notification) => notification.sessionId === sessionId,
              ),
            ),
          );
        }
        return {
          notifications,
          unreadNotificationCount: Math.max(
            0,
            state.unreadNotificationCount - 1,
          ),
          sessionOutcomes,
        };
      });
    },

    markAllNotificationsRead: async () => {
      if (get().unreadNotificationCount === 0) return;
      const acknowledged = get().notifications.filter(
        (notification) => !notification.readAt,
      );
      const acknowledgedIds = new Set(
        acknowledged.map((notification) => notification.id),
      );
      // Plugin rows are pinned by the version the user saw. A dedupe re-delivery
      // that lands while this call is in flight is a newer version, and the
      // snapshot (possibly empty) is what stops the host from reading it. Rows of
      // the other families cannot be re-delivered, so they keep the old rule.
      const pinnedPluginVersions = new Map<string, string>(
        acknowledged
          .filter(isPluginNotification)
          .map((notification) => [notification.id, notification.createdAt] as const),
      );
      const requestedAt = Date.now();
      const generation = catalogRuntime.invalidateNotificationRefresh();
      try {
        await api.markAllNotificationsRead({
          pluginRows: [...pinnedPluginVersions].map(([id, createdAt]) => ({
            id,
            createdAt,
          })),
        });
      } catch (error) {
        if (generation === catalogRuntime.notificationGeneration()) {
          await get().refreshNotifications().catch(() => undefined);
        }
        throw error;
      }
      const readAtMs = requestedAt;
      const readAt = new Date(readAtMs).toISOString();
      for (const notification of get().notifications) {
        if (!acknowledgedIds.has(notification.id)) continue;
        const pinned = pinnedPluginVersions.get(notification.id);
        if (pinned !== undefined && notification.createdAt !== pinned) continue;
        catalogRuntime.rememberNotificationRead(notification.id);
      }
      catalogRuntime.setNotificationReadBefore(readAtMs);
      set((state) => {
        const notifications = state.notifications.map((notification) => {
          if (notification.readAt || !acknowledgedIds.has(notification.id)) {
            return notification;
          }
          const pinned = pinnedPluginVersions.get(notification.id);
          if (pinned !== undefined && notification.createdAt !== pinned) {
            // A newer version arrived while the click was in flight; it stays
            // unread and keeps its place at the top of the inbox.
            return notification;
          }
          return { ...notification, readAt };
        });
        // A plugin row has no conversation, so it clears no session outcome.
        const acknowledgedSessionIds = new Set(
          state.notifications
            .filter((notification) => acknowledgedIds.has(notification.id))
            .map((notification) => notification.sessionId)
            .filter((sessionId): sessionId is string => sessionId !== null),
        );
        const sessionOutcomes = { ...state.sessionOutcomes };
        for (const sessionId of acknowledgedSessionIds) {
          delete sessionOutcomes[sessionId];
        }
        Object.assign(
          sessionOutcomes,
          latestSessionOutcomes(
            notifications.filter(
              (notification) =>
                notification.sessionId !== null &&
                acknowledgedSessionIds.has(notification.sessionId),
            ),
          ),
        );
        return {
          notifications,
          unreadNotificationCount: notifications.reduce(
            (count, notification) => count + (notification.readAt ? 0 : 1),
            0,
          ),
          sessionOutcomes,
        };
      });
    },

    clearNotifications: async () => {
      const requestedAt = Date.now();
      const generation = catalogRuntime.invalidateNotificationRefresh();
      try {
        await api.clearNotifications();
      } catch (error) {
        // A failed clear must leave the local inbox usable. The generation
        // invalidation above intentionally discards any older list response;
        // fetch a current snapshot before surfacing the original error.
        if (generation === catalogRuntime.notificationGeneration()) {
          await get().refreshNotifications().catch(() => undefined);
        }
        throw error;
      }
      catalogRuntime.setNotificationClearedAt(requestedAt);
      catalogRuntime.setNotificationReadBefore(requestedAt);
      set({ notifications: [], unreadNotificationCount: 0, sessionOutcomes: {} });
      // A turn that completed after the clear began is a legitimate new result.
      // Reconcile once so it is not lost if its event raced the clear request.
      await get().refreshNotifications();
    },

    openNotification: async (id) => {
      const notification = get().notifications.find((item) => item.id === id);
      if (!notification) return;
      const sessionId = notification.sessionId;
      if (!sessionId) {
        // A plugin row leads to nothing on its own: it is read first, and then
        // only the one view or command its own plugin declared is opened. A row
        // without a link stays read-only, and one whose target is no longer
        // registered opens nothing — never another plugin's surface.
        if (!notification.readAt) {
          await get().markNotificationRead(notification.id);
        }
        const target = pluginNotificationTarget(
          notification,
          get().pluginViews,
        );
        if (!target && notification.linkJson) {
          // The row names a target its plugin no longer offers (disabled,
          // uninstalled, or a registration that failed). Silently treating it as
          // a link-less reminder would claim a click that goes nowhere worked.
          throw pluginNotificationTargetError();
        }
        if (target?.kind === "view") {
          if (target.placement === "sidebar") {
            // The sidebar entry is a toggle for its own row, but a notification
            // click asks to open the view, never to leave it: when it is already
            // the current page, stay there instead of closing it.
            if (
              get().page === "pluginView" &&
              get().pluginViewRef === target.ref
            ) {
              return;
            }
            get().openSidebarPluginView(target.ref);
            return;
          }
          // A work-panel tab is owned by a conversation and the panel is only
          // visible on the chat page, so this needs a local session and a chat
          // page. Without one, opening silently would be a fake success.
          const session = get().activeSessionId
            ? get().sessions.find(
                (candidate) => candidate.id === get().activeSessionId,
              )
            : undefined;
          if (!session || isRemoteSession(session)) {
            throw pluginNotificationViewError();
          }
          if (get().page !== "chat") {
            get().setPage("chat");
          }
          get().openWorkPanelTab(
            pluginWorkPanelTab(target.pluginId, target.viewId),
          );
          return;
        }
        if (target?.kind === "command") {
          // Main resolves the id and checks that this plugin owns it inside the
          // same call, so nothing the renderer looked up earlier can run
          // another plugin's command (no search-then-execute window).
          await api.executePluginNotificationCommand(
            target.pluginId,
            target.commandId,
          );
        }
        return;
      }
      const intent = sessionRuntime.beginNavigationIntent();
      // One bell row stands for the whole conversation (D664), so opening it
      // settles every unread row of that conversation, not just the newest.
      const unread = get().notifications.filter(
        (item) => item.sessionId === sessionId && !item.readAt,
      );
      for (const item of unread) {
        await get().markNotificationRead(item.id);
      }
      if (!sessionRuntime.navigationIntentIsCurrent(intent)) return;
      await get().selectSession(sessionId, {
        navigationIntent: intent,
      });
    },

    acknowledgePrompt: async (requestId) => {
      // The toast is the visible half of the reminder; the durable row is the
      // half that survives a restart. Both are settled here so a resolved
      // request never leaves a sticky toast or an unread inbox entry behind.
      set((state) => ({
        toasts: state.toasts.filter(
          (item) => item.promptRequestId !== requestId,
        ),
      }));
      // A very fast answer can beat the row's own `notification.changed`
      // delivery; reconcile once instead of leaving the reminder unread.
      const findReminder = () =>
        get().notifications.find(
          (item) => item.requestId === requestId && !item.readAt,
        );
      let notification = findReminder();
      if (!notification) {
        await get().refreshNotifications().catch(() => undefined);
        notification = findReminder();
      }
      if (!notification) return;
      await get().markNotificationRead(notification.id);
    },

    acknowledgeSessionOutcome: async (sessionId) => {
      set((state) =>
        state.sessionOutcomes[sessionId]
          ? { sessionOutcomes: withoutRecordKey(state.sessionOutcomes, sessionId) }
          : {},
      );
      const unread = get().notifications.filter(
        (item) => item.sessionId === sessionId && !item.readAt,
      );
      for (const item of unread) {
        await get().markNotificationRead(item.id);
      }
    },
  };
}
