import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import type { AppSettings, BrowserProxyRouting } from "@minih-agent/shared";
import { BrowserProxyRoutingSection } from "../../apps/desktop/src/components/settings/BrowserProxyRoutingSection";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { isBlockingOverlayActive } from "../../apps/desktop/src/lib/blocking-overlay";

await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", keySeparator: false,
  resources: Object.fromEntries(Object.entries(catalogs).map(([key, value]) => [key, { translation: flattenCatalog(value) }])),
  interpolation: { escapeValue: false },
});
const fixture: BrowserProxyRouting = {
  enabled: true,
  profiles: [{ id: "office", name: "Office", url: "socks5://127.0.0.1:1080" },
    { id: "personal", name: "Personal", url: "http://127.0.0.1:8080" }],
  rules: [{ id: "corp", kind: "host-wildcard", pattern: "*.corp.example", target: "office" },
    { id: "public", kind: "host-wildcard", pattern: "*.public.example", target: "personal" }],
  defaultTarget: "direct",
};
let saved = structuredClone(fixture);
let saves: BrowserProxyRouting[] = [];
let fail = false;
let release: (() => void) | undefined;
let hold = false;
let replace: (value: BrowserProxyRouting) => void;
Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
const errors = () => nodes<HTMLElement>(".toast.error .toast-message").map((node) => node.textContent ?? "");
function Fixture() {
  const [settings, setSettings] = useState<AppSettings>({ browserProxyRouting: saved } as AppSettings);
  replace = (value) => { saved = structuredClone(value); setSettings({ ...settings, browserProxyRouting: saved }); };
  return <main className="settings-content" style={{ padding: 32 }}><BrowserProxyRoutingSection settings={settings}
    saveSettings={async (patch) => {
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      if (fail) throw new Error("Synthetic save failure");
      saved = structuredClone(patch.browserProxyRouting!); saves.push(saved);
      setSettings((current) => ({ ...current, ...patch }));
    }} /></main>;
}
const root = createRoot(document.getElementById("root")!);
flushSync(() => root.render(<><Fixture /><ToastHost /></>));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const nodes = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];
function button(text: string) { const node = nodes<HTMLButtonElement>("button").find((x) => x.textContent?.trim() === text); check(node, "Missing button: " + text); return node; }
function input(label: string, index = 0) { const node = nodes<HTMLInputElement>("input").filter((x) => x.getAttribute("aria-label") === label)[index]; check(node, "Missing input: " + label); return node; }
async function click(node: HTMLElement) { node.focus(); node.click(); await settle(); }
async function fill(node: HTMLInputElement, value: string) {
  node.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true })); await settle();
}
async function blur(node: HTMLElement) {
  node.blur();
  node.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await settle();
}
async function key(node: HTMLElement, value: string, shiftKey = false) {
  node.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); await settle();
}
async function choose(label: string, text: string, index = 0) {
  const node = nodes<HTMLButtonElement>("button").filter((x) => x.getAttribute("aria-label") === label)[index];
  check(node, "Missing selector " + label); await click(node);
  const option = nodes<HTMLButtonElement>('[role="option"]').find((x) => x.textContent?.trim() === text);
  check(option, "Missing option " + text); await click(option);
}
function assertFits() {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const rect = dialog.getBoundingClientRect();
  check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, "Dialog escapes viewport");
  check(dialog.scrollWidth <= dialog.clientWidth + 1, "Dialog has horizontal overflow");
  const list = document.querySelector<HTMLElement>(".settings-routing-list")!;
  check(list.scrollWidth <= list.clientWidth + 1, "List has horizontal overflow");
}

Object.assign(window, {
  async routingProbe() {
    check(!document.querySelector('[role="dialog"]') && !document.querySelector("input"), "Editor must be collapsed");
    check(document.body.textContent?.includes("2 proxies, 2 rules"), "Saved summary missing");
    await click(button("Configure"));
    check(isBlockingOverlayActive(), "Native views must be blocked");
    check(document.activeElement?.getAttribute("aria-label") === "Close", "Initial focus missing");
    const close = document.activeElement as HTMLElement;
    await key(close, "Tab", true);
    check(document.activeElement?.tagName === "INPUT", "Shift+Tab must wrap focus");
    await key(document.activeElement as HTMLElement, "Tab");
    check(document.activeElement === close, "Tab must wrap to close");
    const exit = nodes<HTMLButtonElement>('button[aria-label="Default exit"]')[0];
    await click(exit);
    await key(document.activeElement as HTMLElement, "Escape");
    check(document.querySelector('[role="dialog"]') && !document.querySelector('[role="listbox"]'), "Escape closes menu first");
    await choose("Default exit", "Personal"); check(saved.defaultTarget === "personal", "Default not saved");
    const test = document.querySelector<HTMLInputElement>('.settings-routing-test input')!;
    await fill(test, "https://app.corp.example/path");
    check(document.querySelector('.settings-routing-result')?.textContent?.includes("Office"), "Saved table preview missing");
    await fill(test, "not a URL"); check(document.querySelector('.settings-routing-result')?.textContent?.includes("Enter an http"), "Invalid preview missing");
    await fill(input("Pattern"), "*.new.example"); await blur(input("Pattern"));
    check(saved.rules[0].pattern === "*.new.example", "Rule edit not saved");
    await click(nodes<HTMLButtonElement>('button[aria-label="Move down"]')[0]);
    check(saved.rules[1].id === "corp", "Order not persisted");
    await click(button("Add rule")); const count = saves.length;
    check(document.activeElement === input("Pattern", 2), "New rule must receive focus");
    await fill(input("Pattern", 2), ""); await blur(input("Pattern", 2));
    check(saves.length === count && document.querySelector('.settings-routing-error'), "Invalid row persisted or no feedback");
    await fill(input("Pattern", 2), "*.added.example"); await blur(input("Pattern", 2));
    check(saved.rules.length === 3, "New rule not saved");
    await choose("Matches", "Host regex", 2);
    const beforeInvalid = saves.length;
    await fill(input("Pattern", 2), "["); await blur(input("Pattern", 2));
    check(saves.length === beforeInvalid && document.querySelector('.settings-routing-error'), "Invalid regex saved");
    await fill(input("Pattern", 2), "added\\.example$"); await blur(input("Pattern", 2));
    await choose("Exit", "Personal", 2); check(saved.rules[2].target === "personal", "Rule exit not saved");
    await click(button("Proxies (2)"));
    await fill(input("Name"), "Company"); await blur(input("Name")); check(saved.profiles[0].name === "Company", "Proxy name not saved");
    await click(button("Add proxy")); await fill(input("Name", 2), "Temporary"); await blur(input("Name", 2));
    const beforeBadUrl = saves.length;
    await fill(input("Proxy URL", 2), "file:///bad"); await blur(input("Proxy URL", 2));
    check(saves.length === beforeBadUrl && document.querySelector('.settings-routing-error'), "Invalid proxy saved");
    await fill(input("Proxy URL", 2), "socks5://127.0.0.1:1081"); await blur(input("Proxy URL", 2));
    check(saved.profiles.length === 3, "New proxy not saved");
    await click(nodes<HTMLButtonElement>('button[aria-label="Delete"]')[2]); check(saved.profiles.length === 2, "Proxy delete failed");
    await click(nodes<HTMLButtonElement>('button[aria-label="Delete"]')[1]);
    check(saved.profiles.length === 1 && saved.rules.every((rule) => rule.target !== "personal") && saved.defaultTarget === "direct", "Referenced delete contract changed");
    fail = true;
    await fill(input("Name"), "Failing"); await blur(input("Name"));
    check(errors().at(-1)?.includes("Synthetic save failure"), "Save error not visible"); fail = false;
    await fill(input("Name"), "Company"); await blur(input("Name"));
    hold = true;
    await fill(input("Name"), "Waiting"); await blur(input("Name"));
    check(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.disabled, "Pending close not blocked");
    await key(document.activeElement as HTMLElement, "Escape"); check(document.querySelector('[role="dialog"]'), "Pending dialog dismissed");
    hold = false; release!(); await settle();
    await click(nodes<HTMLButtonElement>('button[aria-label="Close"]')[0]);
    check(!isBlockingOverlayActive() && document.activeElement?.textContent?.trim() === "Configure", "Close must release overlay and restore focus");
    await click(nodes<HTMLButtonElement>('[role="switch"]')[0]); check(!saved.enabled, "Switch failed");
    const disabledSaved = structuredClone(saved);
    await click(button("Configure")); await click(button("Add rule"));
    const last = nodes<HTMLInputElement>('input[aria-label="Pattern"]').at(-1)!;
    await fill(last, "*.disabled.example"); await blur(last);
    check(!saved.enabled && saved.profiles.length === disabledSaved.profiles.length, "Editing must not silently enable routing");
    await key(document.activeElement as HTMLElement, "Escape");
    if (document.querySelector('[role="dialog"]')) await key(nodes<HTMLButtonElement>('button[aria-label="Close"]')[0], "Escape");
    check(!document.querySelector('[role="dialog"]'), "Escape did not close");
    await click(button("Configure"));
    const overlay = document.querySelector<HTMLElement>(".settings-routing-overlay")!;
    overlay.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
    overlay.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
    overlay.click(); await settle(); check(!document.querySelector('[role="dialog"]'), "Backdrop did not close");
    replace({ ...fixture, enabled: false, profiles: [], rules: [] }); await settle();
    await click(button("Configure")); check(document.querySelector('.settings-routing-empty'), "Empty rules guidance missing");
    await click(button("Proxies (0)")); check(document.querySelector('.settings-routing-empty'), "Empty proxies guidance missing");
    await click(nodes<HTMLButtonElement>('button[aria-label="Close"]')[0]);
    const errorsReported = errors().length;
    for (const toastClose of nodes<HTMLButtonElement>(".toast button")) await click(toastClose);
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
    return { passed: true, savedWrites: saves.length, errorsReported };
  },
  async routingVisual(language: string, theme: string) {
    const long = { ...structuredClone(fixture), rules: Array.from({ length: 99 }, (_, i) => ({
      id: `rule-${i}`, kind: "host-wildcard" as const, pattern: i < 2 ? fixture.rules[i].pattern : `*.service-${i}.example`, target: i % 2 ? "personal" : "office",
    })) };
    replace(long); await i18n.changeLanguage(language); document.documentElement.dataset.theme = theme; await settle();
    const configure = button(i18n.t("settings.browserProxyConfigure"));
    await click(configure);
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
    assertFits();
    const list = document.querySelector<HTMLElement>('.settings-routing-list')!;
    check(list.scrollHeight > list.clientHeight, "99 rules must scroll");
    const footer = document.querySelector<HTMLElement>('.settings-routing-footer')!.getBoundingClientRect().top;
    list.scrollTop = list.scrollHeight; await settle();
    check(document.querySelector<HTMLElement>('.settings-routing-footer')!.getBoundingClientRect().top === footer, "Footer moved with list");
    list.scrollTop = 0; await settle();
    return { language, theme, width: innerWidth, fits: true, rows: 99 };
  },
  async routingProfiles() {
    await click(button(i18n.t("settings.browserProxyProfiles") + " (2)"));
    assertFits();
  },
  async routingClose() { await click(nodes<HTMLButtonElement>('button[aria-label="' + i18n.t("common.close") + '"]')[0]); },
});
