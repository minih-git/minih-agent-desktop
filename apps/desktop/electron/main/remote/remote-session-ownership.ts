/**
 * Which sessions on an account computer this desktop started.
 *
 * An account computer is another desktop of the same account, and its
 * `session/list` answers every conversation on that machine — including the
 * ones its own user had there. Those are not this desktop's: the sidebar shows
 * only the sessions this desktop created (in a project the user added here) or
 * forked from one of them. This file is that record, `<dataDir>/<fileName>`,
 * keyed by host key. It holds session ids only, never content or credentials.
 *
 * A missing file is an empty record, so after upgrade nothing from another
 * computer is listed until the user opens a project on it from here. Entries
 * are kept when a computer leaves the roster: a transient empty roster must not
 * hide the conversations again once the computer returns.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

type SerializedFile = { version: 1; hosts: Record<string, string[]> };

export type RemoteSessionOwnershipOptions = {
  dataDir: string;
  fileName?: string;
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};

export interface RemoteSessionOwnership {
  /** Read the file once; every later call shares the same load. */
  load(): Promise<void>;
  has(hostKey: string, hostSessionId: string): boolean;
  add(hostKey: string, hostSessionId: string): Promise<void>;
  remove(hostKey: string, hostSessionId: string): Promise<void>;
}

export function createRemoteSessionOwnership(options: RemoteSessionOwnershipOptions): RemoteSessionOwnership {
  const log = options.log ?? (() => undefined);
  const filePath = join(options.dataDir, options.fileName ?? "remote-account-sessions.json");
  const hosts = new Map<string, Set<string>>();
  let loading: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  const read = async () => {
    let raw: string;
    try { raw = await readFile(filePath, "utf8"); }
    catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") log("warn", "remote session ownership read failed", { error: String(error) });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SerializedFile>;
      if (parsed.version !== 1 || !parsed.hosts || typeof parsed.hosts !== "object") throw new Error("unsupported shape");
      for (const [hostKey, ids] of Object.entries(parsed.hosts)) {
        if (!Array.isArray(ids)) continue;
        hosts.set(hostKey, new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)));
      }
    } catch (error) {
      log("warn", "remote session ownership file rejected; starting empty", { file: filePath, error: String(error) });
    }
  };

  const persist = () => {
    const file: SerializedFile = {
      version: 1,
      hosts: Object.fromEntries([...hosts].filter(([, ids]) => ids.size > 0).map(([key, ids]) => [key, [...ids]])),
    };
    const write = writes.then(async () => {
      const tmp = `${filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, filePath);
    });
    writes = write.catch(() => undefined);
    return write;
  };

  return {
    load() { return (loading ??= read()); },
    has(hostKey, id) { return hosts.get(hostKey)?.has(id) === true; },
    async add(hostKey, id) {
      await this.load();
      const ids = hosts.get(hostKey) ?? new Set<string>();
      if (ids.has(id)) return;
      ids.add(id);
      hosts.set(hostKey, ids);
      await persist();
    },
    async remove(hostKey, id) {
      await this.load();
      if (!hosts.get(hostKey)?.delete(id)) return;
      await persist();
    },
  };
}
