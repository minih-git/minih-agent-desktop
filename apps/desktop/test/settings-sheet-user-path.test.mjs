/**
 * Settings as a user meets it: a full-window page with a visible header, an
 * editor whose draft survives searching and leaving, nested editors that own
 * their Escape, and an immediate return to the app behind it.
 *
 * Production components with a fixture IPC boundary only; no real account, no
 * paid model, no connection to the user's desktop.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

/** Inline `?url` asset imports resolve to file loaders, as in the app build. */
const urlAssets = {
  name: "local-url-assets",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)),
      namespace: "local-url-asset",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path),
      loader: "file",
    }));
  },
};

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) },
    "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });

let settings = { theme: "light", language: "en", developerMode: false, enterToSend: true };
let instructions = { global: { path: "/fixture/AGENTS.md", content: "saved instructions" }, project: null };
let saveDelay = null;
const calls = [];
window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, input) {
    calls.push({ channel, input });
    switch (channel) {
      case IPC.invoke.settingsGet: return { ok: true, data: settings };
      case IPC.invoke.settingsSet: return { ok: true, data: input };
      case IPC.invoke.pluginScenicThemesDestinations: return { ok: true, data: [] };
      case IPC.invoke.systemFontsList: return { ok: true, data: [] };
      case IPC.invoke.providersList: return { ok: true, data: { providers: [] } };
      case IPC.invoke.sessionList: return { ok: true, data: { sessions: [] } };
      case IPC.invoke.projectsList: return { ok: true, data: { projects: [] } };
      case IPC.invoke.commandShellList:
        return { ok: true, data: { choices: [], effective: null } };
      case IPC.invoke.agentInstructionsGet: return { ok: true, data: instructions };
      case IPC.invoke.agentInstructionsSave:
        if (saveDelay) await new Promise((resolve) => { saveDelay = resolve; });
        instructions = { ...instructions, global: { ...instructions.global, content: input.content } };
        return { ok: true, data: { file: instructions.global } };
      default: return { ok: true, data: {} };
    }
  },
};
useAppStore.setState({ settings, settingsTab: "general", page: "chat" });
document.documentElement.dataset.theme = "light";
document.documentElement.dataset.platform = "darwin";

let behindClicks = 0;
/**
 * Mirrors the shell: the chat surface stays mounted but hidden and inert while
 * the route shows Settings, and the page itself mounts only while it is open.
 * The entry control sits outside the shell so it does not take page space.
 */
function Host() {
  const page = useAppStore((state) => state.page);
  const open = page === "settings";
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "app-shell" },
      React.createElement("div", {
        className: "fixture-chat",
        hidden: open || undefined,
        inert: open ? true : undefined,
        "data-testid": "behind",
      }, React.createElement("button", {
        id: "behind",
        type: "button",
        onClick: () => { behindClicks += 1; },
      }, "Behind")),
      open ? React.createElement(SettingsPage) : null),
    React.createElement("button", {
      id: "open-settings",
      type: "button",
      onClick: () => useAppStore.getState().setPage("settings"),
    }, "Open settings"));
}

const reactRoot = createRoot(document.getElementById("root"));
flushSync(() => reactRoot.render(React.createElement(Host)));
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { await frame(); await frame(); };
const check = (value, message) => { if (!value) throw new Error(message); };
const pageRoot = () => document.querySelector(".settings-page");
const content = () => document.querySelector(".settings-page-content");
const legacy = () => document.querySelector(".settings-overlay, .settings-sheet");
const categoryButton = (label) => [...document.querySelectorAll(".settings-category, .settings-category-select")]
  .find((node) => node.textContent.trim() === label);
const subnavButton = (label) => [...document.querySelectorAll(".settings-subnav-item")]
  .find((node) => node.querySelector(".settings-nav-label")?.textContent.trim() === label);
const textOf = (node) => (node?.textContent ?? "").trim();
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > end) throw new Error(message);
    await frame();
  }
};
const setValue = (element, value) => {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
};
const pressEscape = async (target) => {
  flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
};
async function openSettings() {
  await settle();
  if (!pageRoot()) {
    flushSync(() => {
      const entry = document.getElementById("open-settings");
      entry.focus({ preventScroll: true });
      entry.click();
    });
    await settle();
  }
  check(pageRoot(), "the settings page must open");
}
async function goTo(category, destination) {
  await openSettings();
  const target = categoryButton(category);
  check(target, "missing category " + category);
  if (!target.classList.contains("active")) {
    flushSync(() => target.click());
    await settle();
  }
  if (destination) {
    const tab = subnavButton(destination);
    check(tab, "missing destination " + destination);
    if (!tab.classList.contains("active")) {
      flushSync(() => tab.click());
      await settle();
    }
  }
}

/** (P1-0) The page fills the window and is the route, not a modal. */
window.geometryProbe = async () => {
  await openSettings();
  const page = pageRoot();
  const inner = content();
  check(page, "the settings page must render");
  check(inner, "the settings page content must render");
  check(legacy() === null, "no sheet or overlay may remain");
  const rootBox = page.getBoundingClientRect();
  const innerBox = inner.getBoundingClientRect();
  const rootStyle = getComputedStyle(page);
  const innerStyle = getComputedStyle(inner);
  const clientWidth = document.documentElement.clientWidth;
  const clientHeight = document.documentElement.clientHeight;
  const zero = (value) => Number.parseFloat(value) === 0;
  const report = {
    viewport: { clientWidth, clientHeight, innerWidth, innerHeight },
    root: {
      left: rootBox.left, top: rootBox.top, width: rootBox.width, height: rootBox.height,
      radius: [
        rootStyle.borderTopLeftRadius, rootStyle.borderTopRightRadius,
        rootStyle.borderBottomLeftRadius, rootStyle.borderBottomRightRadius,
      ],
      margin: [rootStyle.marginTop, rootStyle.marginRight, rootStyle.marginBottom, rootStyle.marginLeft],
      shadow: rootStyle.boxShadow,
      transform: rootStyle.transform,
      animationName: rootStyle.animationName,
      animationDuration: rootStyle.animationDuration,
      role: page.getAttribute("role"),
      ariaModal: page.getAttribute("aria-modal"),
    },
    content: {
      left: innerBox.left, top: innerBox.top, width: innerBox.width, height: innerBox.height,
      role: inner.getAttribute("role"),
      transform: innerStyle.transform,
      animationName: innerStyle.animationName,
      paddingTop: innerStyle.paddingTop,
    },
  };
  check(Math.abs(rootBox.left) <= 1 && Math.abs(rootBox.top) <= 1,
    "the settings page must start at the client origin: " + JSON.stringify(report.root));
  check(Math.abs(rootBox.width - clientWidth) <= 1 && Math.abs(rootBox.height - clientHeight) <= 1,
    "the settings page must fill the client area: " + JSON.stringify(report.root));
  check(Math.abs(innerBox.left) <= 1 && Math.abs(innerBox.top) <= 1 &&
    Math.abs(innerBox.width - clientWidth) <= 1 && Math.abs(innerBox.height - clientHeight) <= 1,
    "the settings page content must fill the client area: " + JSON.stringify(report.content));
  check(report.root.radius.every(zero), "the page must have no corner radius: " + JSON.stringify(report.root));
  check(report.root.margin.every(zero), "the page must have no margin: " + JSON.stringify(report.root));
  check(report.root.shadow === "none", "the page must have no shadow: " + JSON.stringify(report.root));
  check(report.root.transform === "none", "the page must not be transformed: " + JSON.stringify(report.root));
  check(report.root.animationName === "none", "the page must not animate: " + JSON.stringify(report.root));
  check((rootStyle.animationDuration || "0s").split(",").every(zero),
    "the page must have no animation duration: " + JSON.stringify(report.root));
  check(report.content.role === "main", "the content must be the main landmark: " + JSON.stringify(report.content));
  check(report.root.role !== "dialog" && report.root.ariaModal === null,
    "the page root must not be a modal dialog: " + JSON.stringify(report.root));
  check(report.content.transform === "none" && report.content.animationName === "none",
    "the content must not animate or transform: " + JSON.stringify(report.content));
  return report;
};

/** (P1-1) The header is painted, not hidden behind a decorative band. */
window.headerProbe = async () => {
  await openSettings();
  const head = document.querySelector(".settings-panel-head");
  const title = document.querySelector(".settings-panel-title");
  const close = document.querySelector(".settings-close");
  const search = document.querySelector(".settings-search");
  const center = (node) => {
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const hits = (node) => {
    const point = center(node);
    const top = document.elementFromPoint(point.x, point.y);
    return { top: top?.className || top?.tagName, inside: Boolean(top && node.contains(top)) };
  };
  const bands = [...document.querySelectorAll(".settings-titlebar")].map((node) => {
    const style = getComputedStyle(node);
    return { zIndex: style.zIndex, background: style.backgroundColor, position: style.position };
  });
  const headBox = head.getBoundingClientRect();
  const titleBox = title.getBoundingClientRect();
  const contentBox = content().getBoundingClientRect();
  const state = {
    title: hits(title),
    close: hits(close),
    search: hits(search),
    bands,
    titlebarSpace: Math.max(headBox.top, titleBox.top) - contentBox.top,
    headHeight: Math.round(headBox.height),
    dragRegion: getComputedStyle(head).webkitAppRegion ?? getComputedStyle(head).getPropertyValue("-webkit-app-region"),
  };
  check(state.title.inside, "the settings title must be the top-most element at its center: " + JSON.stringify(state.title));
  check(state.close.inside, "the close button must be the top-most element at its center: " + JSON.stringify(state.close));
  check(state.search.inside, "the search field must be the top-most element at its center: " + JSON.stringify(state.search));
  check(bands.length === 0, "no decorative band may paint over the header: " + JSON.stringify(bands));
  check(state.titlebarSpace >= 46,
    "the header must reserve the 46px native titlebar band: " + JSON.stringify(state));
  check(String(state.dragRegion).trim() === "drag", "the header itself must be the window drag region: " + state.dragRegion);
  return state;
};

/** (P1-2) A draft survives searching; leaving it is a decision, not an accident. */
window.draftProbe = async () => {
  await goTo("AI", "Instructions & memory");
  const editor = () => document.querySelector(".settings-instruction-editor");
  await until(() => editor(), "the global instruction editor must render");
  const before = editor().value;
  setValue(editor(), "UNSAVED_REVIEW_DRAFT");
  await settle();

  // Searching must not unmount the editor that holds the draft.
  setValue(document.querySelector(".settings-search"), "proxy");
  await settle();
  const mountedWhileSearching = Boolean(editor());
  const draftWhileSearching = editor()?.value ?? null;
  setValue(document.querySelector(".settings-search"), "");
  await settle();
  const afterSearch = editor()?.value ?? null;

  // The close button asks before discarding it.
  flushSync(() => document.querySelector(".settings-close").click());
  await settle();
  const confirmDialog = document.querySelector(".settings-draft-confirm");
  const stillOpen = Boolean(pageRoot());
  const cancelled = (() => {
    const button = confirmDialog && [...confirmDialog.querySelectorAll("button")]
      .find((node) => textOf(node) === i18n.t("settings.draftKeepEditing"));
    if (!button) return false;
    flushSync(() => button.click());
    return true;
  })();
  await settle();
  const draftAfterCancel = editor()?.value ?? null;
  const openAfterCancel = Boolean(pageRoot());

  // Discarding is explicit, and it closes without waiting for an exit.
  flushSync(() => document.querySelector(".settings-close").click());
  await settle();
  const discard = [...(document.querySelector(".settings-draft-confirm")?.querySelectorAll("button") ?? [])]
    .find((node) => textOf(node) === i18n.t("settings.draftDiscard"));
  check(discard, "the close confirmation must offer an explicit discard");
  flushSync(() => discard.click());
  const goneOnDiscard = !pageRoot();
  await settle();
  const pageAfterDiscard = useAppStore.getState().page;

  // Reopening shows the saved content, because discarding was explicit.
  await goTo("AI", "Instructions & memory");
  await until(() => editor(), "the editor must render again");
  const afterReopen = editor().value;

  // An in-flight save cannot be discarded, even from the close button.
  await goTo("AI", "Instructions & memory");
  await until(() => editor(), "the editor must render for the saving check");
  setValue(editor(), "SAVING_REVIEW_DRAFT");
  await settle();
  const saveButton = [...document.querySelectorAll(".settings-content button")]
    .find((node) => textOf(node) === i18n.t("settings.instructionsSave"));
  check(saveButton, "the instruction page must offer its explicit save");
  // Hold the save open so the leaving attempt lands while it is in flight.
  saveDelay = true;
  flushSync(() => saveButton.click());
  await settle();
  flushSync(() => document.querySelector(".settings-close").click());
  await settle();
  const savingDialog = document.querySelector(".settings-draft-confirm");
  const savingDiscard = [...(savingDialog?.querySelectorAll("button") ?? [])]
    .find((node) => textOf(node) === i18n.t("settings.draftDiscard"));
  const savingBlocked = {
    dialog: Boolean(savingDialog),
    discardDisabled: savingDiscard ? savingDiscard.disabled : null,
    pageOpen: Boolean(pageRoot()),
    saveButtonDisabledWhileSaving: saveButton.disabled,
  };
  if (typeof saveDelay === "function") saveDelay();
  await settle();
  // Once the save settles the decision unlocks; the dialog waits for the user.
  await until(
    () => {
      const button = [...(document.querySelector(".settings-draft-confirm")?.querySelectorAll("button") ?? [])]
        .find((node) => textOf(node) === i18n.t("settings.draftDiscard"));
      return Boolean(button) && button.disabled === false;
    },
    "the save must settle and unlock the decision",
  );
  const afterSave = editor()?.value ?? null;
  flushSync(() => {
    const keep = [...document.querySelectorAll(".settings-draft-confirm button")]
      .find((node) => textOf(node) === i18n.t("settings.draftKeepEditing"));
    keep.click();
  });
  await settle();
  // Leave the page clean for the close check below: the save above made
  // SAVING_REVIEW_DRAFT the stored content.
  setValue(editor(), "SAVING_REVIEW_DRAFT");
  await settle();

  // An untouched page closes from its own close button, with no delayed exit.
  flushSync(() => document.querySelector(".settings-close").click());
  const closeImmediate = {
    pagePresent: Boolean(pageRoot()),
    confirm: Boolean(document.querySelector(".settings-draft-confirm")),
    page: useAppStore.getState().page,
  };
  await settle();
  const untouchedClosed = !pageRoot();

  const report = {
    before, mountedWhileSearching, draftWhileSearching, afterSearch,
    confirmShown: Boolean(confirmDialog), stillOpen, cancelled,
    draftAfterCancel, openAfterCancel, goneOnDiscard, pageAfterDiscard,
    afterReopen, savingBlocked, afterSave, closeImmediate, untouchedClosed,
  };
  check(mountedWhileSearching, "searching must keep the editing page mounted: " + JSON.stringify(report));
  check(draftWhileSearching === "UNSAVED_REVIEW_DRAFT", "the draft must survive the search: " + JSON.stringify(report));
  check(afterSearch === "UNSAVED_REVIEW_DRAFT", "clearing the search must keep the draft: " + JSON.stringify(report));
  check(report.confirmShown, "closing with a draft must ask first: " + JSON.stringify(report));
  check(stillOpen, "the page must stay open until the user decides: " + JSON.stringify(report));
  check(cancelled && draftAfterCancel === "UNSAVED_REVIEW_DRAFT" && openAfterCancel,
    "keeping the draft must leave the page open with its content: " + JSON.stringify(report));
  check(goneOnDiscard, "discarding must close the page at once: " + JSON.stringify(report));
  check(pageAfterDiscard === "chat", "discarding must return to the app: " + JSON.stringify(report));
  check(afterReopen === "saved instructions",
    "an explicitly discarded draft must leave the saved content: " + JSON.stringify(report));
  check(report.savingBlocked.dialog && report.savingBlocked.pageOpen,
    "a save in flight must ask before leaving: " + JSON.stringify(report));
  check(report.savingBlocked.discardDisabled === true,
    "a save in flight must not be discarded: " + JSON.stringify(report));
  check(report.afterSave === "SAVING_REVIEW_DRAFT",
    "the completed save must keep the value it wrote: " + JSON.stringify(report));
  check(closeImmediate.pagePresent === false && closeImmediate.confirm === false &&
    closeImmediate.page === "chat",
    "an untouched page must close immediately: " + JSON.stringify(report));
  check(untouchedClosed, "the closed page must stay gone: " + JSON.stringify(report));
  return report;
};

/** (P1-3) A nested editor owns its Escape; leaving the page needs the next one. */
window.nestedEditorProbe = async () => {
  const results = [];
  const cases = [
    // The three editors share one surface class, so the probe cannot mistake
    // the settings page itself for an open editor.
    { destination: "Skills", add: "extensions.skills.add", sheetClass: ".ext-sheet", name: "skill" },
    { destination: "MCP", add: "settings.addMcp", sheetClass: ".ext-sheet", name: "mcp" },
    { destination: "Subagents", add: "extensions.subagents.add", sheetClass: ".ext-sheet", name: "subagent" },
  ];
  for (const item of cases) {
    await goTo("Capabilities", item.destination);
    const add = [...document.querySelectorAll(".settings-content button")]
      .find((node) => textOf(node) === i18n.t(item.add));
    check(add, "missing the add action for " + item.name + ": " + i18n.t(item.add));
    flushSync(() => add.click());
    await settle();
    const editor = document.querySelector(item.sheetClass);
    const editorOpen = Boolean(editor);
    if (editorOpen) {
      // Leave an unsaved edit in the editor: the parent must still stay open.
      const field = editor.querySelector("input, textarea") ?? editor;
      if (field !== editor) {
        const setter = Object.getOwnPropertyDescriptor(
          field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(field, "Unsaved " + item.name);
        flushSync(() => field.dispatchEvent(new Event("input", { bubbles: true })));
        await settle();
      }
      await pressEscape(field);
      await settle();
    }
    const afterFirst = {
      editor: Boolean(document.querySelector(item.sheetClass)),
      page: Boolean(pageRoot()),
      route: useAppStore.getState().page,
    };
    // A second Escape, with no inner surface left, closes the page.
    if (afterFirst.page) {
      await pressEscape(document.querySelector(".settings-search"));
      await settle();
      await until(() => !pageRoot(), "the second Escape must close the page for " + item.name);
      await openSettings();
    }
    results.push({ name: item.name, editorOpen, afterFirst });
    check(editorOpen, "the " + item.name + " editor must open from its add action");
    check(afterFirst.editor === false, "Escape must close the " + item.name + " editor: " + JSON.stringify(afterFirst));
    check(afterFirst.page === true,
      "Escape inside the " + item.name + " editor must not close the settings page: " + JSON.stringify(afterFirst));
    check(afterFirst.route === "settings",
      "the route must stay on settings for " + item.name + ": " + JSON.stringify(afterFirst));
  }
  return results;
};

/** (P2-1) Closing is synchronous: the app is usable on the same commit. */
window.immediateCloseProbe = async () => {
  await openSettings();
  const chat = document.querySelector(".fixture-chat");
  const behind = document.getElementById("behind");
  const openState = {
    pagePresent: Boolean(pageRoot()),
    chatHidden: chat.hidden,
    chatInert: chat.hasAttribute("inert"),
    page: useAppStore.getState().page,
  };

  flushSync(() => document.querySelector(".settings-close").click());
  const immediate = {
    pagePresent: Boolean(pageRoot()),
    legacyPresent: Boolean(legacy()),
    page: useAppStore.getState().page,
    chatHidden: chat.hidden,
    chatInert: chat.hasAttribute("inert"),
  };

  await settle();
  const box = behind.getBoundingClientRect();
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
  const closedAgain = {
    pagePresent: Boolean(pageRoot()),
    page: useAppStore.getState().page,
  };
  await settle();

  const report = { openState, immediate, afterFrame, afterDelay, reopened, closedAgain, behindClicks };
  check(openState.pagePresent && openState.chatHidden && openState.chatInert && openState.page === "settings",
    "the open page must own the window while the chat stays mounted and blocked: " + JSON.stringify(report));
  check(immediate.pagePresent === false && immediate.legacyPresent === false,
    "closing must remove the page synchronously: " + JSON.stringify(report));
  check(immediate.page === "chat", "closing must change the route at once: " + JSON.stringify(report));
  check(immediate.chatHidden === false && immediate.chatInert === false,
    "the background must be released in the same commit: " + JSON.stringify(report));
  check(afterFrame.chatHidden === false && afterFrame.chatInert === false &&
    afterFrame.chatDisplay !== "none" && afterFrame.chatBox.width > 1 && afterFrame.chatBox.height > 1 &&
    afterFrame.hitInsideChat,
    "the chat must be visible and take its own clicks after closing: " + JSON.stringify(report));
  check(afterFrame.focus === "open-settings",
    "focus must return to the entry on the next frame: " + JSON.stringify(report));
  check(afterDelay.pagePresent === false && afterDelay.legacyPresent === false &&
    afterDelay.chatHidden === false && afterDelay.chatInert === false,
    "no delayed exit may re-block the app: " + JSON.stringify(report));
  check(reopened.pagePresent && reopened.searchFocused && reopened.chatHidden && reopened.chatInert,
    "opening again must work like the first time: " + JSON.stringify(report));
  check(closedAgain.pagePresent === false && closedAgain.page === "chat",
    "a second close must be synchronous as well: " + JSON.stringify(report));
  return report;
};

/** (P2-2) When the seven labels do not fit, a category selector takes over. */
window.categoryProbe = async (language, fontScale) => {
  settings = { ...settings, language };
  flushSync(() => useAppStore.setState({ settings }));
  await i18n.changeLanguage(language);
  document.documentElement.style.setProperty("--font-scale", String(fontScale));
  await settle();
  await openSettings();
  const bar = document.querySelector(".settings-categories");
  const buttons = [...document.querySelectorAll(".settings-category")];
  const select = document.querySelector(".settings-category-select");
  const report = {
    language, fontScale, width: innerWidth,
    buttons: buttons.length,
    select: Boolean(select),
    labels: buttons.map((node) => textOf(node)),
    overflow: bar ? bar.scrollWidth - bar.clientWidth : null,
  };
  if (buttons.length) {
    check(bar.scrollWidth <= bar.clientWidth + 1,
      "a category bar may only stay when every label fits: " + JSON.stringify(report));
    const tops = new Set(buttons.map((node) => Math.round(node.getBoundingClientRect().top)));
    check(tops.size === 1, "categories must never wrap: " + JSON.stringify(report));
  } else {
    check(report.select, "the categories must be reachable through a selector: " + JSON.stringify(report));
    check(textOf(select).length > 0, "the selector must name the current category: " + JSON.stringify(report));
  }
  return report;
};
`;

test(
  "settings page keeps its header, its drafts, its nested editors, and closes immediately",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async (context) => {
    const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "settings-sheet-user-path-"));
    try {
      await build({
        stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
        alias: {
          "@minih-agent/i18n": join(root, "packages/i18n/src"),
          "@minih-agent/shared": join(root, "packages/shared/src"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
          i18next: join(root, "apps/desktop/node_modules/i18next"),
          "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
        plugins: [urlAssets],
      });
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><html data-platform="darwin"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      const rendererHtml = await readFile(join(root, "apps/desktop/out/renderer/index.html"), "utf8");
      const stylesheet = /href="([^"]+\.css)"/.exec(rendererHtml)?.[1];
      assert(stylesheet, "run the desktop build before this test");
      await writeFile(
        join(temp, "styles.css"),
        await readFile(join(root, "apps/desktop/out/renderer", stylesheet.replace(/^\//, "")), "utf8"),
      );
      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 720,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  const run = async (script) => {
    try { return await win.webContents.executeJavaScript(script); }
    catch (error) { throw new Error(script.replace(/^window\./, "") + " -> " + (error && error.message ? error.message : error)); }
  };
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("GEOMETRY " + JSON.stringify(await run("window.geometryProbe()")));
    console.log("HEADER " + JSON.stringify(await run("window.headerProbe()")));
    console.log("DRAFT " + JSON.stringify(await run("window.draftProbe()")));
    console.log("NESTED " + JSON.stringify(await run("window.nestedEditorProbe()")));
    console.log("CLOSE " + JSON.stringify(await run("window.immediateCloseProbe()")));
    const categories = [];
    for (const size of [[760, 720], [640, 560], [1000, 720]]) {
      win.setContentSize(size[0], size[1]);
      for (const language of ["en", "zh-CN"]) {
        for (const scale of [1, 1.5]) {
          categories.push(await run("window.categoryProbe(" + JSON.stringify(language) + "," + scale + ")"));
        }
      }
    }
    console.log("CATEGORIES " + JSON.stringify(categories));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
        env, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => { output += chunk; });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      assert.equal(code, 0, output.slice(-6000));
      for (const tag of ["GEOMETRY", "HEADER", "DRAFT", "NESTED", "CLOSE", "CATEGORIES"]) {
        assert.match(output, new RegExp("^" + tag + " ", "m"), tag + " missing:\n" + output.slice(-4000));
        const line = output.split(/\r?\n/).find((row) => row.startsWith(tag + " "));
        // Keep the measured evidence in the test output: a green run should
        // still show what the page actually looked like.
        context.diagnostic(line.slice(0, 1200));
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);