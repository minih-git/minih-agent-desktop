import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import type { AppSettings, SessionSummary, UiMessage } from "@minih-agent/shared";
import { TurnChangesCard } from "../../apps/desktop/src/features/chat/transcript/TurnChangesCard";
import { ReviewTab } from "../../apps/desktop/src/components/workpanel/ReviewTab";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import { OtherProvidersSection } from "../../apps/desktop/src/components/settings/OtherProvidersSection";

const fixtureSettings: AppSettings = { defaultMode: "agent", theme: "dark", enterToSend: true, onboardingDismissed: true };
function session(id: string, source: "desktop" | "remote" = "desktop"): SessionSummary {
  return { id, source, title: id, mode: "agent", messageCount: 1, thinkingLevel: "off", permissionMode: "inherit",
    createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
}

function edit(index: number): UiMessage {
  return {
    id: `edit-${index}`, role: "tool", content: "", createdAt: "2026-10-28T00:00:00Z",
    toolName: "Edit", toolCallId: `call-${index}`, toolStatus: "success",
    toolResult: { details: { root: "workspace", review: {
      version: 1, snapshotId: `snapshot-${index}`, messageId: `edit-${index}`,
      path: `src/目录/long-file-${index}.ts`, operation: "edit", status: "modified",
      state: "active", additions: 1, deletions: 1, reversible: true,
      hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "del", text: "old" }, { type: "add", text: `new ${index}` }] }],
    } } },
  };
}
const tools = Array.from({ length: 14 }, (_, index) => edit(index));
const current = edit(99);
const paint = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function Fixture() {
  const sessionId = useAppStore((state) => state.activeSessionId) ?? "";
  const visible = useAppStore((state) => state.workPanelOpen && state.workPanelTabs.some((tab) => tab.id === state.activeWorkPanelTabId && tab.kind === "review"));
  return <SlotSessionProvider sessionId={sessionId}>
    <main style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, padding: 8 }}>
      <div style={{ minWidth: 0 }}><TurnChangesCard tools={sessionId === "session-a" || sessionId.startsWith("remote:") ? tools : []} /></div>
      {visible && <div style={{ minWidth: 0, height: 280, overflow: "hidden" }}><ReviewTab /></div>}
    </main>
  </SlotSessionProvider>;
}

window.turnChangesProbe = async (language: "en" | "zh-CN") => {
  document.documentElement.dataset.theme = "dark";
  await i18n.use(initReactI18next).init({ lng: language, fallbackLng: "en",
    resources: { en: { translation: flattenCatalog(catalogs.en) }, "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
    interpolation: { escapeValue: false } });
  useAppStore.setState({ activeSessionId: "session-a", sessions: [session("session-a")],
    messages: [current], settings: fixtureSettings, workPanelTabs: [], activeWorkPanelTabId: undefined, workPanelOpen: false });
  const root = createRoot(document.getElementById("root")!);
  flushSync(() => root.render(<Fixture />));
  await paint();
  const rows = [...document.querySelectorAll<HTMLButtonElement>(".turn-changes-row")];
  check(rows.length === 12, "the summary must show twelve rows and a remainder");
  check(document.querySelector(".turn-changes-view-all"), "view all must be available");
  const card = document.querySelector<HTMLElement>(".turn-changes-card")!;
  const style = getComputedStyle(card);
  check(style.paddingTop === "8px" && style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent", "production ChatSurface card CSS must be loaded");
  check(card.scrollWidth <= card.clientWidth + 1, "card must not overflow at narrow width");
  check(rows.every((row) => row.getBoundingClientRect().height >= 24), "row targets must remain at least 24px");
  rows[0]!.click(); await paint();
  check(useAppStore.getState().workPanelOpen, "row navigation must open the real work panel state");
  const target = document.querySelector<HTMLElement>('[data-snapshot-id="snapshot-0"]');
  check(target, "a historical reading-window change must be available in Review");
  const header = target.querySelector<HTMLButtonElement>(".review-change-card-header")!;
  check(header.getAttribute("aria-expanded") === "true", "requested diff must expand");
  check(document.activeElement === header, "keyboard focus must follow the selected change");
  check(useAppStore.getState().messages.length === 1 && useAppStore.getState().messages[0] === current, "Review navigation must not mutate or reload the transcript");
  header.click(); await paint();
  check(header.getAttribute("aria-expanded") === "false", "the user must be able to collapse a revealed diff");
  rows[0]!.click(); await paint();
  check(header.getAttribute("aria-expanded") === "true", "a new navigation request must reveal the same diff again");
  document.querySelector<HTMLButtonElement>(".turn-changes-view-all")!.click(); await paint();
  check(document.querySelectorAll(".review-change-card").length === 15, "view all must include historical evidence and preserve the live row");
  const image = { language, width: innerWidth, rows: rows.length, historicalFocus: true, counts: 15 };
  console.log("TURN_CHANGES_SCREENSHOT");
  useAppStore.setState({ activeSessionId: "session-b", messages: [], sessions: [session("session-b")] });
  await paint();
  check(document.querySelectorAll(".review-change-card").length === 0, "a request must not leak into another session");
  useAppStore.setState({ activeSessionId: "remote:fixture", messages: [current], workPanelOpen: false, sessions: [session("remote:fixture", "remote")] });
  await paint();
  const remoteRows = [...document.querySelectorAll<HTMLButtonElement>(".turn-changes-row")];
  check(remoteRows.length === 12 && remoteRows.every((row) => row.disabled), "remote evidence stays read-only without offering local Review navigation");
  remoteRows[0]!.click(); await paint();
  check(!useAppStore.getState().workPanelOpen, "remote navigation must remain blocked");
  useAppStore.setState({ activeSessionId: "session-a", messages: [current], workPanelOpen: true, sessions: [session("session-a")] });
  await paint();
  return image;
};
declare global { interface Window { turnChangesProbe: (language: "en" | "zh-CN") => Promise<object>; } }

window.rowBusyProbe = async () => {
  api.listOauthVendors = async () => ({ vendors: [] });
  api.hasJevApiKey = async () => false;
  const requests: string[] = [];
  const first = Promise.withResolvers<{ ok: boolean }>();
  const second = Promise.withResolvers<{ ok: boolean }>();
  api.testProvider = (id) => {
    requests.push(id);
    return id === "provider-1" ? first.promise : second.promise;
  };
  const providers = [1, 2].map((index) => ({ id: `provider-${index}`, name: `Provider ${index}`,
    vendorKey: "custom", type: "openai_compatible" as const, protocol: "openai",
    enabled: true, authKind: "api_key", hasSecret: true, supportsReasoning: false,
    supportedThinkingLevels: [], models: [], createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" }));
  useAppStore.setState({ providers, settings: fixtureSettings });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<OtherProvidersSection defaultOpen />));
  await paint();
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-provider-id="${id}"]`)!;
  const testRow = async (id: string) => {
    const menu = row(id).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    check(menu && !menu.disabled, "an unrelated idle provider must remain operable");
    menu.scrollIntoView({ block: "center" }); await paint();
    menu.click(); await paint();
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes(i18n.t("settings.testConnection")));
    check(item, "the production provider menu must offer Test connection");
    item.click(); item.click(); await paint();
  };
  try {
    await testRow("provider-1");
    check(requests.length === 1, "a busy provider must not send duplicate tests");
    await testRow("provider-2");
    check(requests.join(",") === "provider-1,provider-2", "both provider rows must start independently");
    first.resolve({ ok: true }); await paint();
    check(!row("provider-1").querySelector('[role="status"]'), "settled provider spinner must stop");
    check(row("provider-2").querySelector('[role="status"]'), "the other provider spinner must stay active");
    check(row("provider-2").querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.disabled, "settling another row cannot unlock the pending row");
    second.resolve({ ok: true }); await paint();
    check(!row("provider-2").querySelector('[role="status"]'), "the final provider must settle independently");
    return { providerRows: 2, duplicateRequests: 0, independentSettlement: true };
  } finally { first.resolve({ ok: true }); second.resolve({ ok: true }); root.unmount(); container.remove(); }
};
declare global { interface Window { rowBusyProbe: () => Promise<object>; } }
