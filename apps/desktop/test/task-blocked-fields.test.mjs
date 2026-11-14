import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { createServer } from "vite";

/*
 * What a stopped task's card is allowed to say about why it stopped.
 *
 * 「你手动停了这个任务。」 is a claim about the person: it may only appear when the
 * host recorded exactly that. A relay step whose predecessor was abandoned has
 * its own line saying which step that was, and a reason this card does not know
 * says only that the task stopped — attributing either to the person would tell
 * them they did something they did not do.
 */

async function load(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(async () => server.close());
  return {
    render: (element) => {
      const i18n = createInstance();
      i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
      return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
    },
    load: (path) => server.ssrLoadModule(path),
  };
}

const task = (patch) => ({
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "222222",
  employeeSessionId: "router",
  sessionId: "sess-step-two",
  title: "回填并切换读路径",
  origin: "steward",
  stage: "blocked",
  projectPath: "/repo/Minih-Agent-Desktop",
  createdAt: "2026-11-14T01:05:00.000Z",
  workspaceStatus: "ready",
  ...patch,
});

test("a relay step says which step it lost, not that the person stopped it", async (t) => {
  const { load: loadModule, render } = await load(t);
  const { blockedFields } = await loadModule("/src/features/bots/task-waiting.ts");
  const { TaskBlockedCard } = await loadModule("/src/features/bots/TaskBlockedCard.tsx");
  for (const reason of ["relay-orphaned", "relay-base"]) {
    const stuck = task({ blocker: { reason, parent: "111111" } });
    assert.equal(blockedFields(stuck).source, "relay", `${reason} became a different source`);
    const html = render(createElement(TaskBlockedCard, { task: stuck, employeeName: "Router" }));
    assert.ok(!html.includes("data-blocked-stopped"), `${reason} claimed the person stopped it`);
    assert.ok(html.includes(`data-blocked-relay="${reason}"`), `${reason} lost its own line`);
  }
});

test("a reason the card does not know is not attributed to the person", async (t) => {
  const { load: loadModule, render } = await load(t);
  const { blockedFields } = await loadModule("/src/features/bots/task-waiting.ts");
  const { TaskBlockedCard } = await loadModule("/src/features/bots/TaskBlockedCard.tsx");
  const stuck = task({ blocker: { reason: "some-future-reason" } });
  assert.equal(blockedFields(stuck).source, "unknown");
  const html = render(createElement(TaskBlockedCard, { task: stuck, employeeName: "Router" }));
  assert.ok(!html.includes("data-blocked-stopped"), "an unknown reason claimed a manual stop");
  assert.ok(html.includes("data-blocked-unknown"), "an unknown reason said nothing at all");
});

test("a task the person stopped still says so", async (t) => {
  const { load: loadModule, render } = await load(t);
  const { blockedFields } = await loadModule("/src/features/bots/task-waiting.ts");
  const { TaskBlockedCard } = await loadModule("/src/features/bots/TaskBlockedCard.tsx");
  const stopped = task({ blocker: { reason: "stopped" } });
  assert.deepEqual(blockedFields(stopped), { source: "stopped" });
  const html = render(createElement(TaskBlockedCard, { task: stopped, employeeName: "Router" }));
  assert.ok(html.includes("data-blocked-stopped"), "a manual stop is no longer reported");
});

test("a failed turn is a failure, reported or not", async (t) => {
  const { load: loadModule } = await load(t);
  const { blockedFields } = await loadModule("/src/features/bots/task-waiting.ts");
  assert.deepEqual(blockedFields(task({ stage: "failed" })), { source: "failed" });
  assert.deepEqual(blockedFields(task({ stage: "failed", blocker: { reason: "error", code: "E_MERGE" } })), {
    source: "failed",
    code: "E_MERGE",
  });
});