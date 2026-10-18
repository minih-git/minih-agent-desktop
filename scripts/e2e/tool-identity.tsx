import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import type { UiMessage } from "@minih-agent/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";

/** Mounted production rows; no model, MCP server, or desktop profile is used. */
export async function toolIdentityProbe() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:24px;left:24px;width:320px";
  document.body.append(host);
  const root = createRoot(host);
  const checks: string[] = [];
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(label);
    checks.push(label);
  };
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } } });
  const fixtures: Array<[string, Record<string, string>, string, string]> = [
    ["Skill", { id: "obsidian-knowledge" }, "obsidian-knowledge", "book-open"],
    ["mcp_personal_knowledge_knowledge_context", { topic: "servers" }, "mcp_personal_knowledge_knowledge_context", "server"],
    ["plugin_notes_inspect", { query: "servers" }, "plugin_notes_inspect", "plug"],
    ["CustomTool", { id: "example" }, "CustomTool", "wrench"],
  ];
  const render = (message: UiMessage, dense: boolean) => flushSync(() => root.render(
    <I18nextProvider i18n={i18n}>
      <SlotSessionProvider sessionId="tool-identity-probe">
        <ToolRow key={message.id} message={message} dense={dense} />
      </SlotSessionProvider>
    </I18nextProvider>,
  ));
  try {
    for (const locale of ["en", "zh-CN"]) {
      await i18n.changeLanguage(locale);
      for (const dense of [true, false]) {
        for (const [toolName, toolArgs, identity, icon] of fixtures) {
          const message: UiMessage = { id: `${locale}-${dense}-${toolName}`, role: "tool", content: "",
            createdAt: "2026-10-18T00:00:00Z", toolName, toolArgs, toolStatus: "running",
            toolResult: { details: { notice: "Fixture running" } } };
          render(message, dense);
          const header = host.querySelector<HTMLButtonElement>(".tool-row-header")!;
          const name = host.querySelector<HTMLElement>(".tool-row-identity")!;
          check(name?.textContent === identity, `${message.id}: visible identity`);
          check(name.title === identity, `${message.id}: full identity tooltip`);
          check(host.querySelector(`.tool-row-icon .lucide-${icon}`), `${message.id}: distinct icon`);
          check(header.getAttribute("aria-expanded") === "false", `${message.id}: initially collapsed`);
          check(name.getBoundingClientRect().width > 20, `${message.id}: identity has visible width`);
          check(host.scrollWidth <= host.clientWidth + 8, `${message.id}: no narrow-width overflow`);
          flushSync(() => header.click());
          check(header.getAttribute("aria-expanded") === "true", `${message.id}: click opens details`);
          const detailsId = header.getAttribute("aria-controls");
          check(detailsId && document.getElementById(detailsId) && host.textContent?.includes(Object.values(toolArgs)[0]), `${message.id}: arguments remain readable`);
          render({ ...message, toolStatus: "success", toolResult: { details: { notice: "Fixture completed" } } }, dense);
          check(header.getAttribute("aria-expanded") === "true", `${message.id}: completion preserves disclosure`);
          check(host.querySelector(".tool-row-identity")?.textContent === identity, `${message.id}: completion preserves identity`);
          check(!host.querySelector(".tool-spinner"), `${message.id}: completion clears spinner`);
          header.focus();
          flushSync(() => header.click());
          check(header.getAttribute("aria-expanded") === "false" && document.activeElement === header, `${message.id}: collapse preserves focus`);
        }
      }
    }
    return { ok: true, checks: checks.length };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
}
