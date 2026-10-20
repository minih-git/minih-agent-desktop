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
  const originalAsk = api.askSideNote;
  const originalSteer = api.steer;
  const originalList = api.listSideNotes;
  const history: Record<string, import("@minih-agent/shared").SideNote[]> = {};
  const originalRoster = api.getSessionDelegations;
  const requests: Parameters<typeof api.askSideNote>[0][] = [];
  const checks: string[] = [];
  let acknowledge: (() => void) | undefined;
  let refuse: ((error: Error) => void) | undefined;
  const toasts: string[] = [];
  api.steer = async () => { throw new Error("Side notes must not steer the main task"); };
  api.listSideNotes = async sessionId => ({ notes: [...(history[sessionId] ?? [])] });
  api.askSideNote = (request) => {
    requests.push(request);
    return new Promise((resolve, reject) => {
      acknowledge = () => {
        const note = { id: `answer-${requests.length}`, question: request.content, answer: `Independent answer to: ${request.content}`, createdAt: new Date().toISOString() };
        history[request.sessionId] = [...(history[request.sessionId] ?? []), note];
        resolve({ note });
      };
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
      sessionHistory: {}, transcriptViews: {}, sideNotes: {}, sideNotePending: {},
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
    assert(requests[0]?.expectedTurnId === "turn-a" && requests[0]?.content === i18n.t("panel.sideNotes.presetProgress"), "preset uses independent ask");
    // This assertion is deliberately after acknowledgement: old code cleared
    // an unrelated draft even though the preset never submitted that text.
    acknowledge?.();
    await frame();
    await frame();
    assert(input().value === "Keep my unsent draft", "preset acknowledgement must preserve an unrelated draft");
    assert(host.querySelector(".side-note-answer")?.textContent?.includes("Independent answer"), "answer appears in side panel");
    assert(useAppStore.getState().messages.length === 0, "side question/answer never enters main transcript");
    checks.push("independent question and answer stay in the side panel; preset preserves draft");

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
    flushSync(() => useAppStore.setState({ activeSessionId: "side-a", messages: [] }));
    await until(() => Boolean(host.querySelector(".side-note-answer")), "durable side answers after returning to original session");
    assert(useAppStore.getState().sideNotes["side-a"]?.some(note => note.question === "Pending old-session note"), "late answer remains in its original session");
    assert(useAppStore.getState().messages.length === 0, "all main transcript rows remain unchanged");
    checks.push("session isolation, history reload and idle admission");
    assert(uncaught.length === 0, `Uncaught renderer error: ${String(uncaught[0])}`);
    return { ok: true, checks };
  } finally {
    api.askSideNote = originalAsk;
    api.steer = originalSteer;
    api.listSideNotes = originalList;
    api.getSessionDelegations = originalRoster;
    if (!keepMounted) {
      flushSync(() => root.unmount());
      useAppStore.setState(previous, true);
      host.remove();
    }
  }
};
