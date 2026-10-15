/**
 * Minimal `electron` surface for the network-proxy session cover: a session
 * registry that records the proxy each session receives.
 */
const sessions = new Map();
const sessionHooks = [];

export function createSession(name) {
  const proxies = [];
  const session = {
    name,
    proxies,
    options: undefined,
    setProxy: async (config) => void proxies.push(config),
  };
  sessions.set(name, session);
  return session;
}

export function sessionsByName() {
  return sessions;
}

export function sessionCreatedHooks() {
  return sessionHooks;
}

export const defaultSession = createSession("default");

export const session = {
  defaultSession,
  fromPartition: (partition, options) => {
    const existing = sessions.get(partition);
    if (existing) {
      if (options !== undefined) existing.options = options;
      return existing;
    }
    const created = createSession(partition);
    created.options = options;
    return created;
  },
};

export const app = {
  on: (event, handler) => {
    if (event === "session-created") sessionHooks.push(handler);
  },
};

export const net = { fetch: () => undefined };
