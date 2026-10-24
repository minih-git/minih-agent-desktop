import { readFileSync } from "node:fs";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";

import { withGatewayOriginInHtml } from "./src/lib/csp.js";
import { resolveGatewayOrigin } from "./src/lib/gateway-origin.js";
import { resolveModelGatewayOrigin } from "./src/lib/model-gateway-origin.js";

/**
 * The browser client is served from the same origin as the Gateway it talks to,
 * so production needs no proxy and the CSP keeps `connect-src 'self'`.
 * `pnpm dev` is the exception: the Vite dev server proxies `/hosts` and `/v1`
 * to a local Gateway so the browser still sees one origin. Point it at the
 * Gateway with `VITE_GATEWAY_ORIGIN` and allow the dev origin on the Gateway
 * (`--allowed-origin http://localhost:5173`), because every
 * cookie-authenticated request must carry an `Origin`.
 *
 * `--mode native` is the Capacitor build (PR-5): the webview is not served by
 * the Gateway, so `VITE_GATEWAY_ORIGIN` is required and is also added to the
 * document's `connect-src`. A native build without it fails here, at build
 * time, rather than shipping a bundle that points at the wrong origin.
 *
 * `VITE_MODEL_GATEWAY_ORIGIN` is the second, independent origin direct chat
 * streams from (ADR mobile-direct-gateway-chat §2). It is optional: a build
 * without it still starts and says so on the Chats root. A native build can
 * also switch gateways at runtime, so `connect-src` allows any https or http
 * origin; the baked model gateway joins it exactly as well.
 */
function nativeCspPlugin(origins: { gatewayOrigin: string; modelGatewayOrigin: string | null }): Plugin {
  return {
    name: "minih-remote-native-csp",
    transformIndexHtml: (html) =>
      withGatewayOriginInHtml(html, origins).replace(
        `connect-src 'self' ${origins.gatewayOrigin}`,
        `connect-src 'self' ${origins.gatewayOrigin} https: http:`,
      ),
  };
}

export default defineConfig(({ mode }) => {
  const native = mode === "native";
  const env = loadEnv(mode, ".", "VITE_");
  const devGatewayOrigin = env.VITE_GATEWAY_ORIGIN || "http://127.0.0.1:8788";
  const nativeGatewayOrigin = native ? resolveGatewayOrigin(env.VITE_GATEWAY_ORIGIN) : null;
  // Direct chat streams from the model gateway over WebView fetch, so its origin
  // joins `connect-src` exactly. A build without one still works: the Chats root
  // then says direct chat is unavailable in this build.
  const nativeModelGatewayOrigin = native ? resolveModelGatewayOrigin(env.VITE_MODEL_GATEWAY_ORIGIN) : null;
  const proxy = {
    "/hosts": { target: devGatewayOrigin, changeOrigin: true },
    "/v1": { target: devGatewayOrigin, changeOrigin: true },
  };
  const plugins: PluginOption[] = [react(), tailwindcss()];
  if (nativeGatewayOrigin) {
    plugins.push(
      nativeCspPlugin({
        gatewayOrigin: nativeGatewayOrigin,
        modelGatewayOrigin: nativeModelGatewayOrigin,
      }),
    );
  }
  return {
    plugins,
    server: { proxy },
    preview: { proxy },
    define: {
      // Settings ▸ About shows the real package version. Reading the manifest
      // here is what keeps the number from drifting from `package.json`; a
      // manifest that cannot be read fails the build instead of shipping a
      // version nobody can reproduce.
      __APP_VERSION__: JSON.stringify(readPackageVersion()),
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
  };
});

function readPackageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  );
  const version =
    manifest && typeof manifest === "object" && "version" in manifest
      ? (manifest as { version?: unknown }).version
      : null;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("apps/remote-web/package.json has no version");
  }
  return version;
}
