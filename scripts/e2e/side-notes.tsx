import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import "../../apps/desktop/src/styles/work-panel.css";

declare global {
  var sideNotesProbe: (keepMounted?: boolean) => Promise<{ ok: true; checks: string[] }>;
}
const assert = (condition: unknown, label: string) => {
  if (!condition) throw new Error(label);
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await frame();
  }
}

globalThis.sideNotesProbe = async (keepMounted = false) => {
  const previous = useAppStore.getState();
  const originalSteer = api.steer;
  const originalRoster = api.getSessionDelegations;
  const requests: Parameters<typeof api.steer>[0][] = [];
  const checks: string[] = [];
  let acknowledge: (() => void) | undefined;
  let refuse: ((error: Error) => void) | undefined;
  const toasts: string[] = [];
  api.steer = (request) => {
    requests.push(request);
    return new Promise((resolve, reject) => {
      acknowledge = () => resolve({ accepted: true, turnId: request.expectedTurnId });
      refuse = reject;
    });
  };
  api.getSessionDelegations = async (sessionId) => ({ sessionId, messages: [] });
  const host = document.createElement("main");
  host.style.cssText = "height:720px;display:flex;justify-content:flex-end";
  document.body.append(host);
  const uncaught: unknown[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
  const i18n = createInstance();
  await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: catalogs.en } }, interpolation: { escapeValue: false } });
  const input = () => host.querySelector("textarea.side-notes-input") as HTMLTextAreaElement;
  const send = () => host.querySelector(".side-notes-send") as HTMLButtonElement;
  const preset = () => host.querySelector(".side-notes-preset") as HTMLButtonElement;
  const write = (text: string) => flushSync(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Textarea native setter missing");
    setter.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const click = (button: HTMLButtonElement) => flushSync(() => button.click());
  const settle = async (reject = false) => {
    flushSync(() => reject ? refuse?.(new Error("Fixture refused the note")) : acknowledge?.());
    await until(() => !preset().disabled, "submission to settle");
  };
  try {
    useAppStore.setState({
      ...previous, activeSessionId: "side-a", messages: [], retainedTranscripts: {},
      sessionHistory: {}, transcriptViews: {},
      sessions: ["side-a", "side-b"].map((id) => ({ id, title: id, mode: "agent", source: "desktop", createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" })),
      runningSessions: { "side-a": true, "side-b": true },
      agentStatuses: { "side-a": { currentTurnId: "turn-a" }, "side-b": { currentTurnId: "turn-b" } },
      pendingPlans: {}, workPanelTabs: [], activeWorkPanelTabId: null,
      workPanelContexts: {}, workPanelOpen: true,
      showToast: (message) => { toasts.push(message); },
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><WorkPanel containerWidth={1000} sidebarCollapsed /></I18nextProvider>));
    await until(() => Boolean(host.querySelector('[data-work-panel-launcher-item="sideNotes"]')), "side-notes launcher");
    click(host.querySelector('[data-work-panel-launcher-item="sideNotes"]') as HTMLButtonElement);
    await until(() => Boolean(input()), "side-notes input");
    assert(!input().disabled && send().disabled, "running session accepts only nonempty notes");
    checks.push("launcher opens production side-notes tab");

    write("Keep my unsent draft");
    click(preset());
    assert(requests[0]?.sideNote === true && requests[0]?.content === i18n.t("panel.sideNotes.presetProgress"), "preset uses production steering");
    // This assertion is deliberately after acknowledgement: old code cleared
    // an unrelated draft even though the preset never submitted that text.
    acknowledge?.();
    await frame();
    await frame();
    assert(input().value === "Keep my unsent draft", "preset acknowledgement must preserve an unrelated draft");
    checks.push("preset preserves unsent draft");

    write("First submitted note");
    click(send());
    assert(send().disabled && preset().disabled && !input().disabled, "pending send disables duplicate actions but permits editing");
    write("Next note written while waiting");
    await settle();
    assert(input().value === "Next note written while waiting", "acknowledgement must not erase later edits");
    checks.push("pending acknowledgement preserves new edits");

    const before = requests.length;
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    assert(requests.length === before, "Shift+Enter and IME composition must not submit");
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await settle(true);
    assert(input().value === "Next note written while waiting" && toasts.length === 1, "refused note retains text and reports failure");
    assert(!useAppStore.getState().messages.some((row) => row.content === "Next note written while waiting"), "refused optimistic row is retracted");
    click(send());
    await settle();
    assert(input().value === "", "successful submission clears its own unchanged draft");
    checks.push("keyboard, refusal and successful retry");

    write("Pending old-session note");
    click(send());
    flushSync(() => useAppStore.setState({ activeSessionId: "side-b", messages: [] }));
    assert(input().value === "", "switching sessions remounts the draft");
    write("New session draft");
    await settle();
    assert(input().value === "New session draft", "old-session acknowledgement cannot clear a new session draft");
    flushSync(() => useAppStore.setState({ runningSessions: { "side-a": true, "side-b": false } }));
    assert(input().disabled && send().disabled && preset().disabled, "idle session cannot send a note");
    checks.push("session isolation and idle admission");
    assert(uncaught.length === 0, `Uncaught renderer error: ${String(uncaught[0])}`);
    return { ok: true, checks };
  } finally {
    api.steer = originalSteer;
    api.getSessionDelegations = originalRoster;
    if (!keepMounted) {
      flushSync(() => root.unmount());
      useAppStore.setState(previous, true);
      host.remove();
    }
  }
};
