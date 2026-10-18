import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * The H5 client is served from the same origin as the Gateway it talks to
 * (the CSP allows `connect-src 'self'` only), so production needs no proxy.
 * `pnpm dev` is the exception: the Vite dev server proxies `/hosts` and `/v1`
 * to a local Gateway so the browser still sees one origin. Point it at the
 * Gateway with `VITE_GATEWAY_ORIGIN` and allow the dev origin on the Gateway
 * (`--allowed-origin http://localhost:5173`), because every cookie-authenticated
 * request must carry an `Origin`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  const gatewayOrigin = env.VITE_GATEWAY_ORIGIN || "http://127.0.0.1:8788";
  const proxy = {
    "/hosts": { target: gatewayOrigin, changeOrigin: true },
    "/v1": { target: gatewayOrigin, changeOrigin: true },
  };
  return {
    plugins: [react(), tailwindcss()],
    server: { proxy },
    preview: { proxy },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
  };
});
