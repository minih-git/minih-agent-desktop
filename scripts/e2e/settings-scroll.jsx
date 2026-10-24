// Mounted production SettingsPage; only the preload boundary uses fixture data.
// A one-button host mirrors the shell: settings is a full-window route over a
// mounted chat surface, and closing it must give the keyboard back to that
// button on the next frame.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { initLanguageSync } from "../../apps/desktop/src/lib/app-language";

const destinations = ["A", "B"].map((id) => ({
  ref: `fixture:${id}`, pluginId: "fixture", label: `Themes ${id}`, keywords: [],
  description: "Fixture theme collection", themes: Array.from({ length: 12 }, (_, index) => ({
    themeId: `plugin:fixture:${id}${index}`, label: `Theme ${index}`, description: "Preview",
    previewUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", blur: 6,
  })),
}));
let settings = {
  defaultMode: "agent",
  theme: "light",
  language: "en",
  enterToSend: true,
  developerMode: false,
  networkProxy: { mode: "custom", url: "socks5://10.0.0.8:1080" },
};
let instructionFile = { path: "/fixture/instructions.md", content: "saved instructions" };
let updateState = {
  mode: "in-app",
  preference: "automatic",
  defaultPreference: "automatic",
  automaticSupported: true,
  manualReminder: false,
  status: "available",
  currentVersion: "0.15.8",
  availableVersion: "0.15.9",
  releasesUrl: "https://github.com/minih-git/minih-agent-desktop/releases/latest",
};
const updateStateListeners = new Set();
window.minihAgent = {
  platform: "darwin",
  on(channel, listener) {
    if (channel === IPC.event.updatesState) updateStateListeners.add(listener);
    return () => updateStateListeners.delete(listener);
  },
  async invoke(channel, input) {
    let data;
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations: data = destinations; break;
      case IPC.invoke.settingsGet: data = settings; break;
      case IPC.invoke.settingsSet:
        settings = input;
        data = settings;
        if (settings.updatePreference === "automatic" || settings.updatePreference === "manual") {
          updateState = {
            ...updateState,
            preference: settings.updatePreference,
            mode: settings.updatePreference === "automatic" ? "in-app" : "manual",
          };
          for (const listener of updateStateListeners) listener(updateState);
        }
        break;
      case IPC.invoke.providersList: data = { providers: [] }; break;
      case IPC.invoke.sessionList: data = { sessions: [] }; break;
      case IPC.invoke.appGetOnboarding: data = {}; break;
      case IPC.invoke.updatesGetState: data = updateState; break;
      case IPC.invoke.agentInstructionsGet:
        data = { global: instructionFile, project: null };
        break;
      case IPC.invoke.agentInstructionsSave:
        instructionFile = { ...instructionFile, content: input.content };
        data = { file: instructionFile };
        break;
      case IPC.invoke.configSyncGetState:
        data = {
          configured: false,
          enabled: false,
          paused: false,
          locked: false,
          status: "notConfigured",
          remoteMode: "strict",
          categories: {},
          includeSecrets: false,
          includeMemory: false,
          automaticSync: false,
          pendingApprovals: [],
          mappings: [],
        };
        break;
      case IPC.invoke.commandShellList: data = { choices: [], effective: null }; break;
      default: throw new Error(`Unexpected fixture IPC: ${channel}`);
    }
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: {
    en: { translation: flattenCatalog(catalogs.en) },
    "pt-BR": { translation: flattenCatalog(catalogs["pt-BR"]) },
    "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) },
  },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ settings, settingsTab: "general", page: "chat" });
initLanguageSync();

/**
 * The host stands in for the shell: the chat surface itself stays mounted but
 * hidden and inert while the route is Settings, and the page is mounted only
 * while the route says so. The entry control sits outside the shell so it does
 * not take page space.
 */
function Host() {
  const page = useAppStore((state) => state.page);
  const open = page === "settings";
  return (
    <>
      <div className="app-shell">
        <div
          className="fixture-chat"
          data-testid="behind"
          hidden={open || undefined}
          inert={open ? true : undefined}
        >
          <button id="behind-action" type="button" onClick={() => { window.behindClicks = (window.behindClicks ?? 0) + 1; }}>
            Behind action
          </button>
        </div>
        {open ? <SettingsPage /> : null}
      </div>
      <button
        id="open-settings"
        type="button"
        onClick={() => useAppStore.getState().setPage("settings")}
      >
        Open settings
      </button>
    </>
  );
}

const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<Host />));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function until(condition, message) {
  const end = performance.now() + 4000;
  while (!condition()) {
    if (performance.now() > end) throw new Error(message);
    await frame();
  }
}
function assert(value, message) { if (!value) throw new Error(message); }
const pageRoot = () => document.querySelector(".settings-page");
const content = () => document.querySelector(".settings-page-content");
const legacy = () => document.querySelector(".settings-overlay, .settings-sheet");
const pane = () => document.querySelector(".settings-content");
const categoryButton = (label) => [...document.querySelectorAll(".settings-category")]
  .find((node) => node.textContent.trim() === label);
const subnavButton = (label) => [...document.querySelectorAll(".settings-subnav-item")]
  .find((node) => node.querySelector(".settings-nav-label")?.textContent?.trim() === label);
const title = () => document.querySelector(".settings-section-title")?.textContent?.trim() ?? "";
async function openSettings() {
  await settle();
  if (!pageRoot()) {
    // A real click focuses the entry too; the page must give focus back to it.
    flushSync(() => {
      const entry = document.getElementById("open-settings");
      entry.focus({ preventScroll: true });
      entry.click();
    });
    await settle();
  }
  assert(pageRoot(), "the settings page must open");
}
async function chooseCategory(label) {
  const button = categoryButton(label);
  if (button) {
    if (!button.classList.contains("active")) {
      flushSync(() => button.click());
      await settle();
    }
    return;
  }
  // Narrow windows offer the same choice as a selector.
  const select = document.querySelector(".settings-category-select");
  assert(select, `Missing category: ${label}`);
  const trigger = select.querySelector("button");
  assert(trigger, "the category selector must expose its trigger");
  flushSync(() => trigger.click());
  await settle();
  const option = [...document.querySelectorAll('[role="option"]')]
    .find((node) => node.textContent.trim() === label);
  assert(option, `Missing category option: ${label}`);
  flushSync(() => option.click());
  await settle();
}

async function rows(labels) {
  if (!pageRoot()) await openSettings();
  await chooseCategory(labels[0]);
  if (labels.length > 1) {
    const label = labels[labels.length - 1];
    const tab = subnavButton(label);
    assert(tab, `Missing destination: ${label}`);
    if (!tab.classList.contains("active")) {
      flushSync(() => tab.click());
      await settle();
    }
  }
}
async function setSettingsSearch(value) {
  const input = document.querySelector(".settings-search");
  assert(input instanceof HTMLInputElement, "Settings search input must be rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert(setter, "Settings search input must expose its value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
function pressKey(target, key) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  flushSync(() => { target.dispatchEvent(event); });
}

/** Page geometry: a full-window route, measured in a real window. */
function centerOf(node) {
  const box = node.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** Nothing may paint over the head: a control in the DOM proves nothing. */
function headerChecks() {
  const head = document.querySelector(".settings-panel-head");
  const titleNode = document.querySelector(".settings-panel-title");
  const close = document.querySelector(".settings-close");
  const search = document.querySelector(".settings-search");
  const visible = (node) => {
    const point = centerOf(node);
    const top = document.elementFromPoint(point.x, point.y);
    return Boolean(top && node.contains(top));
  };
  const bands = [...document.querySelectorAll(".settings-titlebar")].map((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, zIndex: style.zIndex };
  });
  const region = getComputedStyle(head).getPropertyValue("-webkit-app-region").trim();
  const headBox = head.getBoundingClientRect();
  const titleBox = titleNode.getBoundingClientRect();
  const contentBox = content().getBoundingClientRect();
  const titlebarSpace = Math.max(headBox.top, titleBox.top) - contentBox.top;
  assert(visible(titleNode), "the title must be the top-most pixel at its center");
  assert(visible(close), "the close button must be the top-most pixel at its center");
  assert(visible(search), "the search field must be the top-most pixel at its center");
  assert(bands.length === 0, `no decorative band may cover the head: ${JSON.stringify(bands)}`);
  assert(titlebarSpace >= 46,
    `the head must reserve the 46px native titlebar band: ${JSON.stringify({ titlebarSpace })}`);
  assert(region === "drag", `the head must be the window drag region: ${region}`);
  return {
    title: visible(titleNode), close: visible(close), search: visible(search),
    dragRegion: region, titlebarSpace, headHeight: Math.round(headBox.height),
  };
}

function geometryChecks() {
  const page = pageRoot();
  assert(page && content(), "the settings page and its content must render");
  assert(legacy() === null, "no settings sheet or overlay may remain");
  const box = page.getBoundingClientRect();
  const contentBox = content().getBoundingClientRect();
  const style = getComputedStyle(page);
  const contentStyle = getComputedStyle(content());
  const clientWidth = document.documentElement.clientWidth;
  const clientHeight = document.documentElement.clientHeight;
  const zero = (value) => Number.parseFloat(value) === 0;
  const summary = {
    box: { left: box.left, top: box.top, width: box.width, height: box.height },
    content: { left: contentBox.left, top: contentBox.top, width: contentBox.width, height: contentBox.height },
    clientWidth, clientHeight, innerWidth, innerHeight,
    radius: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
    margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
    shadow: style.boxShadow, transform: style.transform,
    animationName: style.animationName, animationDuration: style.animationDuration,
    role: page.getAttribute("role"), ariaModal: page.getAttribute("aria-modal"),
    contentRole: content().getAttribute("role"),
    contentTransform: contentStyle.transform, contentAnimation: contentStyle.animationName,
  };
  assert(Math.abs(box.left) <= 1 && Math.abs(box.top) <= 1,
    `the page must start at the client origin: ${JSON.stringify(summary.box)}`);
  assert(Math.abs(box.width - clientWidth) <= 1 && Math.abs(box.height - clientHeight) <= 1,
    `the page must fill the client area: ${JSON.stringify(summary)}`);
  assert(Math.abs(contentBox.left) <= 1 && Math.abs(contentBox.top) <= 1 &&
    Math.abs(contentBox.width - clientWidth) <= 1 && Math.abs(contentBox.height - clientHeight) <= 1,
    `the page content must fill the client area: ${JSON.stringify(summary.content)}`);
  assert(summary.radius.every(zero), `the page must have no corner radius: ${JSON.stringify(summary)}`);
  assert(summary.margin.every(zero), `the page must have no margin: ${JSON.stringify(summary)}`);
  assert(summary.shadow === "none", `the page must have no shadow: ${JSON.stringify(summary)}`);
  assert(summary.transform === "none", `the page must not be transformed: ${JSON.stringify(summary)}`);
  assert(summary.animationName === "none", `the page must not animate: ${JSON.stringify(summary)}`);
  assert((style.animationDuration || "0s").split(",").every(zero),
    `the page must have no animation duration: ${JSON.stringify(summary)}`);
  assert(summary.contentRole === "main", `the content must be the main landmark: ${JSON.stringify(summary)}`);
  assert(summary.role !== "dialog" && summary.ariaModal === null,
    `the page must not be a modal dialog: ${JSON.stringify(summary)}`);
  assert(summary.contentTransform === "none" && summary.contentAnimation === "none",
    `the content must not animate or transform: ${JSON.stringify(summary)}`);
  const paneBox = pane().getBoundingClientRect();
  assert(paneBox.bottom <= clientHeight + 1 && paneBox.top >= box.top,
    "the scroll pane must stay inside the page");
  return summary;
}
function categoryBarChecks() {
  const bar = document.querySelector(".settings-categories");
  const buttons = [...document.querySelectorAll(".settings-category")];
  const select = document.querySelector(".settings-category-select");
  if (!bar) {
    assert(select, "the categories must be reachable through a selector");
    return { mode: "selector", label: select.textContent.trim() };
  }
  assert(buttons.length === 7, `the category bar is seven entries, got ${buttons.length}`);
  const labels = buttons.map((node) => node.textContent.trim());
  assert(JSON.stringify(labels) === JSON.stringify(["General", "AI", "Models", "Capabilities", "Accounts", "Projects", "System"]),
    `unexpected category labels: ${labels.join(" | ")}`);
  const tops = new Set(buttons.map((node) => Math.round(node.getBoundingClientRect().top)));
  assert(tops.size === 1, "categories must stay on one line instead of wrapping");
  assert(bar.scrollWidth <= bar.clientWidth + 1,
    `seven categories that stay on the bar must fit it: ${bar.scrollWidth} > ${bar.clientWidth}`);
  for (const button of buttons) {
    assert(button.getAttribute("role") === "tab", "each category must be a tab");
    assert(button.hasAttribute("aria-selected"), "each category must report its selection");
  }
  return { mode: "bar", labels, height: bar.clientHeight, scrollWidth: bar.scrollWidth, width: bar.clientWidth };
}
async function navigationChecks() {
  await openSettings();
  assert(document.activeElement === document.querySelector(".settings-search"),
    "opening settings must move focus to its search control");

  // A category with one page has no second level.
  await rows(["Models"]);
  assert(!document.querySelector(".settings-subnav"),
    "a single-page category must not render a second level");
  assert(title().includes("Models"), `Models must own its page: ${title()}`);

  // A category with several pages shows them, and the last one stays selected.
  await rows(["System", "Network"]);
  const systemTabs = [...document.querySelectorAll(".settings-subnav-item")]
    .map((node) => node.querySelector(".settings-nav-label")?.textContent?.trim());
  assert(JSON.stringify(systemTabs) === JSON.stringify(["Network", "Storage", "About & updates"]),
    `unexpected system pages: ${systemTabs.join(" | ")}`);
  assert(title() === "Network", `the page title must name the destination: ${title()}`);
  assert(useAppStore.getState().settingsTab === "network", "the store must follow the click");

  // Re-selecting the category keeps the destination it already shows.
  const selectedBefore = useAppStore.getState().settingsTab;
  flushSync(() => categoryButton("System").click());
  await settle();
  assert(useAppStore.getState().settingsTab === selectedBefore,
    "re-selecting a category must keep its current destination");

  // Every capability keeps its own management page.
  await rows(["Capabilities", "Skills"]);
  assert(title() === "Skills", `skills must keep its page: ${title()}`);
  await rows(["Capabilities", "MCP"]);
  assert(title() === "MCP servers", `MCP must keep its page: ${title()}`);
  await rows(["Accounts", "Devices"]);
  assert(title() === "My devices", `devices must be its own page: ${title()}`);
  const experimental = document.querySelector(".settings-nav-experimental");
  assert(experimental, "Experimental destinations must keep their badge in the second level");
  return { selectedBefore, experimental: experimental.textContent.trim() };
}

async function foldedAnchorChecks() {
  // A hit inside a folded container has to expand it and land on the field:
  // the title lookup alone cannot reach what the disclosure has collapsed.
  await rows(["Accounts", "Advanced"]);
  const disclosure = document.querySelector('[data-testid="remote-gateway-advanced"]');
  assert(disclosure, "the self-hosted gateway disclosure must render");
  if (disclosure.open) {
    flushSync(() => disclosure.querySelector("summary").click());
    await settle();
  }
  assert(disclosure.open === false, "the disclosure must start closed for this check");

  // The same two store calls the global search dialog makes for a settings hit.
  flushSync(() => {
    useAppStore.getState().setSettingsAnchor("settings.remoteGateway.registrationCode");
    useAppStore.getState().setSettingsTab("advanced");
  });
  await settle();
  assert(disclosure.open === true, "a hit inside the disclosure must open it");
  const flashed = document.querySelector(".settings-anchor-flash");
  assert(flashed, "the hit must flash the row it names");
  const focusedView = flashed.getBoundingClientRect();
  const paneView = pane().getBoundingClientRect();
  assert(focusedView.top >= paneView.top - 1 && focusedView.bottom <= paneView.bottom + 1,
    "the revealed field must be scrolled into view");
  assert(useAppStore.getState().settingsAnchor === null, "the anchor must be consumed");
  return { disclosureOpened: true, flashed: flashed.className };
}

async function searchChecks() {
  await openSettings();
  await setSettingsSearch("proxy");
  const results = [...document.querySelectorAll(".settings-result")];
  assert(results.length > 0, "search must list concrete settings rows");
  const paths = results.map((node) => node.querySelector(".settings-result-path")?.textContent?.trim() ?? "");
  assert(paths.some((path) => path.startsWith("System › Network ›")),
    `a hit must show its category, page, and row path: ${paths.join(" | ")}`);

  const target = results.find((node) => (node.querySelector(".settings-result-path")?.textContent ?? "").includes("Network"));
  assert(target, "the proxy rows must land on the network page");
  flushSync(() => target.click());
  await settle();
  assert(useAppStore.getState().settingsTab === "network",
    "choosing a result must switch to its destination");
  assert(document.querySelector(".settings-search").value === "",
    "choosing a result must clear the query");
  assert(categoryButton("System").classList.contains("active"),
    "choosing a result must select its category");
  assert(subnavButton("Network").classList.contains("active"),
    "choosing a result must select its destination");
  const flash = document.querySelector(".settings-anchor-flash");
  assert(flash, "choosing a row result must flash the row it names");
  const flashBox = flash.getBoundingClientRect();
  const paneBox = pane().getBoundingClientRect();
  assert(flashBox.top >= paneBox.top && flashBox.bottom <= paneBox.bottom,
    "the flashed row must be scrolled into view");
  await setSettingsSearch("");
  return { results: results.length, paths: paths.slice(0, 3) };
}

async function nestedEscapeChecks() {
  // Real editors, not the settings menu: each renders through the overlay host
  // and bubbles its Escape back through the React tree.
  const cases = [
    { destination: "Skills", add: "extensions.skills.add", name: "skill" },
    { destination: "MCP", add: "settings.addMcp", name: "mcp" },
    { destination: "Subagents", add: "extensions.subagents.add", name: "subagent" },
  ];
  const results = [];
  for (const item of cases) {
    await rows(["Capabilities", item.destination]);
    const add = [...document.querySelectorAll(".settings-content button")]
      .find((node) => node.textContent.trim() === i18n.t(item.add));
    assert(add, `missing the add action for ${item.name}`);
    flushSync(() => add.click());
    await settle();
    const editor = document.querySelector(".ext-sheet");
    assert(editor, `the ${item.name} editor must open`);
    const field = editor.querySelector("input, textarea") ?? editor;
    pressKey(field, "Escape");
    await settle();
    const afterFirst = {
      editor: Boolean(document.querySelector(".ext-sheet")),
      page: Boolean(pageRoot()),
      route: useAppStore.getState().page,
    };
    assert(afterFirst.editor === false, `Escape must close the ${item.name} editor: ${JSON.stringify(afterFirst)}`);
    assert(afterFirst.page === true, `Escape must not close the page for ${item.name}: ${JSON.stringify(afterFirst)}`);
    assert(afterFirst.route === "settings", `the route must stay on settings for ${item.name}`);
    // The next Escape, with nothing on top, closes the page.
    await rows(["Capabilities", item.destination]);
    pressKey(document.querySelector(".settings-search"), "Escape");
    await settle();
    await until(() => !pageRoot(), "the second Escape must close the page");
    results.push({ name: item.name, afterFirst });
  }
  return results;
}
async function draftAndCloseChecks() {
  await rows(["AI", "Instructions & memory"]);
  const editor = () => document.querySelector(".settings-instruction-editor");
  assert(editor(), "the global instruction editor must render");
  const setDraft = (value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(editor(), value);
    flushSync(() => editor().dispatchEvent(new Event("input", { bubbles: true })));
  };

  // A search must not unmount the page that holds the draft.
  setDraft("UNSAVED_E2E_DRAFT");
  await settle();
  await setSettingsSearch("proxy");
  assert(editor()?.value === "UNSAVED_E2E_DRAFT",
    "the draft must stay in the mounted editor while searching");
  await setSettingsSearch("");
  assert(editor()?.value === "UNSAVED_E2E_DRAFT", "clearing the search must keep the draft");

  // The close button asks instead of discarding.
  flushSync(() => document.querySelector(".settings-close").click());
  await settle();
  const confirm = document.querySelector(".settings-draft-confirm");
  assert(confirm, "a dirty page must ask before leaving");
  assert(pageRoot(), "the page must stay open until the user decides");
  const keep = [...confirm.querySelectorAll("button")]
    .find((node) => node.textContent.trim() === i18n.t("settings.draftKeepEditing"));
  assert(keep, "the confirmation must offer to keep editing");
  flushSync(() => keep.click());
  await settle();
  assert(editor()?.value === "UNSAVED_E2E_DRAFT", "keeping must leave the draft in place");

  // Discarding is explicit, and it closes without waiting for an exit.
  flushSync(() => document.querySelector(".settings-close").click());
  await settle();
  const discard = [...document.querySelectorAll(".settings-draft-confirm button")]
    .find((node) => node.textContent.trim() === i18n.t("settings.draftDiscard"));
  assert(discard, "the confirmation must offer an explicit discard");
  flushSync(() => discard.click());
  assert(!pageRoot(), "discarding must close the page synchronously");
  await settle();

  // An untouched page closes from its close button.
  await openSettings();
  await rows(["AI", "Instructions & memory"]);
  assert(editor()?.value === "saved instructions", "the discarded draft must not persist");
  flushSync(() => document.querySelector(".settings-close").click());
  assert(!pageRoot(), "the close button must close a page with no draft synchronously");
  await settle();
  assert(!pageRoot(), "the closed page must stay gone");
  return { confirmShown: true, explicitDiscard: true, closeClosesUntouched: true };
}

async function immediateCloseChecks() {
  await openSettings();
  const chat = document.querySelector('[data-testid="behind"]');
  const openState = {
    pagePresent: Boolean(pageRoot()),
    chatHidden: chat.hidden,
    chatInert: chat.hasAttribute("inert"),
    route: useAppStore.getState().page,
  };

  flushSync(() => document.querySelector(".settings-close").click());
  const immediate = {
    pagePresent: Boolean(pageRoot()),
    legacyPresent: Boolean(legacy()),
    route: useAppStore.getState().page,
    chatHidden: chat.hidden,
    chatInert: chat.hasAttribute("inert"),
  };

  await settle();
  const box = chat.getBoundingClientRect();
  const hit = box.width > 1
    ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    : null;
  const afterFrame = {
    pagePresent: Boolean(pageRoot()),
    chatHidden: chat.hidden,
    chatInert: chat.hasAttribute("inert"),
    chatDisplay: getComputedStyle(chat).display,
    chatBox: { width: box.width, height: box.height },
    hitInsideChat: Boolean(hit && chat.contains(hit)),
    focus: document.activeElement === document.getElementById("open-settings")
      ? "open-settings" : (document.activeElement?.id || document.activeElement?.tagName || null),
  };

  // No delayed callback may resurrect the page or re-block the app.
  await new Promise((resolve) => setTimeout(resolve, 450));
  await settle();
  const afterDelay = {
    pagePresent: Boolean(pageRoot()),
    legacyPresent: Boolean(legacy()),
    chatHidden: chat.hidden,
    chatInert: chat.hasAttribute("inert"),
  };

  // Opening again, and closing again, both stay synchronous.
  await openSettings();
  const reopened = {
    pagePresent: Boolean(pageRoot()),
    searchFocused: document.activeElement === document.querySelector(".settings-search"),
    chatHidden: chat.hidden,
    chatInert: chat.hasAttribute("inert"),
  };
  flushSync(() => document.querySelector(".settings-close").click());
  const closedAgain = { pagePresent: Boolean(pageRoot()), route: useAppStore.getState().page };
  await settle();

  const report = { openState, immediate, afterFrame, afterDelay, reopened, closedAgain };
  assert(openState.pagePresent && openState.chatHidden && openState.chatInert && openState.route === "settings",
    `the open page must own the window while the chat stays blocked: ${JSON.stringify(report)}`);
  assert(immediate.pagePresent === false && immediate.legacyPresent === false,
    `closing must remove the page synchronously: ${JSON.stringify(report)}`);
  assert(immediate.route === "chat", `closing must change the route at once: ${JSON.stringify(report)}`);
  assert(immediate.chatHidden === false && immediate.chatInert === false,
    `the background must be released in the same commit: ${JSON.stringify(report)}`);
  assert(afterFrame.chatHidden === false && afterFrame.chatInert === false &&
    afterFrame.chatDisplay !== "none" && afterFrame.chatBox.width > 1 && afterFrame.chatBox.height > 1 &&
    afterFrame.hitInsideChat,
    `the chat must be visible and take its own clicks after closing: ${JSON.stringify(report)}`);
  assert(afterFrame.focus === "open-settings",
    `focus must return to the entry on the next frame: ${JSON.stringify(report)}`);
  assert(afterDelay.pagePresent === false && afterDelay.legacyPresent === false &&
    afterDelay.chatHidden === false && afterDelay.chatInert === false,
    `no delayed exit may re-block the app: ${JSON.stringify(report)}`);
  assert(reopened.pagePresent && reopened.searchFocused && reopened.chatHidden && reopened.chatInert,
    `opening again must work like the first time: ${JSON.stringify(report)}`);
  assert(closedAgain.pagePresent === false && closedAgain.route === "chat",
    `a second close must be synchronous as well: ${JSON.stringify(report)}`);
  return report;
}
async function scrollChecks() {
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    await rows(["AI", "Chat experience"]);
    pane().scrollTop = 260;
    await settle();
    assert(pane().scrollTop > 0, `the destination must be scrollable (${theme})`);
    const position = pane().scrollTop;
    flushSync(() => subnavButton("Chat experience").click());
    await settle();
    assert(pane().scrollTop === position, `re-selecting the page must retain scroll (${theme})`);
    flushSync(() => useAppStore.setState({ settings: { ...settings, enterToSend: false } }));
    await settle();
    assert(pane().scrollTop === position, `settings updates must retain scroll (${theme})`);

    flushSync(() => subnavButton("Instructions & memory").click());
    await settle();
    assert(pane().scrollTop === 0, `a new destination must start at the top (${theme})`);
    pane().scrollTop = 200;
    await settle();
    flushSync(() => categoryButton("General").click());
    await settle();
    assert(pane().scrollTop === 0, `a category change must start at the top (${theme})`);

    // Plugin theme destinations hang off appearance and start at the top.
    const extension = subnavButton("Themes A");
    assert(extension, "the plugin theme destination must sit in the general category");
    flushSync(() => extension.click());
    await settle();
    assert(pane().scrollTop === 0, `a plugin destination must start at the top (${theme})`);
    pane().scrollTop = 180;
    await settle();
    assert(pane().scrollTop > 0, "the plugin destination must be scrollable");
    flushSync(() => subnavButton("Themes A").click());
    await settle();
    assert(pane().scrollTop > 0, "re-selecting the plugin destination must retain scroll");

    // A core destination dismisses the plugin page.
    flushSync(() => useAppStore.getState().setSettingsTab("shortcuts"));
    await settle();
    assert(!document.querySelector(".plugin-scenic-theme-card"), "a core tab must leave the plugin page");
    assert(title() === "Shortcuts", `shortcuts must replace the plugin page: ${title()}`);
    assert(pane().scrollTop === 0, "a core tab must start at the top");
  }
  document.documentElement.dataset.theme = "light";
  return { themes: ["light", "dark"] };
}

async function brazilianPortugueseChecks() {
  await rows(["General", "Appearance & language"]);
  const trigger = document.querySelector(".settings-language-trigger");
  assert(trigger instanceof HTMLButtonElement, "Language picker trigger must render");
  flushSync(() => trigger.click());
  await settle();

  const search = document.querySelector(".settings-language-search input");
  assert(search instanceof HTMLInputElement, "Language picker search must render");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter.call(search, "Português (Brasil)");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();

  const option = [...document.querySelectorAll(".settings-language-option")]
    .find((candidate) => candidate.textContent?.includes("Português (Brasil)"));
  assert(option instanceof HTMLButtonElement, "Brazilian Portuguese must be searchable");
  const languageChanged = new Promise((resolve) => i18n.once("languageChanged", resolve));
  flushSync(() => option.click());
  await languageChanged;
  await settle();

  assert(settings.language === "pt-BR", "Choosing Portuguese must persist pt-BR");
  assert(document.documentElement.lang === "pt-BR", "Document language must update to pt-BR");
  // The category bar and the appearance page follow the locale.
  const accountLabel = i18n.t("settings.category.accounts");
  assert(categoryButton(accountLabel), `the category bar must be translated: ${accountLabel}`);
  const languageTitle = [...document.querySelectorAll(".settings-row-title")]
    .find((node) => node.textContent?.trim() === i18n.t("settings.language"));
  assert(languageTitle, "the language row must be translated");
  const selectedLabel = document.querySelector(".settings-language-trigger-label");
  assert(selectedLabel?.textContent?.trim() === "Português (Brasil)", "Picker must show the selected native name");

  // Back to English so the remaining checks read the same labels.
  settings = { ...settings, language: "en" };
  flushSync(() => useAppStore.setState({ settings }));
  await i18n.changeLanguage("en");
  document.documentElement.lang = "en";
  await settle();
  await rows(["General", "Appearance & language"]);
  return { locale: i18n.language, label: selectedLabel.textContent.trim() };
}

async function updatePreferenceChecks() {
  await rows(["System", "About & updates"]);
  const trigger = () => document.querySelector('button[aria-label="Update behavior"]');
  assert(trigger() instanceof HTMLButtonElement, "Update behavior selector must render");
  assert(trigger().textContent?.includes("Automatic"), "Installed package defaults to Automatic");

  async function choosePreference(label, value) {
    const selectTrigger = trigger();
    flushSync(() => selectTrigger.click());
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((candidate) => candidate.textContent?.trim() === label);
    assert(option instanceof HTMLButtonElement, `Missing update preference option: ${label}`);
    flushSync(() => option.click());
    await settle();
    assert(settings.updatePreference === value, `${label} preference must persist through settings IPC`);
    assert(updateState.preference === value, `${label} preference must update the shared update state`);
    assert(pageRoot(), `${label} must leave the settings page open`);
  }

  await choosePreference("Manual", "manual");
  assert(trigger().textContent?.includes("Manual"), "Manual must become the selected value");
  await rows(["AI", "Chat experience"]);
  await rows(["System", "About & updates"]);
  assert(trigger().textContent?.includes("Manual"), "Manual must survive leaving and reopening the page");
  await choosePreference("Automatic", "automatic");
  return { updatePreference: settings.updatePreference };
}

window.settingsScrollProbe = async () => {
  await settle();
  await openSettings();
  const checks = [];
  const geometry = geometryChecks();
  const header = headerChecks();
  const categories = categoryBarChecks();
  checks.push(await navigationChecks());
  checks.push(await searchChecks());
  checks.push(await foldedAnchorChecks());
  checks.push(await nestedEscapeChecks());
  checks.push(await draftAndCloseChecks());
  checks.push(await immediateCloseChecks());
  checks.push(await scrollChecks());
  checks.push(await brazilianPortugueseChecks());
  checks.push(await updatePreferenceChecks());
  const stillOpen = Boolean(pageRoot());
  return { ok: true, geometry, header, categories, stillOpen, checks };
};

/** Used by the screenshot pass: open the page and settle it. */
window.settingsOpenProbe = async () => {
  await openSettings();
  return { open: Boolean(pageRoot()) };
};
window.settingsCloseProbe = async () => {
  const close = document.querySelector(".settings-close");
  if (close) flushSync(() => close.click());
  await settle();
  assert(!pageRoot(), "the page must close after a screenshot");
  return { open: Boolean(pageRoot()) };
};

/** Layout under a narrow/roomy window, both locales, and a 150% type scale. */
window.settingsSegmentProbe = async (language, fontScale) => {
  settings = { ...settings, language };
  flushSync(() => useAppStore.setState({ settings, settingsTab: "ai" }));
  await i18n.changeLanguage(language);
  document.documentElement.style.setProperty("--font-scale", String(fontScale));
  await settle();
  await openSettings();
  await rows([i18n.t("settings.category.ai"), i18n.t("settings.nav.chatExperience")]);

  const group = [...document.querySelectorAll('[role="radiogroup"]')]
    .find((node) => node.getAttribute("aria-label") === i18n.t("settings.transcriptDensity"));
  assert(group, "Transcript density selector must render on the chat-experience page");
  const row = group.closest(".settings-row");
  const copy = row.querySelector(".settings-row-copy");
  const buttons = [...group.querySelectorAll('[role="radio"]')];
  assert(buttons.length === 3, "All transcript density choices must be visible");
  for (const button of buttons) {
    const text = document.createRange();
    text.selectNodeContents(button);
    const lines = new Set([...text.getClientRects()].map((rect) => Math.round(rect.top)));
    assert(lines.size === 1, `${language}/${innerWidth}/${fontScale}: ${button.textContent} must stay on one line`);
    assert(button.scrollWidth <= button.clientWidth + 1, "Option text must not be clipped");
  }
  const bounds = group.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  assert(bounds.left >= rowBounds.left && bounds.right <= rowBounds.right + 1,
    "Transcript density control must stay inside its row");
  assert(row.scrollWidth <= row.clientWidth + 1, "The row must not overflow horizontally");
  assert(copy.clientWidth > 0 && copy.scrollWidth <= copy.clientWidth + 1,
    "The setting title and help control must retain their space");
  if (innerWidth >= 1440) {
    assert(bounds.top < copy.getBoundingClientRect().bottom, "Wide rows must retain the inline title/control layout");
  }

  // The page keeps its shape in this window: the categories are reachable —
  // as a bar that fits, or as the selector the narrow layout swaps in.
  const bar = document.querySelector(".settings-categories");
  const categories = bar
    ? {
        mode: "bar",
        tops: new Set([...bar.querySelectorAll(".settings-category")]
          .map((node) => Math.round(node.getBoundingClientRect().top))),
        fits: bar.scrollWidth <= bar.clientWidth + 1,
        wrapped: bar.scrollHeight > bar.clientHeight + 1,
      }
    : {
        mode: "selector",
        select: Boolean(document.querySelector(".settings-category-select")),
      };
  if (categories.mode === "bar") {
    assert(categories.tops.size === 1, `${language}/${innerWidth}: categories must stay on one line`);
    assert(!categories.wrapped, `${language}/${innerWidth}: the category bar must not wrap`);
    assert(categories.fits, `${language}/${innerWidth}: a visible category bar must fit its labels`);
  } else {
    assert(categories.select, `${language}/${innerWidth}: the categories must be reachable`);
  }
  const pageBox = pageRoot().getBoundingClientRect();
  const clientWidth = document.documentElement.clientWidth;
  const clientHeight = document.documentElement.clientHeight;
  assert(Math.abs(pageBox.width - clientWidth) <= 1 && Math.abs(pageBox.height - clientHeight) <= 1,
    `${language}/${innerWidth}: the page must fill the window: ${JSON.stringify({ width: pageBox.width, height: pageBox.height, clientWidth, clientHeight })}`);
  assert(pane().scrollWidth <= pane().clientWidth + 1,
    `${language}/${innerWidth}: the content area must not overflow horizontally`);
  const pageRadius = Number.parseFloat(getComputedStyle(pageRoot()).borderTopLeftRadius);
  assert(pageRadius === 0, `${language}/${innerWidth}: the page must stay square (${pageRadius})`);

  const subnav = document.querySelector(".settings-subnav");
  assert(subnav, "the chat-experience page must keep its second-level navigation");
  const navigationGap = () => pane().getBoundingClientRect().top - subnav.getBoundingClientRect().bottom;
  const gapBeforeScroll = navigationGap();
  assert(Math.abs(gapBeforeScroll - 16) <= 1,
    `${language}/${innerWidth}: second-level navigation needs 16px of fixed spacing, got ${gapBeforeScroll}`);
  const previousScroll = pane().scrollTop;
  pane().scrollTop = previousScroll + 80;
  await settle();
  const gapAfterScroll = navigationGap();
  assert(Math.abs(gapAfterScroll - 16) <= 1,
    `${language}/${innerWidth}: scrolling must retain the navigation gap, got ${gapAfterScroll}`);
  pane().scrollTop = previousScroll;
  await settle();

  for (const [index, value] of ["compact", "standard", "detailed"].entries()) {
    flushSync(() => buttons[index].click());
    await settle();
    assert(settings.transcriptDensity === value, "The selected density must persist through settings IPC");
    assert(buttons[index].getAttribute("aria-checked") === "true", "The saved density must be visibly selected");
  }
  return { language, fontScale, width: innerWidth, height: innerHeight,
    pageWidth: Math.round(pageBox.width), pageHeight: Math.round(pageBox.height),
    categories: categories.mode,
    navigationGap: gapBeforeScroll, navigationGapAfterScroll: gapAfterScroll,
    controlWidth: Math.round(bounds.width),
    optionRows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size };
};

/**
 * Reduced motion: a page that never animates behaves the same with or without
 * the media query, and closing still removes it immediately.
 */
window.settingsReducedMotionProbe = async () => {
  await settle();
  await openSettings();
  const style = getComputedStyle(pageRoot());
  const durations = style.animationDuration.split(",").map((value) => Number.parseFloat(value) || 0);
  const measured = { duration: durations[0], animationName: style.animationName };
  assert(style.animationName === "none",
    `the page must not animate: ${JSON.stringify(measured)}`);
  assert(durations.every((value) => value <= 0.001),
    `the page must have no animation duration: ${JSON.stringify(measured)}`);
  flushSync(() => document.querySelector(".settings-close").click());
  assert(!pageRoot(), "closing must remove the page synchronously under reduced motion");
  await settle();
  return measured;
};