import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/*
 * The `html` fence preview renders model-written markup, so the behaviour that
 * matters is where it renders and what the frame may do. These cases drive the
 * real `Markdown.tsx` through Vite SSR, so the production chain runs: fence
 * detection, the closed-fence gate, the opt-in gate and the sandbox attribute.
 */

const LOCALES = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];
const PREVIEW_KEYS = [
  "showHtml",
  "showHtmlSource",
  "runHtmlScripts",
  "htmlPreview",
  "htmlPreviewTooLarge",
];

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const FENCE = "```html\n<button>Save</button><script>alert(1)</script>\n```";

/** The first iframe tag of a rendered fragment, or null. */
const iframeTag = (html) => (html.match(/<iframe[^>]*>/) ?? [])[0] ?? null;

test("an html fence previews in an answer surface and stays source elsewhere", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  try {
    // `useThemeMode` reads the theme off the document during render.
    globalThis.document = { documentElement: { dataset: {} } };
    const { Markdown } = await server.ssrLoadModule(
      "/src/components/Markdown.tsx",
    );
    const { catalogs } = await server.ssrLoadModule("@minih-agent/i18n");
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en } },
    });
    const render = (props) =>
      renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(Markdown, props)),
      );

    // A closed fence on an opted-in surface renders, script-free by default.
    const answer = render({ source: FENCE, renderHtml: true });
    const frame = iframeTag(answer);
    assert.ok(frame, "a closed html fence should render a frame");
    assert.match(frame, /sandbox=""/);
    assert.doesNotMatch(frame, /allow-scripts/);
    // The toolbar offers source/preview, a script toggle and copy. Their labels
    // come from the locale catalogs, which the i18n suites cover.
    assert.equal((answer.match(/class="html-action-btn"/g) ?? []).length, 3);

    // The fence tag is case-insensitive, like the mermaid gate.
    assert.ok(
      iframeTag(
        render({ source: FENCE.replace("html", "HTML"), renderHtml: true }),
      ),
      "an uppercase fence tag should render too",
    );

    // Surfaces that do not opt in keep the source block: the file preview, a
    // plugin README, a side note and a subagent reply all render Markdown
    // without `renderHtml`.
    assert.equal(iframeTag(render({ source: FENCE })), null);
    assert.equal(
      iframeTag(render({ source: FENCE, renderDiagrams: false })),
      null,
      "a thinking trace keeps the fence as source",
    );

    // A fence that is still streaming has no closing fence yet.
    assert.equal(
      iframeTag(
        render({
          source: "```html\n<button>Save</button>",
          streaming: true,
          renderHtml: true,
        }),
      ),
      null,
      "an open fence should not render",
    );

    // The size cap fails closed to the source view.
    const oversized = render({
      source: `\`\`\`html\n${"x".repeat(100_001)}\n\`\`\``,
      renderHtml: true,
    });
    assert.equal(iframeTag(oversized), null);
    assert.match(oversized, /class="html-block-error"/);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});

test("the preview widens no policy and the frame gets no preload", async () => {
  const [indexHtml, windowSource] = await Promise.all([
    read("../index.html"),
    read("../electron/main/bootstrap/window.ts"),
  ]);
  assert.match(indexHtml, /default-src 'self'/);
  assert.doesNotMatch(indexHtml, /frame-src/);
  // Frames carry no preload bridge, so sandboxed markup cannot reach IPC.
  assert.doesNotMatch(windowSource, /nodeIntegrationInSubFrames:\s*true/);
  assert.match(windowSource, /sandbox: true,/);
  assert.match(windowSource, /contextIsolation: true,/);
});

test("every locale carries the html preview strings", async () => {
  const sources = await Promise.all(
    LOCALES.map((locale) =>
      read(`../../../packages/i18n/src/locales/${locale}/index.ts`),
    ),
  );
  sources.forEach((source, index) => {
    for (const key of PREVIEW_KEYS) {
      assert.match(
        source,
        new RegExp(`"?${key}"?:`),
        `${LOCALES[index]} is missing ${key}`,
      );
    }
  });
});
