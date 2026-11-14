import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { createServer } from "vite";

/*
 * The employee surfaces as a person meets them (ADR bot-sessions-and-steward
 * §5): the sidebar group's status dots, and the settings page's list, seeding
 * and dismiss rules.
 *
 * The components are the production ones and i18n is the real catalog. Server
 * rendering runs no effects, so a surface reads its roster through the `bots`
 * data seam the components expose; the IPC edge stays mocked so the tests can
 * also prove what a mount does **not** call.
 */

const task = (patch) => ({
  id: patch.id,
  employeeSessionId: patch.employeeSessionId,
  sessionId: `session-${patch.id}`,
  title: patch.title ?? "Fix the timeout",
  origin: "direct",
  stage: patch.stage ?? "queued",
  projectPath: "/repo/router",
  createdAt: "2026-11-11T00:00:00.000Z",
  shortId: patch.id.slice(0, 6),
  ...patch,
});

const bot = (patch) => ({
  sessionId: patch.sessionId,
  title: patch.name,
  profile: {
    name: patch.name,
    permissionMode: "ask",
    mustAsk: ["deploy", "delete", "spend"],
    observe: true,
    ...patch.profile,
  },
  status: patch.status ?? { kind: "idle" },
  updatedAt: "2026-11-11T00:00:00.000Z",
  createdAt: "2026-11-11T00:00:00.000Z",
});

async function harness(t, { bots: seeded = [], tasks: seededTasks = [] } = {}) {
  const calls = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      addEventListener() {},
      removeEventListener() {},
      minihAgent: {
        invoke: async (channel, input) => {
          calls.push({ channel, input });
          // A surface with no data seam reads the roster and the tasks itself;
          // these lists are empty so a dot shows what the test passed in.
          if (channel === IPC.invoke.botList) return { ok: true, data: { bots: seeded } };
          if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks: seededTasks } };
          return { ok: true, data: undefined };
        },
        on: () => () => undefined,
      },
    },
  });

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

  t.after(async () => {
    await server.close();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  return {
    server,
    callsTo: (channel) => calls.filter((call) => call.channel === channel),
    render: (element) =>
      renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element)),
  };
}

test("the sidebar group paints every stage and names it for screen readers", async (t) => {
  const h = await harness(t);
  const { BotSidebarGroup } = await h.server.ssrLoadModule(
    "/src/features/bots/BotSidebarGroup.tsx",
  );
  const bots = [
    bot({ sessionId: "waiting", name: "Steward", status: { kind: "stage", stage: "person/accept" } }),
    bot({ sessionId: "busy", name: "Fixer", status: { kind: "stage", stage: "working" } }),
    bot({ sessionId: "queued", name: "Runner", status: { kind: "stage", stage: "queued" } }),
    bot({ sessionId: "blocked", name: "Reviewer", status: { kind: "stage", stage: "failed" } }),
    bot({ sessionId: "idle", name: "Idler", status: { kind: "idle" } }),
    bot({ sessionId: "offline", name: "Remote", status: { kind: "offline" } }),
  ];
  // The dot now follows the tasks an employee holds (ADR §7), so each employee
  // below carries the task that puts it in that stage.
  const tasks = [
    task({ id: "t-waiting", employeeSessionId: "waiting", stage: "person/accept" }),
    task({ id: "t-busy", employeeSessionId: "busy", stage: "working" }),
    task({ id: "t-queued", employeeSessionId: "queued", stage: "queued" }),
    task({ id: "t-blocked", employeeSessionId: "blocked", stage: "failed" }),
  ];
  const html = h.render(
    createElement(BotSidebarGroup, { bots, tasks, onOpenBot: () => undefined, onOpenTask: () => undefined }),
  );

  assert.match(html, /data-bot-status="attention"/);
  assert.match(html, /data-bot-status="busy"/);
  assert.match(html, /data-bot-status="queued"/);
  // A failed task is something the person has to act on (slice 4a), so that row
  // reads as attention too instead of as the employee's own quieter business:
  // two rows are loud — whoever waits for a click, and whoever got stuck.
  assert.equal((html.match(/data-bot-status="attention"/g) ?? []).length, 2);
  assert.match(html, /data-bot-status="idle"/);

  // Every dot is announced, never colour-only.
  assert.match(html, /aria-label="Waiting for you"/);
  assert.match(html, /aria-label="Idle"/);
  // An offline employee still has a row; it is not dropped from the roster.
  assert.match(html, /data-sidebar-bot-row="offline"/);
  // Whoever is waiting on the person comes first.
  assert.ok(
    html.indexOf('data-sidebar-bot-row="waiting"') < html.indexOf('data-sidebar-bot-row="busy"'),
  );
});

test("an employee row names the session it opens", async (t) => {
  const h = await harness(t);
  const { BotSidebarGroup } = await h.server.ssrLoadModule(
    "/src/features/bots/BotSidebarGroup.tsx",
  );
  const html = h.render(
    createElement(BotSidebarGroup, {
      bots: [bot({ sessionId: "s-1", name: "Steward" })],
      tasks: [],
      onOpenBot: () => undefined,
      onOpenTask: () => undefined,
    }),
  );
  assert.match(html, /data-sidebar-bot-row="s-1"/);
  assert.match(html, /aria-label="Open Steward"/);
  assert.match(html, /sidebar-bot-avatar/);
});

test("the sidebar group renders nothing while there are no employees", async (t) => {
  const h = await harness(t);
  const { BotSidebarGroup } = await h.server.ssrLoadModule(
    "/src/features/bots/BotSidebarGroup.tsx",
  );
  assert.equal(
    h.render(
      createElement(BotSidebarGroup, {
        bots: [],
        tasks: [],
        onOpenBot: () => undefined,
        onOpenTask: () => undefined,
      }),
    ),
    "",
  );
});

test("the settings page shows each employee's name, duty, home, level and definition", async (t) => {
  const h = await harness(t);
  const { BotsSettingsPage } = await h.server.ssrLoadModule(
    "/src/features/bots/BotsSettingsPage.tsx",
  );
  const html = h.render(
    createElement(BotsSettingsPage, {
      bots: [
        bot({
          sessionId: "s-1",
          name: "Steward",
          profile: {
            duty: "Dispatch work",
            observe: false,
            permissionMode: "accept-edits",
            definition: "steward",
          },
        }),
      ],
    }),
  );

  assert.match(html, /Steward/);
  assert.match(html, /Dispatch work/);
  // No cross-host routing yet, so home reads as this computer.
  assert.match(html, /This computer/);
  assert.match(html, /Accept edits/);
  // The bound definition is named on the row (the picker also offers it).
  assert.match(html, /steward/);
});

test("opening the settings page never seeds the default crew", async (t) => {
  const h = await harness(t);
  const { BotsSettingsPage } = await h.server.ssrLoadModule(
    "/src/features/bots/BotsSettingsPage.tsx",
  );
  const html = h.render(createElement(BotsSettingsPage, { bots: [] }));

  // Slice 6 replaced the fixed crew with hiring: the jobs are offered as
  // templates, and the one employee the host still creates for the person is
  // its own prominent button.
  assert.match(html, /data-template-id="review"/);
  assert.match(html, /data-template-id="research"/);
  assert.match(html, /Enable Super Agent/);
  assert.match(html, /btn-primary/);
  assert.doesNotMatch(html, /Create the default crew/);
  // …and it is only ever a click: mounting the page asks for nothing.
  assert.equal(h.callsTo(IPC.invoke.botSeedDefaults).length, 0);
});

test("an existing team is not offered the crew as its starting point", async (t) => {
  const h = await harness(t);
  const { BotsSettingsPage } = await h.server.ssrLoadModule(
    "/src/features/bots/BotsSettingsPage.tsx",
  );
  const html = h.render(
    createElement(BotsSettingsPage, {
      bots: [bot({ sessionId: "s-1", name: "Steward", profile: { definition: "steward" } })],
    }),
  );
  // With a dispatcher on the crew there is nothing left for the host to create.
  assert.doesNotMatch(html, /Enable Super Agent/);
  assert.equal(h.callsTo(IPC.invoke.botSeedDefaults).length, 0);
});

test("dismissing an employee is not the first click", async (t) => {
  const h = await harness(t);
  const { BotsSettingsPage } = await h.server.ssrLoadModule(
    "/src/features/bots/BotsSettingsPage.tsx",
  );
  const html = h.render(
    createElement(BotsSettingsPage, { bots: [bot({ sessionId: "s-1", name: "Steward" })] }),
  );

  // The row offers a dismiss control, and the confirmation — which states that
  // the conversation is kept — only appears after arming it.
  assert.match(html, /aria-label="Dismiss employee"/);
  assert.doesNotMatch(html, /becomes an ordinary session again/);
  assert.equal(h.callsTo(IPC.invoke.botDismiss).length, 0);
});

test("the new-employee form locks the three always-asked actions", async (t) => {
  const h = await harness(t);
  const { BotFormCard } = await h.server.ssrLoadModule("/src/features/bots/BotFormCard.tsx");
  const { EMPTY_BOT_DRAFT } = await h.server.ssrLoadModule("/src/features/bots/bot-draft.ts");
  const html = h.render(
    createElement(BotFormCard, {
      initial: EMPTY_BOT_DRAFT,
      definitions: [{ id: "steward", label: "steward · Steward" }],
      title: "New employee",
      busy: false,
      error: null,
      onCancel: () => undefined,
      onSubmit: () => undefined,
    }),
  );

  // Deploy, delete and spend are checked and disabled, each labelled "always
  // asks" — the executing side adds them regardless of what this control says.
  for (const label of ["Deploy", "Delete", "Spend"]) {
    const input = html.match(
      new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`),
    )?.[0];
    assert.ok(input, `${label} is rendered`);
    assert.match(input, /checked=""/, label);
    assert.match(input, /disabled=""/, label);
  }
  // The optional ones are neither.
  for (const label of ["Push", "Merge", "Change criteria"]) {
    const input = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0];
    assert.ok(input, `${label} is rendered`);
    assert.doesNotMatch(input, /checked=""/, label);
    assert.doesNotMatch(input, /disabled=""/, label);
  }
});
