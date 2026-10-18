import { IPC } from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "../ipc/types";

export type MemoryIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
};

/**
 * Learned-memory IPC (ADR agent-long-term-memory).
 *
 * Every channel is an allowlisted forward to one host RPC. The renderer never
 * reaches SQLite and never names a method: the host owns the write rules, the
 * scope resolution, the tombstones, and the compare-and-set revision. This
 * module therefore checks only the shape it is handed, so a malformed renderer
 * value fails before it reaches the pipe.
 */
export function registerMemoryIpc({ registrar, getHost }: MemoryIpcDependencies): void {
  const forward = async (method: string, params: Record<string, unknown>) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call(method, params);
  };
  const requiredText = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`invalid ${name}`);
    return value;
  };
  const optionalText = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`invalid ${name}`);
    return value;
  };
  const optionalCount = (value: unknown, name: string): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid ${name}`);
    return Math.trunc(value);
  };

  registrar.handle(
    IPC.invoke.memoryList,
    async (request: Record<string, unknown> = {}) => {
      const scope = request?.scope;
      if (scope !== "project" && scope !== "user") throw new Error("invalid memory scope");
      const path = optionalText(request?.path, "path");
      const sessionId = optionalText(request?.sessionId, "sessionId");
      if (scope === "project" && !path && !sessionId) {
        throw new Error("a project scope needs a path or a session");
      }
      const status = optionalText(request?.status, "status");
      const kind = optionalText(request?.kind, "kind");
      const limit = optionalCount(request?.limit, "limit");
      const offset = optionalCount(request?.offset, "offset");
      return forward("memory.list", {
        scope,
        ...(path ? { path } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      });
    },
  );

  registrar.handle(IPC.invoke.memoryUpdate, async (request: Record<string, unknown> = {}) => {
    const id = requiredText(request?.id, "memory id");
    const revision = request?.revision;
    if (typeof revision !== "number" || !Number.isFinite(revision)) {
      throw new Error("invalid memory revision");
    }
    const content = optionalText(request?.content, "content");
    const kind = optionalText(request?.kind, "kind");
    const rationale = optionalText(request?.rationale, "rationale");
    if (content === undefined && kind === undefined && rationale === undefined) {
      throw new Error("an edit changes something");
    }
    return forward("memory.update", {
      id,
      revision: Math.trunc(revision),
      ...(content === undefined ? {} : { content }),
      ...(kind === undefined ? {} : { kind }),
      ...(rationale === undefined ? {} : { rationale }),
    });
  });

  registrar.handle(IPC.invoke.memoryArchive, async (request: Record<string, unknown> = {}) =>
    forward("memory.archive", { id: requiredText(request?.id, "memory id") }),
  );

  registrar.handle(IPC.invoke.memoryRestore, async (request: Record<string, unknown> = {}) =>
    forward("memory.restore", { id: requiredText(request?.id, "memory id") }),
  );

  registrar.handle(IPC.invoke.memoryDelete, async (request: Record<string, unknown> = {}) =>
    forward("memory.delete", { id: requiredText(request?.id, "memory id") }),
  );

  // The receipt's "remember again". The renderer supplies the turn it belongs
  // to, never a message id: the host resolves the cited evidence from that
  // turn's rows, so this channel cannot be used to invent provenance.
  registrar.handle(
    IPC.invoke.memoryRememberAgain,
    async (request: Record<string, unknown> = {}) => {
      const kind = requiredText(request?.kind, "kind");
      const scope = optionalText(request?.scope, "scope") ?? "project";
      const basis = optionalText(request?.basis, "basis") ?? "user_stated";
      return forward("memory.rememberAgain", {
        sessionId: requiredText(request?.sessionId, "sessionId"),
        turnId: requiredText(request?.turnId, "turnId"),
        kind,
        content: requiredText(request?.content, "content"),
        scope,
        basis,
        ...(optionalText(request?.rationale, "rationale")
          ? { rationale: request?.rationale }
          : {}),
      });
    },
  );

  registrar.handle(IPC.invoke.memorySessionGet, async (request: Record<string, unknown> = {}) =>
    forward("memory.session.get", {
      sessionId: requiredText(request?.sessionId, "sessionId"),
    }),
  );

  registrar.handle(
    IPC.invoke.memorySessionSetExcluded,
    async (request: Record<string, unknown> = {}) => {
      if (typeof request?.excluded !== "boolean") throw new Error("invalid excluded");
      return forward("memory.session.setExcluded", {
        sessionId: requiredText(request?.sessionId, "sessionId"),
        excluded: request.excluded,
      });
    },
  );
}
