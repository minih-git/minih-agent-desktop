import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("tool rows retain skill and extension identities at every density and status", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { ToolRow } = await vite.ssrLoadModule("/src/features/chat/transcript/ToolRow.tsx");
    const { catalogs } = await vite.ssrLoadModule("/../../packages/i18n/src/index.ts");
    const { SlotSessionProvider } = await vite.ssrLoadModule("/src/plugins/renderer-slots/use-slots.tsx");
    for (const locale of ["en", "zh-CN"]) {
      const i18n = createInstance();
      await i18n.init({ lng: locale, resources: { [locale]: { translation: catalogs[locale] } } });
      const render = (toolName, toolArgs, dense, toolStatus) => renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(SlotSessionProvider, { sessionId: "identity-fixture" },
          createElement(ToolRow, { dense, message: { id: "identity", role: "tool", content: "",
            createdAt: "2026-10-18T00:00:00Z", toolName, toolArgs, toolStatus } }))),
      );
      for (const dense of [true, false]) {
        for (const status of ["running", "success", "error", "denied"]) {
          for (const [name, args, identity, icon] of [
            ["Skill", { id: "obsidian-knowledge" }, "obsidian-knowledge", "book-open"],
            ["functions.Skill", { skill: "publisher/review" }, "publisher/review", "book-open"],
            ["mcp_personal_knowledge_knowledge_context", { topic: "servers" }, "mcp_personal_knowledge_knowledge_context", "server"],
            ["mcp_personal_knowledge_knowledge_read", { path: "servers.md" }, "mcp_personal_knowledge_knowledge_read", "server"],
            ["plugin_notes_search", { query: "servers" }, "plugin_notes_search", "plug"],
            ["CustomTool", { id: "opaque" }, "CustomTool", "wrench"],
          ]) {
            const html = render(name, args, dense, status);
            assert.match(html, new RegExp(`class="[^"]*tool-row-identity[^"]*"[^>]*>${identity}</span>`), `${locale}/${dense}/${status}/${name}`);
            assert.match(html, new RegExp(`lucide-${icon}`));
            assert.match(html, /aria-expanded="false"/);
            if (name.startsWith("mcp_")) assert.match(html, />MCP</);
            if (status === "running") assert.match(html, /tool-spinner/);
            if (status === "error") assert.match(html, /tool-row-status error/);
            if (status === "denied") assert.match(html, new RegExp(i18n.t("chat.toolDenied")));
          }
        }
      }
      assert.doesNotMatch(render("Read", { path: "a.ts" }, true, "success"), /tool-row-identity/);
      assert.doesNotMatch(render("Bash", { command: "echo hello" }, true, "success"), /tool-row-identity/);
    }
  } finally { await vite.close(); }
});
