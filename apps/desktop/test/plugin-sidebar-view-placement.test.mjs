import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/**
 * Views a plugin places in the left sidebar instead of the work panel
 * (ADR optional-terminal-plugin).
 *
 * The surface itself is a native WebContentsView, so what is asserted here is the
 * placement contract around it: which rows the host draws, how the page is
 * routed, what history restores, and that a `panel` view keeps behaving exactly
 * as it did before.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const view = (overrides) => ({
  pluginId: "pi.example",
  viewId: "changes",
  ref: "pi.example/changes",
  title: "Changes",
  pluginName: "Example",
  order: 0,
  placement: "panel",
  ...overrides,
});

const TERMINAL = view({
  pluginId: "pi.terminal",
  viewId: "terminal",
  ref: "pi.terminal/terminal",
  title: "终端",
  pluginName: "终端插件",
  icon: "terminal",
  placement: "sidebar",
});

async function placement(t) {
  const ssr = await slotSsr(t);
  return { ssr, ...(await ssr.load("/src/lib/plugin-view-placement.ts")) };
}

test("only sidebar-placed views reach the sidebar, in host order", async (t) => {
  const { sidebarPluginViews } = await placement(t);
  const views = [TERMINAL, view(), view({ ref: "other/x", placement: "sidebar" })];
  assert.deepEqual(
    sidebarPluginViews(views).map((entry) => entry.ref),
    ["pi.terminal/terminal", "other/x"],
  );
});

test("only panel-placed views reach the work panel launcher", async (t) => {
  const { panelPluginViews } = await placement(t);
  const views = [TERMINAL, view()];
  assert.deepEqual(
    panelPluginViews(views).map((entry) => entry.ref),
    ["pi.example/changes"],
  );
});

test("a route resolves to its sidebar view, and to nothing once that view is gone", async (t) => {
  const { sidebarPluginViewFor } = await placement(t);
  assert.equal(sidebarPluginViewFor([TERMINAL], "pi.terminal/terminal")?.title, "终端");
  assert.equal(sidebarPluginViewFor([TERMINAL], "pi.terminal/missing"), undefined);
  assert.equal(sidebarPluginViewFor([TERMINAL], null), undefined);
  // A work-panel view cannot be opened as a center-pane page, even by ref.
  assert.equal(sidebarPluginViewFor([view()], "pi.example/changes"), undefined);
});

test("opening a sidebar view owns the page, and a second selection leaves it", async (t) => {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  useAppStore.setState({ page: "chat", pluginViewRef: null, navStack: [{ page: "chat" }], navIndex: 0 });

  useAppStore.getState().openSidebarPluginView("pi.terminal/terminal");
  let state = useAppStore.getState();
  assert.equal(state.page, "pluginView");
  assert.equal(state.pluginViewRef, "pi.terminal/terminal");
  const entry = state.navStack.at(-1);
  assert.equal(entry.page, "pluginView");
  assert.equal(entry.pluginViewRef, "pi.terminal/terminal");
  assert.equal(entry.sessionId, undefined, "a plugin page belongs to no chat");

  useAppStore.getState().openSidebarPluginView("pi.terminal/terminal");
  assert.equal(useAppStore.getState().page, "chat");
});

test("history restores both the page and which view it was showing", async (t) => {
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  useAppStore.setState({ page: "chat", pluginViewRef: null, navStack: [{ page: "chat" }], navIndex: 0 });
  useAppStore.getState().openSidebarPluginView("pi.terminal/terminal");
  useAppStore.getState().openSidebarPluginView("pi.example/changes");

  useAppStore.getState().setPage("plugins");
  useAppStore.getState().navBack();
  assert.equal(useAppStore.getState().page, "pluginView");
  assert.equal(useAppStore.getState().pluginViewRef, "pi.example/changes");

  useAppStore.getState().closeSidebarPluginView();
  assert.equal(useAppStore.getState().page, "pluginView");
  assert.equal(useAppStore.getState().pluginViewRef, "pi.terminal/terminal");
});

test("the shell draws the rows, routes the page, and hides the work panel", async () => {
  const sidebar = await read("src/components/Sidebar.tsx");
  assert.match(sidebar, /<PluginSidebarDestinations \/>/);
  // The rows belong to the destinations group, above the conversation list.
  assert.ok(
    sidebar.indexOf("<PluginSidebarDestinations />") <
      sidebar.indexOf("sidebar-activity-panel"),
  );

  const rows = await read("src/features/plugins/PluginSidebarDestinations.tsx");
  assert.match(rows, /sidebarPluginViews\(pluginViews\)/);
  // Host-drawn: an icon token from the host set, never plugin markup.
  assert.match(rows, /pluginViewIcon\(view\.icon\)/);
  assert.doesNotMatch(rows, /dangerouslySetInnerHTML/);

  const shell = await read("src/features/app/AppShell.tsx");
  assert.match(shell, /page === "pluginView" \? \(/);
  assert.match(shell, /<PluginViewPage \/>/);

  const runtime = await read("src/features/app/useAppShellRuntime.tsx");
  assert.match(runtime, /page === "pluginView";/);

  const page = await read("src/features/plugins/PluginViewPage.tsx");
  assert.match(page, /sidebarPluginViewFor\(pluginViews, pluginViewRef\)/);
  assert.match(page, /<PluginViewTab/);
  // Losing the view leaves the page instead of stranding an empty pane.
  assert.match(page, /if \(absent\) close\(\);/);
});

test("the main process resolves placement, defaulting to the work panel", () => {
  const source = readMainModuleSync("ipc/plugin-ui-ipc.ts");
  assert.match(source, /placement: view\.placement === "sidebar" \? "sidebar" : "panel",/);
  // Scope still filters both placements: a plugin that is not active here is
  // skipped before its views are read.
  assert.match(source, /if \(!pluginActiveInProject\(pluginId, workspacePath\)\) continue;/);
});

test("the work panel launcher reads the shared derivation, not its own filter", async () => {
  const source = await read("src/components/workpanel/WorkPanel.tsx");
  assert.match(source, /\.\.\.panelPluginViews\(pluginViews\)\.map\(/);
  assert.doesNotMatch(source, /pluginViews\.filter\(\(view\) => view\.placement/);
});

test("a development review shows what the author says the plugin does", () => {
  const source = readMainModuleSync("ipc/plugin-ipc.ts");
  assert.match(source, /safetyNotes: declaredSafetyNotes\(declared\.manifest\)/);
  assert.match(source, /manifest\.i18n\?\.\["zh-CN"\]\?\.safetyNotes/);
  // Silence is not consent theatre: an absent note stays absent.
  assert.match(source, /return resolved\.trim\(\) \|\| undefined;/);
});
