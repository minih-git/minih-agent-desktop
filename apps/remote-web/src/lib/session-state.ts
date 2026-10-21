/**
 * What a session looks like on the phone (spec §17.4).
 *
 * `RacpSession.status` is a closed union of five values, and it is not enough to
 * say what the user needs to know. Two of the six states this client shows are
 * therefore derived here, on this device, from data the Host already sends:
 *
 * 1. **Finished but not looked at.** `session/list` cannot say whether the user
 *    has seen a finished session. The phone remembers when it last opened one
 *    (`markViewed`), so `updatedAt` newer than that is exactly "finished since
 *    you looked". The limit is stated in the spec: it is per phone, and a
 *    reinstall makes every session "looked at".
 * 2. **Waiting for an answer.** An input request only moves the *turn* to
 *    `waiting_input`; the session itself stays `running`
 *    (`packages/agent-host/src/agent-host.ts:361`), so `session/list` cannot tell
 *    an answered session from a busy one. A delivered `input.requested` push is
 *    the one place the phone learns it, and `markInputPending` is where that
 *    lands. Without notifications the session reads "Running", which is the
 *    honest limit of this approach (§17.4.1).
 *
 * The store holds nothing but timestamps and one flag, per Host, in
 * `localStorage`; it carries no transcript, no title, and no credential.
 */

/** The six states of §17.4, plus the quiet one. */
export type SessionStateView = "approval" | "input" | "running" | "error" | "unseen" | "idle";

/** One session's device-local facts. */
export type SessionLocalState = {
  /** When this device last opened the session. */
  lastViewedAt?: string;
  /** When a push last said the agent is waiting for an answer, cleared on open. */
  inputPendingAt?: string;
};

export type SessionViewsFile = {
  version: 1;
  /** `hostId` → `sessionId` → facts. */
  hosts: Record<string, Record<string, SessionLocalState>>;
};

export const SESSION_VIEWS_STORAGE_KEY = "minih.remote-web.session-views.v1";

/** The slice of `Storage` this needs, so tests can pass a plain map. */
export type ViewsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function emptyFile(): SessionViewsFile {
  return { version: 1, hosts: {} };
}

/**
 * Read the stored file. Anything unreadable is treated as empty rather than
 * thrown: these are display hints, and losing them must never stop a screen from
 * rendering.
 */
function parse(raw: string | null): SessionViewsFile {
  if (!raw) return emptyFile();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyFile();
    const hosts = (parsed as { hosts?: unknown }).hosts;
    if (!hosts || typeof hosts !== "object" || Array.isArray(hosts)) return emptyFile();
    const file = emptyFile();
    for (const [hostId, sessions] of Object.entries(hosts as Record<string, unknown>)) {
      if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) continue;
      const perSession: Record<string, SessionLocalState> = {};
      for (const [sessionId, facts] of Object.entries(sessions as Record<string, unknown>)) {
        if (!facts || typeof facts !== "object") continue;
        const { lastViewedAt, inputPendingAt } = facts as SessionLocalState;
        const entry: SessionLocalState = {};
        if (typeof lastViewedAt === "string") entry.lastViewedAt = lastViewedAt;
        if (typeof inputPendingAt === "string") entry.inputPendingAt = inputPendingAt;
        if (Object.keys(entry).length > 0) perSession[sessionId] = entry;
      }
      if (Object.keys(perSession).length > 0) file.hosts[hostId] = perSession;
    }
    return file;
  } catch {
    return emptyFile();
  }
}

export type SessionViews = {
  get(hostId: string, sessionId: string): SessionLocalState | undefined;
  /** The user opened this session: it is now looked at, and no longer pending an answer. */
  markViewed(hostId: string, sessionId: string, at?: string): void;
  /** A push said the agent is waiting for an answer. */
  markInputPending(hostId: string, sessionId: string, at?: string): void;
  /** Forget one session (its Host was forgotten, or the session is gone). */
  clear(hostId: string, sessionId: string): void;
};

/**
 * A small read/write view over `localStorage`. Every write re-reads the file, so
 * two screens updating different sessions cannot overwrite each other with a
 * stale copy.
 */
export function createSessionViews(storage: ViewsStorage, now: () => string = () => new Date().toISOString()): SessionViews {
  const update = (hostId: string, sessionId: string, change: (current: SessionLocalState) => SessionLocalState | null): void => {
    const file = parse(storage.getItem(SESSION_VIEWS_STORAGE_KEY));
    const perHost = file.hosts[hostId] ?? {};
    const next = change(perHost[sessionId] ?? {});
    if (next && Object.keys(next).length > 0) perHost[sessionId] = next;
    else delete perHost[sessionId];
    if (Object.keys(perHost).length > 0) file.hosts[hostId] = perHost;
    else delete file.hosts[hostId];
    storage.setItem(SESSION_VIEWS_STORAGE_KEY, JSON.stringify(file));
  };

  return {
    get(hostId, sessionId) {
      return parse(storage.getItem(SESSION_VIEWS_STORAGE_KEY)).hosts[hostId]?.[sessionId];
    },
    markViewed(hostId, sessionId, at) {
      update(hostId, sessionId, (current) => ({ ...current, lastViewedAt: at ?? now(), inputPendingAt: undefined }));
    },
    markInputPending(hostId, sessionId, at) {
      update(hostId, sessionId, (current) => ({ ...current, inputPendingAt: at ?? now() }));
    },
    clear(hostId, sessionId) {
      update(hostId, sessionId, () => null);
    },
  };
}

/** The in-memory store the tests and the browser-less builds use. */
export function memorySessionViews(): ViewsStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

/**
 * The one function every status mark goes through (spec §17.4).
 *
 * The order is the whole point:
 *
 * - an approval outranks everything, because the Host reports a running turn
 *   beside it while a tool waits;
 * - a failure outranks a stale answer flag: a marker written by a push that the
 *   user then answered on the computer must not hide the failed turn;
 * - the answer flag only applies while the session is still running, which is
 *   the only state the Host leaves it in when it waits for an answer, so a flag
 *   that outlived its request cannot make a finished session look busy.
 */
export function sessionStateOf(
  session: { status: string; planningState?: string; updatedAt?: string },
  local?: SessionLocalState,
): SessionStateView {
  if (session.status === "waiting_permission" || session.planningState === "awaiting_approval") return "approval";
  if (session.status === "error") return "error";
  if (session.status === "running") return local?.inputPendingAt ? "input" : "running";
  if (session.status === "idle" || session.status === "aborted") {
    const seen = local?.lastViewedAt ? Date.parse(local.lastViewedAt) : Number.NaN;
    const updated = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
    if (Number.isNaN(seen) || Number.isNaN(updated)) return "idle";
    return updated > seen ? "unseen" : "idle";
  }
  return "idle";
}

/** A session the user has to act on, which is what "Needs you" collects. */
export function needsUser(view: SessionStateView): boolean {
  return view === "approval" || view === "input";
}
