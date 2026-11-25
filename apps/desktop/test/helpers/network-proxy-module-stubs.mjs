import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal relay doubles; the cover never reaches the authenticated path. */
const relayStub = {
  startAuthenticatedProxyRelay: async () => ({
    url: "socks5://127.0.0.1:0",
    close: async () => undefined,
  }),
  startSystemProxyRelay: async () => ({
    url: "socks5://127.0.0.1:0",
    close: async () => undefined,
  }),
};

function stub(url) {
  return { url: pathToFileURL(join(here, url)).href, shortCircuit: true };
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return stub("network-proxy-electron-stub.mjs");
  if (specifier === "@minih-agent/agent-runtime") {
    return {
      url: `data:text/javascript,${encodeURIComponent(
        `export const startAuthenticatedProxyRelay = ${relayStub.startAuthenticatedProxyRelay.toString()};
         export const providerTransports = [];
         export const createSystemProxyFetch = () => {
           const state = { closed: false, requests: 0 };
           providerTransports.push(state);
           return { fetch: async () => { state.requests++; return new Response("provider response"); }, close: async () => { state.closed = true; }, destroy: async () => { state.closed = true; } };
         };`,
      )}`,
      shortCircuit: true,
    };
  }
  if (specifier === "@minih-agent/agent-runtime/system-proxy-relay") {
    return {
      url: `data:text/javascript,${encodeURIComponent(
        `export const startSystemProxyRelay = ${relayStub.startSystemProxyRelay.toString()};`,
      )}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
