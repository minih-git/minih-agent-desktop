import { randomUUID } from "node:crypto";
import { IPC, type AgentSideNoteRequest, type SideNote, type MessageUsage } from "@minih-agent/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerSideNotesIpc(deps: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  isTurnDispatchable: (sessionId: string, turnId: string | null | undefined) => boolean;
}): void {
  const pending = new Set<string>();
  const sessionIdFrom = (input: unknown): string => {
    const id = input && typeof input === "object" ? Reflect.get(input, "sessionId") : undefined;
    if (typeof id !== "string" || !id.trim() || id.startsWith("native-pi:") || id.startsWith("remote:")) {
      throw Object.assign(new Error("Side notes require a local Desktop session"), { errorCode: "INVALID_ARGUMENT" });
    }
    return id;
  };
  deps.registrar.handle(IPC.invoke.agentSideNotesList, async (input: { sessionId: string }) => {
    const sessionId = sessionIdFrom(input);
    const host = deps.getHost();
    if (!host) throw new Error("Side-note history unavailable: backend unavailable");
    return host.call<{ notes: SideNote[] }>("session.sideNotes.list", { sessionId });
  });
  deps.registrar.handle(IPC.invoke.agentSideNote, async (req: AgentSideNoteRequest) => {
    const sessionId = sessionIdFrom(req);
    if (typeof req.content !== "string" || !req.content.trim() || req.content.length > 32_768 || typeof req.expectedTurnId !== "string" || !req.expectedTurnId) {
      throw Object.assign(new Error("Side-note question and expectedTurnId required (maximum 32768 characters)"), { errorCode: "INVALID_ARGUMENT" });
    }
    if (!deps.isTurnDispatchable(sessionId, req.expectedTurnId)) {
      throw Object.assign(new Error("The target task has ended"), { errorCode: "TURN_NOT_FOUND" });
    }
    if (pending.has(sessionId)) throw Object.assign(new Error("A side-note answer is already pending"), { errorCode: "AGENT_BUSY" });
    const host = deps.getHost();
    const sidecar = deps.getSidecar();
    if (!host || !sidecar) throw new Error("Side-note answer unavailable: backend unavailable");
    pending.add(sessionId);
    try {
      const { notes } = await host.call<{ notes: SideNote[] }>("session.sideNotes.list", { sessionId });
      const result = await sidecar.call<{ text: string; usage?: MessageUsage }>("agent.sideNote", {
        sessionId, expectedTurnId: req.expectedTurnId, content: req.content.trim(), history: notes.slice(-20),
      });
      const note: SideNote = { id: randomUUID(), question: req.content.trim(), answer: result.text, createdAt: new Date().toISOString(), ...(result.usage ? { usage: result.usage } : {}) };
      // The parent can have completed while answering. Only the owning session
      // must still exist; Host refuses a deleted session rather than recreating it.
      return await host.call<{ note: SideNote }>("session.sideNotes.append", { sessionId, note });
    } finally { pending.delete(sessionId); }
  });
}
