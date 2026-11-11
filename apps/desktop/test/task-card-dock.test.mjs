import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { ErrorCodes } from "@minih-agent/shared";
import { createServer } from "vite";

/*
 * The steward's task card (ADR bot-sessions-and-steward §3). Two rules are the
 * whole point, and both are observable:
 *
 * - the click sends the hash that is on screen, so a revise in between cannot
 *   approve text nobody read;
 * - a CONFLICT repaints the host's card and asks again, and never retries the
 *   confirmation by itself.
 */

const baseCard = () => ({
  goal: "Ship the employee surface",
  criteria: [
    { id: "c1", text: "Sidebar group lists employees" },
    { id: "c2", text: "Dock appears above the composer" },
  ],
  boundaries: ["Do not touch main"],
  permissionMode: "ask",
  mustAsk: ["deploy", "delete", "spend"],
  risk: "medium",
});

const draft = (patch = {}) => ({
  id: "draft-1",
  sessionId: "steward-1",
  status: "proposed",
  sourceUtterance: "让员工模式先能看见",
  targetSessionId: "bot-1",
  targetTitle: "Desktop 前端",
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  ...patch,
  // After the spread: a patch's `card` is a partial overlay, not a replacement.
  card: { ...baseCard(), ...patch.card },
  cardHash: patch.cardHash ?? "hash-abc",
});

async function renderer(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  t.after(async () => server.close());
  return {
    load: (path) => server.ssrLoadModule(path),
    render: (element) =>
      renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element)),
  };
}

test("a click sends the hash that is displayed, unchanged", async (t) => {
  const { load } = await renderer(t);
  const { confirmRequest } = await load("/src/features/bots/task-card-dock.ts");
  assert.deepEqual(confirmRequest(draft({ cardHash: "hash-from-screen" })), {
    draftId: "draft-1",
    cardHash: "hash-from-screen",
  });
});

test("a conflict is recognised as its own outcome, other failures are not", async (t) => {
  const { load } = await renderer(t);
  const { classifyConfirmError } = await load("/src/features/bots/task-card-dock.ts");
  assert.deepEqual(classifyConfirmError({ code: ErrorCodes.CONFLICT }), { kind: "conflict" });
  assert.equal(classifyConfirmError(new Error("boom")).kind, "failed");
  assert.equal(
    classifyConfirmError(Object.assign(new Error("stale"), { code: "NOT_FOUND" })).kind,
    "failed",
  );
  assert.equal(classifyConfirmError(undefined).kind, "failed");
});

test("a proposed card shows goal, criteria, boundaries, assignee and source", async (t) => {
  const { load, render } = await renderer(t);
  const { TaskCardDock } = await load("/src/features/bots/TaskCardDock.tsx");
  const html = render(
    createElement(TaskCardDock, {
      sessionId: "steward-1",
      drafts: [draft()],
      onConfirm: async () => undefined,
      onDrop: async () => undefined,
      onReload: async () => ({ drafts: [draft()] }),
    }),
  );

  assert.match(html, /Ship the employee surface/);
  assert.match(html, /Sidebar group lists employees/);
  assert.match(html, /Dock appears above the composer/);
  assert.match(html, /Do not touch main/);
  assert.match(html, /Desktop 前端/);
  assert.match(html, /data-card-hash="hash-abc"/);
  // The utterance is folded away until asked for; the card is the summary.
  assert.doesNotMatch(html, /让员工模式先能看见/);
  assert.match(html, /Show what you said/);
});

test("the card offers Start and Discard, and neither is a confirmation dialog", async (t) => {
  const { load, render } = await renderer(t);
  const { TaskCardDock } = await load("/src/features/bots/TaskCardDock.tsx");
  const html = render(
    createElement(TaskCardDock, {
      sessionId: "steward-1",
      drafts: [draft()],
      onConfirm: async () => undefined,
      onDrop: async () => undefined,
      onReload: async () => ({ drafts: [draft()] }),
    }),
  );
  assert.match(html, />Start</);
  assert.match(html, />Discard</);
  // "Start" is the act itself: the dock never renders a second confirm step.
  assert.doesNotMatch(html, /alertdialog/);
  assert.doesNotMatch(html, /Are you sure/i);
});

test("a confirmed card collapses to one dispatched line", async (t) => {
  const { load, render } = await renderer(t);
  const { TaskCardDock } = await load("/src/features/bots/TaskCardDock.tsx");
  const html = render(
    createElement(TaskCardDock, {
      sessionId: "steward-1",
      drafts: [
        draft({
          status: "confirmed",
          confirmedAt: "2026-11-11T03:04:05.000Z",
          targetTitle: "Desktop 前端",
        }),
      ],
      onConfirm: async () => undefined,
      onDrop: async () => undefined,
      onReload: async () => ({ drafts: [] }),
    }),
  );
  assert.match(html, /Dispatched to Desktop 前端/);
  // Collapsed: no goal, no criteria, no buttons.
  assert.doesNotMatch(html, /Ship the employee surface/);
  assert.doesNotMatch(html, />Start</);
});

test("a dropped card is not shown at all", async (t) => {
  const { load, render } = await renderer(t);
  const { TaskCardDock } = await load("/src/features/bots/TaskCardDock.tsx");
  const html = render(
    createElement(TaskCardDock, {
      sessionId: "steward-1",
      drafts: [draft({ status: "dropped" })],
      onConfirm: async () => undefined,
      onDrop: async () => undefined,
      onReload: async () => ({ drafts: [] }),
    }),
  );
  assert.equal(html, "");
});

test("several pending cards each render their own hash and buttons", async (t) => {
  const { load, render } = await renderer(t);
  const { TaskCardDock } = await load("/src/features/bots/TaskCardDock.tsx");
  const html = render(
    createElement(TaskCardDock, {
      sessionId: "steward-1",
      drafts: [
        draft({ id: "one", cardHash: "hash-one" }),
        draft({ id: "two", cardHash: "hash-two", card: { goal: "Second task" } }),
      ],
      onConfirm: async () => undefined,
      onDrop: async () => undefined,
      onReload: async () => ({ drafts: [] }),
    }),
  );
  assert.match(html, /data-card-hash="hash-one"/);
  assert.match(html, /data-card-hash="hash-two"/);
  assert.match(html, /Second task/);
});
