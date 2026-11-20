import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("plugin task permission cards omit session-wide approval", async (t) => {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@minih-agent/shared": fileURLToPath(new URL("../../../packages/shared/src/index.ts", import.meta.url)) } },
  });
  t.after(() => server.close());
  const { PermissionCard } = await server.ssrLoadModule("/src/components/PermissionCard.tsx");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: { permission: {
    title: "Permission", deny: "Deny", allowSession: "Allow session", allowOnce: "Allow once",
    allowPrompt: "Allow {{tool}}?", workspace: "Workspace {{workspace}}", temporarySession: "temporary", risk: { high: "High" },
  } } } } });
  const permission = { requestId: "r", sessionId: "s", toolCallId: "c", toolName: "Bash", argsPreview: {}, risk: "high", reason: "Runs a command" };
  const render = (perCallOnly) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(PermissionCard, { permission: { ...permission, perCallOnly } })));
  assert.match(render(false), /Allow session/);
  const restricted = render(true);
  assert.doesNotMatch(restricted, /Allow session/);
  assert.match(restricted, /Allow once/);
  assert.match(restricted, /Deny/);
});
