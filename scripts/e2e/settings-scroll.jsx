// Mounted production SettingsPage; only the preload boundary uses fixture data.
// A one-button host mirrors the shell: settings opens over it, and closing must
// give the keyboard back to that button.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useSettingsSheetPresence } from "../../apps/desktop/src/features/app/settings-sheet-presence";
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
 * The host stands in for the shell: the settings sheet mounts over it and the
 * chat surface itself is the shell's concern, not the panel's.
 */
function Host() {
  const page = useAppStore((state) => state.page);
  const open = page === "settings";
  // The production mount lifecycle: the sheet outlives the page change by its
  // exit animation, and the app behind stays inert until it is gone.
  const sheet = useSettingsSheetPresence(open);
  return (
    <div className="fixture-host">
      <button
        id="open-settings"
        type="button"
        onClick={() => useAppStore.getState().setPage("settings")}
      >
        Open settings
      </button>
      <div
        className="fixture-chat"
        data-testid="behind"
        aria-hidden="true"
        inert={open || sheet.mounted ? true : undefined}
      >
        <button id="behind-action" type="button" onClick={() => { window.behindClicks = (window.behindClicks ?? 0) + 1; }}>
          Behind action
        </button>
      </div>
      {sheet.mounted ? (
        <SettingsPage exiting={sheet.exiting} onExited={sheet.onExited} />
      ) : null}
    </div>
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
const sheet = () => document.querySelector(".settings-sheet");
const overlay = () => document.querySelector(".settings-overlay");
const pane = () => document.querySelector(".settings-content");
const categoryButton = (label) => [...document.querySelectorAll(".settings-category")]
  .find((node) => node.textContent.trim() === label);
const subnavButton = (label) => [...document.querySelectorAll(".settings-subnav-item")]
  .find((node) => node.querySelector(".settings-nav-label")?.textContent?.trim() === label);
const title = () => document.querySelector(".settings-section-title")?.textContent?.trim() ?? "";
/** Wait for the entrance animation instead of sleeping through it. */
async function waitForSettled(node) {
  const animations = node?.getAnimations?.() ?? [];
  await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  await settle();
}
async function openSettings() {
  await settle();
  const current = sheet();
  // A sheet still playing its exit is not open: the entry click cancels it.
  if (!current || current.classList.contains("is-exiting")) {
    // A real click focuses the entry too; the panel must give focus back to it.
    flushSync(() => {
      const entry = document.getElementById("open-settings");
      entry.focus();
      entry.click();
    });
    await settle();
  }
  await waitForSettled(sheet());
  assert(sheet(), "the settings sheet must open");
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
  if (!sheet()) await openSettings();
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

/** Sheet geometry: the plan's starter values, measured in a real window. */
function centerOf(node) {
  const box = node.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** Nothing may paint over the head: a control in the DOM proves nothing. */
function headerChecks() {
  const head = document.querySelector(".settings-panel-head");
  const title = document.querySelector(".settings-panel-title");
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
  assert(visible(title), "the title must be the top-most pixel at its center");
  assert(visible(close), "the close button must be the top-most pixel at its center");
  assert(visible(search), "the search field must be the top-most pixel at its center");
  assert(bands.length === 0, `no decorative band may cover the head: ${JSON.stringify(bands)}`);
  assert(region === "drag", `the head must be the window drag region: ${region}`);
  return {
    title: visible(title), close: visible(close), search: visible(search),
    dragRegion: region, headHeight: Math.round(head.getBoundingClientRect().height),
  };
}

function geometryChecks() {
  const box = sheet().getBoundingClientRect();
  const heightRatio = box.height / innerHeight;
  const radius = Number.parseFloat(getComputedStyle(sheet()).borderTopLeftRadius);
  const left = box.left;
  const right = innerWidth - box.right;
  const summary = { heightRatio, radius, left, right, width: box.width, innerWidth, innerHeight };
  assert(heightRatio > 0.86 && heightRatio <= 0.92, `sheet height must be ~90% of the window: ${JSON.stringify(summary)}`);
  assert(box.bottom >= innerHeight - 1, `the sheet must sit on the window bottom: ${JSON.stringify(summary)}`);
  assert(left >= 15 && left <= 25 && right >= 15 && right <= 25,
    `side gutters must stay in the 16-24px range: ${JSON.stringify(summary)}`);
  assert(radius >= 17 && radius <= 21, `top corners must stay 18-20px: ${JSON.stringify(summary)}`);
  const content = pane().getBoundingClientRect();
  assert(content.bottom <= innerHeight + 1 && content.top >= box.top,
    "the content area must stay inside the sheet");
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
      sheet: Boolean(sheet()),
      page: useAppStore.getState().page,
    };
    assert(afterFirst.editor === false, `Escape must close the ${item.name} editor: ${JSON.stringify(afterFirst)}`);
    assert(afterFirst.sheet === true, `Escape must not close the sheet for ${item.name}: ${JSON.stringify(afterFirst)}`);
    assert(afterFirst.page === "settings", `the page must stay on settings for ${item.name}`);
    // The next Escape, with nothing on top, closes the sheet.
    await rows(["Capabilities", item.destination]);
    pressKey(document.querySelector(".settings-search"), "Escape");
    await settle();
    await waitForSettled(sheet());
    await until(() => !sheet(), "the second Escape must close the sheet");
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

  // The scrim asks instead of discarding.
  flushSync(() => overlay().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await settle();
  const confirm = document.querySelector(".settings-draft-confirm");
  assert(confirm, "a dirty page must ask before leaving");
  assert(sheet(), "the sheet must stay open until the user decides");
  const keep = [...confirm.querySelectorAll("button")]
    .find((node) => node.textContent.trim() === i18n.t("settings.draftKeepEditing"));
  assert(keep, "the confirmation must offer to keep editing");
  flushSync(() => keep.click());
  await settle();
  assert(editor()?.value === "UNSAVED_E2E_DRAFT", "keeping must leave the draft in place");

  // The close button asks too; discarding is explicit.
  flushSync(() => document.querySelector(".settings-close").click());
  await settle();
  const discard = [...document.querySelectorAll(".settings-draft-confirm button")]
    .find((node) => node.textContent.trim() === i18n.t("settings.draftDiscard"));
  assert(discard, "the confirmation must offer an explicit discard");
  flushSync(() => discard.click());
  await settle();
  await waitForSettled(sheet());
  assert(!sheet(), "discarding must close the sheet");

  // An untouched sheet closes from the scrim.
  await openSettings();
  await rows(["AI", "Instructions & memory"]);
  assert(editor()?.value === "saved instructions", "the discarded draft must not persist");
  flushSync(() => overlay().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await settle();
  await waitForSettled(sheet());
  assert(!sheet(), "the scrim must close a sheet with no draft");
  return { confirmShown: true, explicitDiscard: true, scrimClosesUntouched: true };
}

async function exitChecks() {
  await openSettings();
  const behind = document.querySelector('[data-testid="behind"]');
  const box = behind.getBoundingClientRect();
  const point = { x: box.left + Math.min(30, box.width / 2), y: box.top + Math.min(30, box.height / 2) };

  flushSync(() => document.querySelector(".settings-close").click());
  await frame();
  const top = document.elementFromPoint(point.x, point.y);
  const duringExit = {
    sheetPresent: Boolean(sheet()),
    exiting: Boolean(sheet()?.classList.contains("is-exiting")),
    chatInert: behind.hasAttribute("inert"),
    covered: Boolean(top?.closest(".settings-overlay")),
  };
  const before = window.behindClicks ?? 0;
  flushSync(() => top?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await settle();
  const after = window.behindClicks ?? 0;

  // Reopening during the exit must survive the stale exit callback.
  await openSettings();
  await new Promise((resolve) => setTimeout(resolve, 450));
  await settle();
  const reopened = { sheetPresent: Boolean(sheet()), exiting: Boolean(sheet()?.classList.contains("is-exiting")) };

  flushSync(() => document.querySelector(".settings-close").click());
  await waitForSettled(sheet());
  await until(() => !sheet(), "the sheet must unmount after its exit");
  const settled = { chatInert: document.querySelector('[data-testid="behind"]').hasAttribute("inert") };

  assert(duringExit.sheetPresent && duringExit.exiting, `the exit must still be running: ${JSON.stringify(duringExit)}`);
  assert(duringExit.chatInert, `the background must stay inert during the exit: ${JSON.stringify(duringExit)}`);
  assert(duringExit.covered, `the scrim must still cover the app during the exit: ${JSON.stringify(duringExit)}`);
  assert(after === before, `a click during the exit must not reach the app: ${before} -> ${after}`);
  assert(reopened.sheetPresent && !reopened.exiting,
    `reopening during the exit must not be undone by the stale exit: ${JSON.stringify(reopened)}`);
  assert(settled.chatInert === false, "the background must be released once the sheet is gone");
  return { duringExit, clickedBehind: after - before, reopened, settled };
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
    assert(sheet(), `${label} must leave the sheet open`);
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
  checks.push(await exitChecks());
  checks.push(await scrollChecks());
  checks.push(await brazilianPortugueseChecks());
  checks.push(await updatePreferenceChecks());
  const stillOpen = Boolean(sheet());
  return { ok: true, geometry, header, categories, stillOpen, checks };
};

/** Used by the screenshot pass: open the sheet and settle it. */
window.settingsOpenProbe = async () => {
  await openSettings();
  return { open: Boolean(sheet()) };
};
window.settingsCloseProbe = async () => {
  const close = document.querySelector(".settings-close");
  if (close) flushSync(() => close.click());
  await settle();
  await until(() => !sheet(), "the sheet must close after a screenshot");
  return { open: Boolean(sheet()) };
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

  // The sheet keeps its shape in this window: the categories are reachable —
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
  const sheetBox = sheet().getBoundingClientRect();
  assert(sheetBox.width <= innerWidth + 1 && sheetBox.left >= -1 && sheetBox.right <= innerWidth + 1,
    `${language}/${innerWidth}: the sheet must stay inside the window`);
  assert(pane().scrollWidth <= pane().clientWidth + 1,
    `${language}/${innerWidth}: the content area must not overflow horizontally`);

  const narrow = innerWidth <= 720 || innerHeight <= 560;
  if (narrow) {
    assert(Math.abs(sheetBox.width - innerWidth) <= 1, `${language}/${innerWidth}: a small window takes the full width`);
    assert(Number.parseFloat(getComputedStyle(sheet()).borderTopLeftRadius) === 0,
      `${language}/${innerWidth}: a small window squares the corners`);
  }

  for (const [index, value] of ["compact", "standard", "detailed"].entries()) {
    flushSync(() => buttons[index].click());
    await settle();
    assert(settings.transcriptDensity === value, "The selected density must persist through settings IPC");
    assert(buttons[index].getAttribute("aria-checked") === "true", "The saved density must be visibly selected");
  }
  return { language, fontScale, width: innerWidth, height: innerHeight,
    sheetWidth: Math.round(sheetBox.width), sheetHeight: Math.round(sheetBox.height),
    categories: categories.mode,
    controlWidth: Math.round(bounds.width),
    optionRows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size };
};

/**
 * Reduced motion: the sheet must stop moving without skipping the exit that
 * unmounts it (duration near zero, not `animation: none`).
 */
window.settingsReducedMotionProbe = async () => {
  await settle();
  await openSettings();
  const style = getComputedStyle(sheet());
  const durations = style.animationDuration.split(",").map((value) => Number.parseFloat(value));
  const measured = { duration: durations[0], animationName: style.animationName };
  assert(durations.every((value) => value <= 0.001),
    `reduced motion must remove the travel: ${JSON.stringify(measured)}`);
  assert(style.animationName !== "none",
    `reduced motion must keep an animation end for the exit: ${JSON.stringify(measured)}`);
  flushSync(() => document.querySelector(".settings-close").click());
  await settle();
  // The near-zero exit still has to end and unmount the sheet.
  await until(() => !sheet(), "closing must still unmount the sheet under reduced motion");
  return measured;
};
