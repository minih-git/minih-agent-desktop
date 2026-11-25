import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";

const { systemRoots } = vi.hoisted(() => ({ systemRoots: [] as string[] }));
vi.mock("node:tls", async (original) => {
  const tls = await original<typeof import("node:tls")>();
  return { ...tls, getCACertificates: (type: Parameters<typeof tls.getCACertificates>[0]) =>
    type === "system" ? [...tls.getCACertificates(type), ...systemRoots] : tls.getCACertificates(type) };
});
import { createSystemProxyFetch } from "./node-proxy.js";
import { startSystemProxyRelay } from "./system-proxy-relay.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function server(body: string) {
  const instance = createServer((_request, response) => response.end(body));
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  cleanups.push(async () => {
    instance.closeAllConnections();
    await new Promise<void>(resolve => instance.close(() => resolve()));
  });
  return address.port;
}
it("uses Node through the selected direct route without changing global fetch", async () => {
  const port = await server("direct provider response");
  const resolveProxy = vi.fn(async () => "DIRECT");
  const relay = await startSystemProxyRelay(resolveProxy);
  cleanups.push(() => relay.close());
  const transport = createSystemProxyFetch(relay.url);
  cleanups.push(() => transport.close());
  const globalFetch = vi.fn().mockRejectedValue(new Error("Chromium is unavailable"));
  vi.stubGlobal("fetch", globalFetch);
  const response = await transport.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { signal: AbortSignal.timeout(2000) });
  expect(await response.text()).toBe("direct provider response");
  expect(resolveProxy).toHaveBeenCalledWith(`http://127.0.0.1:${port}/`);
  expect(globalThis.fetch).toBe(globalFetch);
  expect(globalFetch).not.toHaveBeenCalled();
});
it("honors the proxy route instead of silently connecting directly", async () => {
  const proxyPort = await server("proxy provider response");
  const relay = await startSystemProxyRelay(async () => `PROXY 127.0.0.1:${proxyPort}`);
  cleanups.push(() => relay.close());
  const transport = createSystemProxyFetch(relay.url);
  cleanups.push(() => transport.close());
  const response = await transport.fetch("http://provider.invalid:8127/v1/chat/completions", { signal: AbortSignal.timeout(2000) });
  expect(await response.text()).toBe("proxy provider response");
});
it("rejects an invalid relay instead of silently bypassing the proxy", () => {
  expect(() => createSystemProxyFetch("http://localhost:1234")).toThrow("invalid provider proxy relay");
});
it("preserves cancellation and releases the request before headers", async () => {
  const controller = new AbortController();
  const fixture = createServer(() => controller.abort());
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  cleanups.push(async () => {
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  });
  const relay = await startSystemProxyRelay(async () => "DIRECT");
  cleanups.push(() => relay.close());
  const transport = createSystemProxyFetch(relay.url);
  cleanups.push(() => transport.close());
  await expect(transport.fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
});

it("retains system certificate trust without replacing global TLS defaults", async () => {
  const fixtures = new URL("../../../scripts/e2e/fixtures/certificates/", import.meta.url);
  const cert = await readFile(new URL("localhost-cert.pem", fixtures), "utf8");
  const key = await readFile(new URL("localhost-key.pem", fixtures), "utf8");
  systemRoots.push(cert);
  const fixture = createHttpsServer({ cert, key }, (_request, response) => response.end("trusted response"));
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  cleanups.push(async () => {
    systemRoots.length = 0;
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  });
  const relay = await startSystemProxyRelay(async () => "DIRECT");
  cleanups.push(() => relay.close());
  const transport = createSystemProxyFetch(relay.url);
  cleanups.push(() => transport.close());
  const response = await transport.fetch(`https://localhost:${address.port}/v1/models`, { signal: AbortSignal.timeout(2000) });
  expect(await response.text()).toBe("trusted response");
});

it("shutdown destroys unanswered requests instead of waiting for graceful close", async () => {
  let received!: () => void;
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  const fixture = createServer(() => received());
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  cleanups.push(async () => {
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  });
  const relay = await startSystemProxyRelay(async () => "DIRECT");
  cleanups.push(() => relay.close());
  const transport = createSystemProxyFetch(relay.url);
  const request = transport.fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`);
  const rejected = expect(request).rejects.toThrow();
  await requestReceived;
  await transport.destroy();
  await rejected;
});
