import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The task row's body toggles the log: the clickable surface is the whole lead
 * band (state dot, command, metadata) via the shared Button primitive, while
 * stop / remove keep their own behavior and stay outside it.
 */

const [dock, todoDock, composerStyles] = await Promise.all([
  readFile(new URL("../src/components/TaskDock.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/TodoDock.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8"),
]);

test("the row body is a shared Button that toggles the log", () => {
  const main = dock.match(/<Button[\s\S]*?className="task-main"[\s\S]*?<\/Button>/);
  assert.ok(main, "row body Button missing");
  assert.match(main[0], /type="button"/);
  assert.match(main[0], /variant="ghost"/);
  assert.match(main[0], /aria-expanded=\{expanded\}/);
  assert.match(main[0], /onClick=\{\(\) => onToggleOutput\(task\.id\)\}/);
});

test("the toggle surface covers the state dot, command and meta rows", () => {
  const main = dock.match(/<Button[\s\S]*?className="task-main"[\s\S]*?<\/Button>/)[0];
  for (const className of ["task-state", "task-command", "task-meta"]) {
    assert.match(main, new RegExp(`className="${className}"`));
  }
});

test("the dock header uses the explicit disclosure button and introduces no shimmer", () => {
  assert.match(dock, /<div className="dock-header-main">/);
  assert.doesNotMatch(dock, /<button[^>]*className="dock-header-main"/);
  assert.doesNotMatch(dock, /shimmer/i);
  assert.doesNotMatch(todoDock, /shimmer/i);
});

test("stop and remove stay outside the toggle surface", () => {
  const toggleEnd = dock.indexOf('className="task-main"');
  const bandAt = dock.indexOf('className="task-band"');
  const stopAt = dock.indexOf('"task-action is-stop"');
  const removeAt = dock.indexOf('className="task-action"');
  assert.ok(bandAt > 0 && bandAt < toggleEnd, "the band must wrap the row body");
  assert.ok(stopAt > toggleEnd && removeAt > toggleEnd, "actions must follow the body");
});

test("a running task offers stop and never remove", () => {
  // The two actions are chosen by state in one branch: the stop control gates on
  // `running`, and the remove control lives in the other arm.
  assert.match(dock, /className="task-action is-stop"\s+onClick=\{\(\) => onStop\(task\.id\)\}/);
  assert.match(dock, /className="task-action"\s+onClick=\{\(\) => onRemove\(task\.id\)\}/);
  assert.match(dock, /backgroundTasks\.dismiss/);
  assert.ok(
    dock.indexOf('"task-action is-stop"') < dock.indexOf('className="task-action"'),
    "the stop control comes from the running arm",
  );
});

test("the row styles keep the body clickable and focus-visible", () => {
  assert.match(composerStyles, /\.task-main\s*\{[^{}]*flex: 1 1 auto/);
  assert.match(composerStyles, /\.task-main\s*\{[^{}]*cursor: pointer/);
  assert.match(
    composerStyles,
    /\.task-main:focus-visible\s*\{[^{}]*outline: 2px solid var\(--ds-focus\)/,
  );
});

test("a long command ellipsizes on one line instead of wrapping the row", () => {
  // The band must not wrap, and the command must own the ellipsis, or a long
  // command would push the metadata and its action onto a second line.
  assert.match(composerStyles, /\.task-band\s*\{[^{}]*flex-wrap: nowrap/);
  assert.match(composerStyles, /\.task-command\s*\{[^{}]*text-overflow: ellipsis/);
  assert.match(composerStyles, /\.task-command\s*\{[^{}]*white-space: nowrap/);
});

test("TaskDock renders session-scoped TodoPanel and omits shimmer", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const { catalogs } = await import("@minih-agent/i18n");
  const { createServer } = await import("vite");
  const { fileURLToPath } = await import("node:url");

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TaskDock } = await server.ssrLoadModule("/src/components/TaskDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    const enCatalog = {
      ...catalogs.en,
      backgroundTasks: {
        ...catalogs.en.backgroundTasks,
        headerCount: "{{count}} background tasks",
        removeFailed: "Could not remove this task.",
      },
      taskDock: {
        title: "Todo and background tasks",
        tabTodo: "Todo",
        tabTasks: "Background tasks",
        newTasks: "{{count}} new tasks",
        runningCount: "{{count}} running",
        expand: "Expand {{label}}",
        collapse: "Collapse {{label}}",
      },
    };
    await i18n.init({ lng: "en", resources: { en: { translation: enCatalog } } });
    Object.assign(useAppStore.getInitialState(), {
      sessionTodos: {
        "session-dock-test": {
          sessionId: "session-dock-test",
          revision: 1,
          updatedAt: 100,
          todos: [
            { content: "Ship shared dock", status: "in_progress", priority: "high" },
          ],
        },
      },
    });

    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(TaskDock, { sessionId: "session-dock-test" }),
      ),
    );
    assert.match(html, /class="dock is-expanded"/);
    assert.match(html, /class="dock-header-current" title="Ship shared dock">Ship shared dock<\/span>/);
    assert.match(html, /class="[^"]*\bdock-toggle\b[^"]*"[^>]*aria-expanded="true"/);
    assert.doesNotMatch(html, /shimmer/i);
  } finally {
    await server.close();
  }
});
