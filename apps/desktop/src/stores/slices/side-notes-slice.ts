import i18n from "i18next";
import type { SideNote } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { sessionAllows } from "../../lib/remote-session-safety";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";

function mergeNotes(existing: SideNote[], incoming: SideNote[]): SideNote[] {
  return [...new Map([...existing, ...incoming].map(note => [note.id, note])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createSideNotesSlice({ get, set }: StoreAccess): Pick<AppState,
  "sideNotes" | "sideNotePending" | "loadSideNotes" | "sendSideNote"
> {
  return {
    sideNotes: {},
    sideNotePending: {},
    loadSideNotes: async (sessionId) => {
      const session = get().sessions.find(row => row.id === sessionId);
      if (!session || sessionId.startsWith("native-pi:") || !sessionAllows(session, "canSteer")) return;
      try {
        const { notes } = await api.listSideNotes(sessionId);
        set(state => ({ sideNotes: { ...state.sideNotes, [sessionId]: mergeNotes(state.sideNotes[sessionId] ?? [], notes) } }));
      } catch (error) {
        get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      }
    },
    sendSideNote: async (content) => {
      const question = content.trim();
      if (!question) return false;
      const state = get();
      const sessionId = state.activeSessionId;
      const session = state.sessions.find(row => row.id === sessionId);
      const expectedTurnId = sessionId ? state.agentStatuses[sessionId]?.currentTurnId : undefined;
      if (!sessionId || !session || sessionId.startsWith("native-pi:") || !sessionAllows(session, "canSteer") ||
        !expectedTurnId || !state.runningSessions[sessionId] || state.pendingPlans[sessionId]?.status === "pending") {
        state.showToast(i18n.t("chat.steeringUnavailable"), { variant: "info" });
        return false;
      }
      if (state.sideNotePending[sessionId]) return false;
      set(current => ({ sideNotePending: { ...current.sideNotePending, [sessionId]: question } }));
      try {
        const { note } = await api.askSideNote({ sessionId, expectedTurnId, content: question });
        // A late response belongs to the captured session, not the visible one.
        set(current => ({ sideNotes: { ...current.sideNotes, [sessionId]: mergeNotes(current.sideNotes[sessionId] ?? [], [note]) } }));
        return true;
      } catch (error) {
        get().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
        return false;
      } finally {
        set(current => {
          const pending = { ...current.sideNotePending };
          delete pending[sessionId];
          return { sideNotePending: pending };
        });
      }
    },
  };
}
