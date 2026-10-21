import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import type { AppSettings } from "@minih-agent/shared";
import { MacosWindowTranslucencyRow } from "../../apps/desktop/src/components/settings/MacosWindowTranslucencyRow";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api, validateSettingsWrite } from "../../apps/desktop/src/lib/api";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  for (let frame = 0; frame < 120; frame++) {
    if (predicate()) return;
    await paint();
  }
  throw new Error(message);
}

declare global { var upstreamReliabilityUiProbe: (applied: boolean) => Promise<{ ok: true; checks: string[] }>; }

globalThis.upstreamReliabilityUiProbe = async (applied) => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  document.documentElement.dataset.theme = "light";
  document.documentElement.dataset.platform = "darwin";
  document.body.style.cssText = "margin:0; padding:48px; display:flex; gap:40px; align-items:flex-start;";
  const host = document.createElement("section");
  host.className = "settings-panel";
  host.style.cssText = "width:470px; flex:none;";
  const panelHost = document.createElement("section");
  panelHost.style.cssText = "width:480px; height:500px; position:relative; flex:none; display:flex;";
  document.body.replaceChildren(host, panelHost);
  const root = createRoot(host);
  const panelRoot = createRoot(panelHost);
  let settings = { theme: "light", ...(applied ? {} : { macosWindowTranslucency: false }) } as AppSettings;
  let failSave = false;
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  let generation = 0;
  const checks: string[] = [];
  const state = async () => ({ maximized: false, macosWindowTranslucency: applied });
  api.windowControl = state;
  api.getSessionDelegations = async (sessionId) => ({ sessionId, messages: [] });
  const render = () => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}>
      <MacosWindowTranslucencyRow key={generation} settings={settings} saveSettings={async (patch) => {
        if (held) await held;
        if (failSave) throw new Error("fixture write rejected");
        settings = { ...settings, ...patch };
        render();
      }} />
    </I18nextProvider>,
  ));
  const toggle = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  const restart = () => host.textContent?.includes(catalogs.en.settings.windowTranslucencyRestart) === true;
  render();
  await paint(); await paint();
  check(toggle().getAttribute("aria-checked") === String(applied), "initial preference did not match applied state");
  check(!restart(), "unchanged preference incorrectly requires a restart");
  held = new Promise<void>((resolve) => { release = resolve; });
  toggle().click();
  await until(() => toggle().disabled, "save did not disable the toggle");
  check(toggle().getAttribute("aria-checked") === String(applied), "pending save faked success");
  release!(); held = undefined;
  await until(restart, "saved mismatch did not show a restart hint");
  await until(() => !toggle().disabled, "toggle stayed busy after save");
  toggle().click();
  await until(() => !restart() && !toggle().disabled, "reverting the preference did not clear the restart hint");
  checks.push("default, save, busy state, mismatch and revert");
  failSave = true;
  toggle().click();
  await until(() => host.textContent?.includes("fixture write rejected") === true, "save failure was hidden");
  check(toggle().getAttribute("aria-checked") === String(applied), "failed save changed the displayed preference");
  failSave = false;
  api.windowControl = async () => { throw new Error("fixture read rejected"); };
  generation++; render();
  await until(() => host.textContent?.includes("fixture read rejected") === true, "state-read failure was hidden");
  check(!restart(), "unreadable applied state invented a restart hint");
  api.windowControl = async () => ({ maximized: false });
  generation++; render(); await paint(); await paint();
  check(!restart(), "an older response without applied state invented a restart hint");
  checks.push("read/save failure and absent applied-state compatibility");
  api.windowControl = state;
  generation++; render(); await paint(); await paint();
  for (const value of [true, false]) {
    validateSettingsWrite({ ...settings, macosWindowTranslucency: value });
  }
  for (const value of [undefined, null, 0, "false", {}, []]) {
    let rejected = false;
    try { validateSettingsWrite({ ...settings, macosWindowTranslucency: value } as AppSettings); }
    catch (error) { rejected = error instanceof Error && error.message.includes("macosWindowTranslucency"); }
    check(rejected, "renderer accepted a non-boolean translucency setting");
  }
  checks.push("renderer settings boundary rejects non-booleans");

  const tabs = Array.from({ length: 18 }, (_, index) => ({ id: `new:fixture-${index}`, kind: "new" as const }));
  let closed: string | undefined;
  useAppStore.setState({
    activeSessionId: "fixture-session", workPanelTabs: tabs,
    activeWorkPanelTabId: tabs[0]!.id, pluginViews: [], workPanelWidth: 360,
    activateWorkPanelTab: (id) => useAppStore.setState({ activeWorkPanelTabId: id }),
    closeWorkPanelTab: (id) => {
      closed = id;
      useAppStore.setState({ workPanelTabs: tabs.filter((tab) => tab.id !== id), activeWorkPanelTabId: tabs[0]!.id });
    },
  });
  flushSync(() => panelRoot.render(<I18nextProvider i18n={i18n}><WorkPanel containerWidth={900} sidebarCollapsed /></I18nextProvider>));
  await Promise.all(panelHost.getAnimations({ subtree: true }).map((animation) => animation.finished));
  const strip = panelHost.querySelector<HTMLElement>(".work-panel-tab-strip")!;
  check(strip && strip.scrollWidth > strip.clientWidth, "fixture did not overflow the actual tab strip");
  const last = tabs.at(-1)!;
  flushSync(() => useAppStore.setState({ activeWorkPanelTabId: last.id }));
  await paint();
  const tab = [...panelHost.querySelectorAll<HTMLElement>("[data-work-panel-tab-id]")].find((node) => node.dataset.workPanelTabId === last.id)!;
  await Promise.all(tab.getAnimations({ subtree: true }).map((animation) => animation.finished));
  const close = tab.querySelector<HTMLButtonElement>(".work-panel-tab-close")!;
  const bounds = strip.getBoundingClientRect();
  const button = close.getBoundingClientRect();
  check(button.left >= bounds.left && button.right <= bounds.right + 1, "active close action is clipped by overflow: " + JSON.stringify({ bounds: bounds.toJSON(), button: button.toJSON(), scrollLeft: strip.scrollLeft, scrollWidth: strip.scrollWidth, active: tab.className, viewport: innerWidth }));
  check(getComputedStyle(close).opacity === "1", "active close action is invisible");
  const target = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
  check(target === close || close.contains(target), "visible close action is covered");
  close.click();
  await until(() => closed === last.id, "click did not close the active tab");
  check(!panelHost.querySelector(`[data-work-panel-tab-id="${last.id}"]`), "closed tab stayed visible");
  checks.push("overflowed active close action is visible, hit-testable and closes the tab");
  flushSync(() => useAppStore.setState({ activeWorkPanelTabId: tabs.at(-2)!.id }));
  await paint();
  return { ok: true, checks };
};
