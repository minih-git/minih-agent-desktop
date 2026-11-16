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
 * An answer that renders HTML renders a page. `answer-me-with-html` writes that
 * page to disk and links it, so the link itself has to reach the page renderer
 * in an answer surface — and stay an ordinary link everywhere else, where the
 * surface never opted into rendering markup.
 *
 * These cases drive the real `Markdown.tsx` through Vite SSR, so the production
 * chain runs: link detection, the `renderHtml` gate, and the handover to the
 * component that reads the page back from the host.
 */

const LOCAL_PAGE = "[打开页面 · 自检](file:///tmp/report.html)";
const LOCAL_PAGE_SLOT = /class="html-page-slot"/;

test("a local page link becomes the page in an answer surface only", async () => {
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
    const { Markdown } = await server.ssrLoadModule("/src/components/Markdown.tsx");
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

    // The answer surface hands the link to the page renderer, which shows the
    // link itself until the host read lands.
    const answer = render({ source: LOCAL_PAGE, renderHtml: true });
    assert.match(answer, LOCAL_PAGE_SLOT);
    assert.match(answer, /打开页面 · 自检/);

    // A surface that never opted into rendering markup keeps a plain link: the
    // file preview, a plugin README, a side note and a subagent reply.
    assert.doesNotMatch(render({ source: LOCAL_PAGE }), LOCAL_PAGE_SLOT);

    // Only a local `.html` page is a page. Any other local file keeps its own
    // destination, and a remote page is never read from this machine.
    for (const source of [
      "[notes](file:///tmp/notes.md)",
      "[report](https://example.com/report.html)",
      "[shared](file://fileserver/share/report.html)",
    ]) {
      assert.doesNotMatch(render({ source, renderHtml: true }), LOCAL_PAGE_SLOT, source);
    }

    // A `file://` reference the host has not confirmed stays plain text, so a
    // link to nothing never turns into an empty frame.
    assert.doesNotMatch(render({ source: LOCAL_PAGE, renderHtml: true }), /<iframe/);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});

test("the page reads through the host with the session it belongs to", async () => {
  const pageLink = await readFile(
    new URL("../src/components/LocalHtmlPageLink.tsx", import.meta.url),
    "utf8",
  );
  // The renderer never reads the file itself: it asks the host for this path
  // and this session, so roots, remote workspaces and the size cap stay there.
  assert.match(pageLink, /api\.fsRead\(path, "text\/html", sessionId\)/);
  // A read that has not landed, failed, or exceeded the cap keeps the link.
  assert.match(pageLink, /page\.status !== "ready"/);
  // The page renders in the same sandbox the `html` fence uses, scripts off.
  assert.doesNotMatch(pageLink, /allow-scripts/);
});

/*
 * The page card's toolbar is one place, shared by a fence and a linked page.
 * A fence has no file on disk, so it can only offer actions about its markup;
 * a linked page was read from a file this computer owns, so it also offers the
 * system file manager. Both shapes are rendered here from the real component.
 */
test("the reveal action sits beside the panel one and only for a linked page", async () => {
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
    globalThis.document = { documentElement: { dataset: {} } };
    const { HtmlPreviewBlock } = await server.ssrLoadModule(
      "/src/components/HtmlPreviewBlock.tsx",
    );
    const { catalogs } = await server.ssrLoadModule("@minih-agent/i18n");
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en } },
    });
    const labels = (html) =>
      [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    const render = (props) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(HtmlPreviewBlock, { code: "<p>page</p>", ...props }),
        ),
      );

    // A linked page: the reveal action follows the panel one, and the source,
    // script and copy actions stay where they were.
    const page = render({
      title: "report.html",
      onOpenInPanel: () => {},
      onRevealInFolder: () => {},
    });
    assert.deepEqual(labels(page), [
      "Show HTML source",
      "Run scripts",
      "Open in work panel",
      "Reveal in Finder",
      "Copy",
    ]);

    // A session that may not touch local files, or a card given no callback,
    // keeps the panel destination and offers no system action.
    assert.deepEqual(
      labels(render({ title: "report.html", onOpenInPanel: () => {} })),
      ["Show HTML source", "Run scripts", "Open in work panel", "Copy"],
    );

    // A plain fence has no file behind it at all.
    const fence = render({});
    assert.equal((fence.match(/class="html-action-btn"/g) ?? []).length, 3);
    assert.doesNotMatch(fence, /Reveal in Finder/);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});

/*
 * The card decides what the toolbar offers, so the page link is what supplies
 * the file action: the same reference, resolved by the same click handler, with
 * the markdown base the link keeps and the reveal destination. The resolution
 * and reveal contract itself is covered by
 * `chat-file-open-with-menu.test.mjs`, which asserts a base directory reaches
 * `fs/resolveRef` and the resolved file reaches `fs/reveal`.
 */
test("the page link reveals the file it was read from, only where it may", async () => {
  const pageLink = await readFile(
    new URL("../src/components/LocalHtmlPageLink.tsx", import.meta.url),
    "utf8",
  );
  assert.match(pageLink, /const nativeFilesAllowed = useChatNativeFilesAllowed\(\)/);
  assert.match(
    pageLink,
    /nativeFilesAllowed\s*\?\s*\(\)\s*=>\s*openFileRef\(path, baseDir, undefined, \{\s*destination: "reveal-in-folder",\s*\}\)\s*:\s*undefined/,
  );
  // The panel destination the card already had is untouched.
  assert.match(pageLink, /onOpenInPanel=\{\(\) => openFileRef\(path, baseDir\)\}/);
});