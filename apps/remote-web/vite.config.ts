import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";

import { withGatewayOriginInHtml } from "./src/lib/csp.js";
import { resolveGatewayOrigin } from "./src/lib/gateway-origin.js";

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
 */
function nativeCspPlugin(gatewayOrigin: string): Plugin {
  return {
    name: "minih-remote-native-csp",
    transformIndexHtml: (html) => withGatewayOriginInHtml(html, gatewayOrigin),
  };
}

export default defineConfig(({ mode }) => {
  const native = mode === "native";
  const env = loadEnv(mode, ".", "VITE_");
  const devGatewayOrigin = env.VITE_GATEWAY_ORIGIN || "http://127.0.0.1:8788";
  const nativeGatewayOrigin = native ? resolveGatewayOrigin(env.VITE_GATEWAY_ORIGIN) : null;
  const proxy = {
    "/hosts": { target: devGatewayOrigin, changeOrigin: true },
    "/v1": { target: devGatewayOrigin, changeOrigin: true },
  };
  const plugins: PluginOption[] = [react(), tailwindcss()];
  if (nativeGatewayOrigin) plugins.push(nativeCspPlugin(nativeGatewayOrigin));
  return {
    plugins,
    server: { proxy },
    preview: { proxy },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
  };
});
