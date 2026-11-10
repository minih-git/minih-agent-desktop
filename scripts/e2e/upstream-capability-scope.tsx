import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { AgentMcpPage } from "../../apps/desktop/src/components/settings/AgentMcpPage";
import { AgentSkillsPage } from "../../apps/desktop/src/components/settings/AgentSkillsPage";
import { RemoteHostsPage } from "../../apps/desktop/src/components/settings/RemoteHostsPage";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import { remoteEn } from "../../apps/desktop/src/locales/remote";

const A = "/projects/scope-a", B = "/projects/scope-b";
const settings = { defaultMode: "agent", theme: "light", language: "en" };
Object.defineProperty(window, "AudioContext", { value: undefined });
window.minihAgent = { platform: "darwin", on() { return () => {}; },
  async invoke() { return { ok: true, data: undefined }; } };
await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en), remote: remoteEn } },
  interpolation: { escapeValue: false } });
const root = createRoot(document.getElementById("root"));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
async function until(predicate, message) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await new Promise(requestAnimationFrame);
  assert(predicate(), message);
}
const click = (node) => { assert(node, "Missing action"); flushSync(() => node.click()); };
const row = () => [...document.querySelectorAll('.agent-capability-row')].find(node => node.querySelector('.agent-capability-name')?.textContent === "Scope fixture");
const toggle = () => row()?.querySelector('[role="switch"]');
const badge = () => row()?.querySelector('.is-override');
function setValue(element, value) {
  assert(element, "Missing form field");
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, value);
  flushSync(() => element.dispatchEvent(new Event("input", { bubbles: true })));
}

window.capabilityScopeProbe = async (kind) => {
  flushSync(() => root.render(null));
  let enabled = true;
  const overrides = new Map([[A, false]]);
  const writes = [];
  const changed = new Set();
  let hold = false, pendingA, acceptedB = false;
  api.listProjects = async () => ({ projects: [{ id: 1, path: A, name: "A" }, { id: 2, path: B, name: "B" }] });
  api.onPluginChanged = callback => { changed.add(callback); return () => changed.delete(callback); };
  api.onHostStatus = () => () => {};
  const listing = async (query) => {
    const effective = query.projectPath && overrides.has(query.projectPath) ? overrides.get(query.projectPath) : enabled;
    const record = { id: "scope-fixture", name: "Scope fixture", label: "Scope fixture", enabled: effective,
      level: "global", transport: "stdio", command: "fixture", description: "Controlled scope fixture", source: "user" };
    const data = { servers: query.level === "global" ? [record] : [], statuses: [], skills: query.level === "global" ? [record] : [] };
    if (hold && query.level === "global" && query.projectPath === A) {
      hold = false;
      return new Promise(resolve => { pendingA = () => resolve(data); });
    }
    if (query.level === "global" && query.projectPath === B) acceptedB = true;
    return data;
  };
  const setEnabled = async (id, next, query) => {
    writes.push({ id, enabled: next, ...query });
    if (query.projectPath) {
      if (next === enabled) overrides.delete(query.projectPath);
      else overrides.set(query.projectPath, next);
    } else enabled = next;
    return { server: { id, enabled: next }, skill: { id, enabled: next } };
  };
  api.listMcpServers = listing; api.listUserSkills = listing;
  api.listBuiltinSkills = async () => ({ builtins: [] });
  api.setMcpServerEnabled = setEnabled; api.setUserSkillEnabled = setEnabled;
  useAppStore.setState({ settings, workspace: { path: A, name: "A" }, toasts: [] });
  flushSync(() => root.render(kind === "mcp" ? <AgentMcpPage /> : <AgentSkillsPage />));
  await until(toggle, "Global row missing");
  assert(toggle().getAttribute("aria-checked") === "true", "Global switch must read default, not project override");
  assert(badge()?.textContent === i18n.t("settings.capabilityOverrideOff"), "Legacy off override must be visible");
  click(row().querySelector('[aria-haspopup="menu"]'));
  await until(() => document.querySelector('[role="menuitem"]'), "Row menu missing");
  click([...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.includes(i18n.t("settings.capabilityOverrideResetItem"))));
  await until(() => !badge() && writes.length === 1, "Reset must clear project override");
  assert(writes[0].projectPath === A && writes[0].enabled === true, "Reset must write global default in project scope");
  await until(() => !toggle().disabled, "Reset did not settle");
  click(toggle());
  await until(() => writes.length === 2 && !toggle().disabled, "Global toggle did not settle");
  assert(enabled === false && writes[1].projectPath === undefined, "Global toggle wrote a project override");
  // A same-value stored key may be hidden now and become a mismatch after a global toggle.
  overrides.set(A, false);
  for (const callback of changed) callback();
  await until(() => !document.querySelector('.agent-capability-panel.is-refreshing'), "Refresh did not settle");
  click(toggle());
  await until(() => enabled === true && !toggle().disabled && badge(), "Changing global default must refresh effective overrides");
  assert(badge().textContent === i18n.t("settings.capabilityOverrideOff"), "New mismatch direction is stale");
  hold = true;
  for (const callback of changed) callback();
  await until(() => pendingA, "Deferred project A read missing");
  flushSync(() => useAppStore.setState({ workspace: { path: B, name: "B" } }));
  await until(() => acceptedB && !badge(), "Project B should have no override");
  pendingA();
  await new Promise(requestAnimationFrame);
  assert(!badge(), "Late project A response repainted B override");
  assert(toggle().getAttribute("aria-checked") === "true", "Late project response changed default");
  let releaseWrite, writeReturned = false, lateReads = 0;
  const heldWrite = async (...args) => {
    await new Promise(resolve => { releaseWrite = resolve; });
    const result = await setEnabled(...args); writeReturned = true; return result;
  };
  api.setMcpServerEnabled = heldWrite; api.setUserSkillEnabled = heldWrite;
  click(toggle());
  await until(() => releaseWrite, "Held toggle did not start");
  flushSync(() => root.render(null));
  api.listMcpServers = api.listUserSkills = async query => { lateReads++; return listing(query); };
  releaseWrite();
  await until(() => writeReturned, "Held write did not settle");
  await new Promise(requestAnimationFrame);
  assert(lateReads === 0, "An unmounted page reloaded a late write");
  flushSync(() => root.render(kind === "mcp" ? <AgentMcpPage /> : <AgentSkillsPage />));
  await until(toggle, "Final settings view missing");
  return { kind, reset: true, globalWrites: true, refreshedMismatch: true, staleProjectRejected: true, unmountedWriteRetired: true };
};

window.sshBootstrapProbe = async () => {
  flushSync(() => root.render(null));
  api.listRemoteHosts = async () => ({ hosts: [] });
  api.onSessionsChanged = () => () => {};
  api.bootstrapRemoteHost = async () => { throw Object.assign(new Error("private fixture stderr"), { errorCode: "HOST_BOOTSTRAP_FAILED" }); };
  useAppStore.setState({ settings, toasts: [] });
  flushSync(() => root.render(<><RemoteHostsPage /><ToastHost /></>));
  await until(() => document.getElementById("remote-host-add-ssh") && !document.getElementById("remote-host-add-ssh").disabled, "SSH add unavailable");
  click(document.getElementById("remote-host-add-ssh"));
  await until(() => document.getElementById("remote-host-add-panel-ssh"), "SSH form missing");
  const form = document.getElementById("remote-host-add-panel-ssh");
  setValue(form.querySelector('[aria-label="Label"]'), "Fixture host");
  setValue(form.querySelector('[aria-label="Host"]'), "127.0.0.1");
  await until(() => !form.querySelector('[type="submit"]').disabled, "SSH form not ready");
  click(form.querySelector('[type="submit"]'));
  await until(() => document.querySelector('.toast-message'), "SSH failure toast missing");
  const message = document.querySelector('.toast-message').textContent;
  assert(remoteEn.hostBootstrapFailed && message.includes(remoteEn.hostBootstrapFailed), "SSH bootstrap must use specific summary");
  assert(!message.includes("private fixture stderr"), "Raw stderr leaked");
  return { ssh: true, specificSummary: true, rawStderrHidden: true };
};
