import i18n from "i18next";
import type {
  AskToolResolution,
  PlanResolveRequest,
} from "@minih-agent/shared";
import { api } from "../../lib/api";
import { normalizeSettingsTabId } from "../../lib/settings-search";
import {
  dropAskDraft as removeAskDraft,
  headAsk,
  removeAsk,
  setAskDraft as applyAskDraft,
  type AskDraft,
} from "../../lib/pending-asks";
import {
  headPermission,
  removePermission,
} from "../../lib/pending-permissions";
import type { AppState } from "../app-state";
import type { InteractionRuntime } from "../runtime/interaction-runtime";
import type { SessionRuntime } from "../runtime/session-runtime";
import type { StoreAccess } from "./types";

const PLAN_APPROVAL_TIMEOUT = "PLAN_APPROVAL_TIMEOUT";
const TOAST_TRANSIENT_DURATION_MS = 4000;
const TOAST_TRANSIENT_STACK_LIMIT = 4;

export type InteractionSliceDependencies = StoreAccess & {
  runtime: SessionRuntime;
  interactionRuntime: InteractionRuntime;
};

export function createInteractionSlice({
  get,
  set,
  runtime,
  interactionRuntime,
}: InteractionSliceDependencies): Pick<
  AppState,
  | "setPage"
  | "openSidebarPluginView"
  | "closeSidebarPluginView"
  | "setSettingsTab"
  | "setSettingsAnchor"
  | "canNavBack"
  | "canNavForward"
  | "navBack"
  | "navForward"
  | "resolvePermission"
  | "resolveAsk"
  | "setAskDraft"
  | "dropAskDraft"
  | "resolvePlan"
  | "showToast"
  | "dismissToast"
  | "dismissAssistantErrorMessage"
> {
  return {
    dismissAssistantErrorMessage: (messageId) => {
      if (!messageId) return;
      set((state) => ({
        dismissedAssistantErrorMessages: {
          ...state.dismissedAssistantErrorMessages,
          [messageId]: true,
        },
      }));
    },

    setPage: (page, opts) => {
      runtime.beginNavigationIntent();
      const record = opts?.record !== false;
      set((state) => {
        if (!record) return { page };
        const entry = {
          page,
          sessionId: page === "chat" ? state.activeSessionId : undefined,
          pluginViewRef: page === "pluginView" ? state.pluginViewRef ?? undefined : undefined,
        };
        const stack = state.navStack.slice(0, state.navIndex + 1);
        const last = stack[stack.length - 1];
        const same =
          last?.page === entry.page &&
          last?.sessionId === entry.sessionId &&
          last?.pluginViewRef === entry.pluginViewRef;
        const nextStack = same ? stack : [...stack, entry].slice(-50);
        return {
          page,
          navStack: nextStack,
          navIndex: nextStack.length - 1,
        };
      });
    },

    openSidebarPluginView: (ref) => {
      const state = get();
      // The sidebar entry is a toggle: a second click leaves the page instead
      // of re-opening it, matching every other destination row.
      if (state.page === "pluginView" && state.pluginViewRef === ref) {
        get().closeSidebarPluginView();
        return;
      }
      set({ pluginViewRef: ref });
      get().setPage("pluginView");
    },

    closeSidebarPluginView: () => {
      // Back to where the user came from, and to the conversation when the
      // entry was itself the first page in the stack.
      if (get().canNavBack()) {
        get().navBack();
        return;
      }
      get().setPage("chat");
    },

    setSettingsTab: (settingsTab) => {
      get().setPage("settings");
      set((state) => ({
        // A caller can still name a destination this build folded into another
        // page (an older automation, a restored selection): land on the page
        // that owns the surface instead of an empty pane.
        settingsTab: normalizeSettingsTabId(settingsTab),
        settingsTabNonce: state.settingsTabNonce + 1,
      }));
    },
    setSettingsAnchor: (settingsAnchor) => set({ settingsAnchor }),
    canNavBack: () => get().navIndex > 0,
    canNavForward: () => get().navIndex < get().navStack.length - 1,

    navBack: () => {
      const intent = runtime.beginNavigationIntent();
      const state = get();
      if (state.navIndex <= 0) return;
      const index = state.navIndex - 1;
      const entry = state.navStack[index];
      // A plugin page is identified by its ref as well as its page, so Back has
      // to restore both or it would reopen the previously shown view.
      set({
        navIndex: index,
        page: entry.page,
        ...(entry.page === "pluginView"
          ? { pluginViewRef: entry.pluginViewRef ?? null }
          : {}),
      });
      if (entry.page === "chat" && entry.sessionId) {
        void get().selectSession(entry.sessionId, {
          record: false,
          navigationIntent: intent,
        });
        set({ navIndex: index });
      }
    },

    navForward: () => {
      const intent = runtime.beginNavigationIntent();
      const state = get();
      if (state.navIndex >= state.navStack.length - 1) return;
      const index = state.navIndex + 1;
      const entry = state.navStack[index];
      set({
        navIndex: index,
        page: entry.page,
        ...(entry.page === "pluginView"
          ? { pluginViewRef: entry.pluginViewRef ?? null }
          : {}),
      });
      if (entry.page === "chat" && entry.sessionId) {
        void get().selectSession(entry.sessionId, {
          record: false,
          navigationIntent: intent,
        });
        set({ navIndex: index });
      }
    },

    resolvePermission: async (sessionId, requestId, decision) => {
      const permission = headPermission(get().pendingPermissions, sessionId);
      if (!permission || permission.requestId !== requestId) return;
      // The reminder outlives a failed resolve: only a request the host
      // actually settled may clear its toast and its unread row.
      let resolved = false;
      try {
        await api.resolvePermission({ requestId, decision });
        resolved = true;
      } finally {
        set((state) => ({
          pendingPermissions: removePermission(
            state.pendingPermissions,
            sessionId,
            requestId,
          ),
        }));
        if (resolved) {
          void get().acknowledgePrompt(requestId).catch(() => undefined);
        }
      }
    },

    resolveAsk: async (sessionId, resolution: AskToolResolution) => {
      const ask = headAsk(get().pendingAsks, sessionId);
      if (!ask || ask.requestId !== resolution.requestId) return;
      let resolved = false;
      try {
        await api.resolveAskTool(resolution);
        resolved = true;
      } finally {
        set((state) => ({
          pendingAsks: removeAsk(
            state.pendingAsks,
            sessionId,
            resolution.requestId,
          ),
          askDrafts: removeAskDraft(state.askDrafts, resolution.requestId),
        }));
        if (resolved) {
          void get()
            .acknowledgePrompt(resolution.requestId)
            .catch(() => undefined);
        }
      }
    },

    setAskDraft: (requestId: string, draft: AskDraft) => {
      set((state) => ({
        askDrafts: applyAskDraft(state.askDrafts, requestId, draft),
      }));
    },

    dropAskDraft: (requestId: string) => {
      set((state) => ({
        askDrafts: removeAskDraft(state.askDrafts, requestId),
      }));
    },
    resolvePlan: async (resolution: PlanResolveRequest) => {
      const activeRequest = interactionRuntime.planResolutionRequests.get(
        resolution.proposalId,
      );
      if (activeRequest) return activeRequest;
      const pending = get().pendingPlans[resolution.sessionId];
      if (
        !pending ||
        pending.status !== "pending" ||
        pending.id !== resolution.proposalId
      ) {
        throw new Error(i18n.t("errors.planApprovalUnavailable"));
      }
      const request = (async () => {
        try {
          const result = await api.resolvePlan(resolution);
          get().handlePlansChanged({
            sessionId: resolution.sessionId,
            state: result.state,
            proposal: result.proposal,
            proposalId: result.proposal.id,
            action: result.action,
            targetPermissionMode: result.targetPermissionMode,
          });
          void get().acknowledgePrompt(resolution.proposalId).catch(() => undefined);
          return result;
        } catch (error) {
          if ((error as { code?: unknown })?.code === PLAN_APPROVAL_TIMEOUT) {
            await get().restorePendingPlan(resolution.sessionId);
          }
          throw error;
        }
      })();
      interactionRuntime.planResolutionRequests.set(
        resolution.proposalId,
        request,
      );
      try {
        return await request;
      } finally {
        if (
          interactionRuntime.planResolutionRequests.get(resolution.proposalId) ===
          request
        ) {
          interactionRuntime.planResolutionRequests.delete(resolution.proposalId);
        }
      }
    },

    showToast: (message, options) => {
      const variant = options?.variant ?? "info";
      const duration =
        options?.duration ??
        (variant === "error" || variant === "warning"
          ? 0
          : TOAST_TRANSIENT_DURATION_MS);
      set((state) => {
        const kept = state.toasts.filter(
          (item) => item.message !== message || item.variant !== variant ||
            item.sessionId !== options?.sessionId,
        );
        const newItem = {
          id: interactionRuntime.nextToastId(),
          message,
          variant,
          duration,
          sound: options?.sound !== false,
          sessionId: options?.sessionId,
          promptRequestId: options?.promptRequestId,
        };
        const candidates = [...kept, newItem];
        const transientItems = candidates.filter((item) => item.duration > 0);
        const allowedTransientIds = new Set(
          transientItems
            .slice(-TOAST_TRANSIENT_STACK_LIMIT)
            .map((item) => item.id),
        );
        const next = candidates.filter(
          (item) => item.duration === 0 || allowedTransientIds.has(item.id),
        );
        return { toasts: next };
      });
    },
    dismissToast: (id) =>
      set((state) => ({
        toasts: state.toasts.filter((item) => item.id !== id),
      })),
  };
}
