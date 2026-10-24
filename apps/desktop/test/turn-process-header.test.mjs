import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const tool = (id, offsetSeconds, extra = {}) => ({
  kind: "tool",
  message: {
    id,
    role: "tool",
    content: "",
    toolName: "Read",
    createdAt: `2026-09-17T00:00:${String(offsetSeconds).padStart(2, "0")}.000Z`,
    ...extra,
  },
});

const answer = {
  kind: "message",
  message: {
    id: "answer",
    role: "assistant",
    content: "Done",
    status: "complete",
    createdAt: "2026-09-17T00:00:08.000Z",
  },
};

test("the top-level header renders recorded duration, tool count, issue feedback, narration preview, and omits missing timing", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    resolve: {
      alias: {
        "@minih-agent/plugin-sdk": fileURLToPath(
          new URL("../../../packages/plugin-sdk/src/index.ts", import.meta.url),
        ),
      },
    },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TurnProcess } = await server.ssrLoadModule(
      "/src/features/chat/transcript/TurnProcess.tsx",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = (props, children = "process body") =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(TurnProcess, {
            ...props,
            children: createElement("span", null, children),
          }),
        ),
      );

    const tools = Array.from({ length: 12 }, (_, index) =>
      tool(`tool-${index}`, index === 11 ? 8 : 0),
    );
    const processParts = [{ kind: "activity", items: tools }];
    const turnParts = [...processParts, answer];
    const html = render({
      turnId: "turn",
      processParts,
      turnParts,
      isActive: false,
    });

    assert.match(html, /class="turn-duration">Took 8s<\/span>/);
    assert.match(html, /class="tool-activity-count">12 tools<\/span>/);
    assert.doesNotMatch(html, /turn-process-error/);
    assert.ok(
      html.indexOf("Took 8s") < html.indexOf("12 tools") &&
        html.indexOf("12 tools") < html.indexOf("tool-activity-caret"),
      "duration, tool count and the caret must stay in that order",
    );
    assert.match(html, /aria-expanded="false"/);

    // Recorded issues are preserved alongside the tool count.
    const failedTools = [
      tool("denied", 0, { toolStatus: "denied" }),
      ...Array.from({ length: 8 }, (_, index) => tool(`failed-tool-${index}`, index + 1)),
    ];
    const failedParts = [{ kind: "activity", items: failedTools }];
    const failedHtml = render({
      turnId: "failed-turn",
      processParts: failedParts,
      turnParts: [...failedParts, answer],
      isActive: false,
    });

    assert.match(failedHtml, /class="tool-activity-count">9 tools<\/span>/);
    assert.match(failedHtml, /class="turn-process-error">[\s\S]*?1 issue/);

    // Missing historical timing stays absent rather than fabricating "0s".
    const timelessTools = [
      tool("timeless-1", 0, { createdAt: "invalid-date" }),
      tool("timeless-2", 0, { createdAt: "invalid-date" }),
    ];
    const timelessHtml = render({
      turnId: "timeless-turn",
      processParts: [{ kind: "activity", items: timelessTools }],
      turnParts: [{ kind: "activity", items: timelessTools }, answer],
      isActive: false,
    });

    assert.doesNotMatch(timelessHtml, /0s|turn-duration/);
    assert.match(timelessHtml, /class="tool-activity-label">2 steps<\/span>/);
    assert.match(timelessHtml, /class="tool-activity-count">2 tools<\/span>/);
  } finally {
    await server.close();
  }
});
