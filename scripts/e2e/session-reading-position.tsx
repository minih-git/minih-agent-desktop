import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared/protocol";
import type { Result, SessionSummary, UiMessage } from "@minih-agent/shared";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { getTranscriptReadingPosition } from "../../apps/desktop/src/lib/transcript-reading-position";

const createdAt = "2026-09-01T00:00:00Z";
const messages: UiMessage[] = Array.from({ length: 140 }, (_, index) => ({
  id: `real-m${index}`, role: "user", content: `Message ${index}. ${"Synthetic reading content. ".repeat(30)}`,
  createdAt, status: "complete",
}));
messages.push({
  id: "real-m140",
  role: "tool",
  content: "",
  createdAt,
  status: "success",
  toolName: "Read",
  toolCallId: "call-m140",
  toolStatus: "success",
  toolArgs: { path: "src/example.ts" },
  toolResult: "Synthetic tool output.",
});
const sessions: SessionSummary[] = ["A", "B", "C", "D", "E"].map((id) => ({
  id: `real-${id}`, title: id, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  providerId: "fixture", modelId: "fixture", createdAt, updatedAt: createdAt, messageCount: messages.length,
}));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 240; i++) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(`Timed out: ${label}`);
}
function Panes() {
  const active = useAppStore((state) => state.activeSessionId);
  const retained = useAppStore((state) => state.retainedSessionIds);
  return <div className="session-panes">{retained.map((id) =>
    <SessionPane key={id} sessionId={id} visible={id === active} />)}</div>;
}

declare global { var sessionReadingPositionProbe: () => Promise<unknown>; }
globalThis.sessionReadingPositionProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const initial = useAppStore.getState();
  const bridge = window.minihAgent;
  let firstARead = true;
  const aroundReads: string[] = [];
  const forwardReads: number[] = [];
  const unexpected: string[] = [];
  window.minihAgent = {
    channels: IPC, platform: "win32", on: () => () => {},
    invoke: async <T,>(channel: string, ...args: unknown[]): Promise<Result<T>> => {
      let data: unknown;
      if (channel === IPC.invoke.sessionGet) {
        const input = args[0];
        assert(input && typeof input === "object" && "id" in input, "invalid history request");
        const session = sessions.find((candidate) => candidate.id === input.id);
        assert(session, "unexpected session");
        const around = "messageAround" in input ? String(input.messageAround) : undefined;
        let start = 110;
        let end = messages.length;
        if (around) {
          aroundReads.push(around);
          const index = messages.findIndex((row) => row.id === around);
          assert(index >= 0, "missing anchor");
          start = Math.max(0, index - 20);
          end = Math.min(messages.length, index + 40);
        } else if ("messageBefore" in input && typeof input.messageBefore === "number") {
          const limit = "messageLimit" in input ? Number(input.messageLimit) : 100;
          end = Math.min(input.messageBefore, messages.length);
          start = Math.max(0, end - limit);
          forwardReads.push(start);
        } else if (input.id === "real-A" && firstARead) {
          firstARead = false;
          start = 0;
        }
        data = { session: { ...session, messages: messages.slice(start, end), messageStart: start,
          messageEnd: end, hasMoreBefore: start > 0, hasMoreAfter: end < messages.length } };
      } else if (channel === IPC.invoke.sessionList) data = { sessions };
      else if (channel === IPC.invoke.plansPending) data = { plans: [], state: "inactive" };
      else if (channel === IPC.invoke.pendingInteractive) data = { permissions: [], asks: [] };
      else if (channel === IPC.invoke.agentQueueList) data = { entries: [] };
      else if (channel === IPC.invoke.notificationMarkRead || channel === IPC.invoke.notificationSetViewingSession) data = { ok: true };
      else {
        unexpected.push(channel);
        return { ok: false, error: { code: "FIXTURE_UNEXPECTED", message: `Unexpected IPC ${channel}` } };
      }
      // The only mock is the generic, typed IPC boundary; all renderer wiring is real.
      return { ok: true, data: data as T };
    },
  };
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  document.body.append(host);
  const root = createRoot(host);
  const select = async (id: string) => {
    await useAppStore.getState().selectSession(`real-${id}`);
    await frame();
  };
  const scroller = () => host.querySelector<HTMLDivElement>('[data-visible="true"] .thread-scroll')!;
  const row = (id: string) => scroller().querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const offset = (id: string) => row(id)!.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  try {
    useAppStore.setState({
      sessions, messages: [], activeSessionId: undefined, selectingSessionId: undefined,
      retainedSessionIds: [], retainedTranscripts: {}, transcriptViews: {}, sessionHistory: {},
      sessionCompactions: {}, providers: [], providerModels: {}, pendingPlans: {}, pendingAsks: {},
      pendingPermissions: {}, planningStates: {}, runningSessions: {}, isRunning: false,
      workspace: undefined, queuedPrompts: {}, notifications: [], page: "chat",
      settings: { ...initial.settings, smoothStreaming: false },
    });
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><Panes /></I18nextProvider>));
    await select("A");
    await until(() => !host.querySelector('[data-transcript-settling="true"]'), "cold transcript settles");
    const a = scroller();
    a.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -800 }));
    a.scrollTop = 650;
    a.dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    const anchor = [...a.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) =>
      node.getBoundingClientRect().bottom > a.getBoundingClientRect().top)!;
    const id = anchor.dataset.messageId!;
    const expectedOffset = offset(id);
    await select("B");
    await select("A");
    await until(() => Boolean(row(id)) && Math.abs(offset(id) - expectedOffset) < 2,
      "warm production pane preserves reading through revalidation");
    assert(!host.querySelector('[data-visible="true"] .transcript-load-later'),
      "warm return must not offer to load later messages");
    for (const id of ["B", "C", "D", "E"]) await select(id);
    assert(!host.querySelector('[data-session-pane="real-A"]'), "A was not evicted");
    await select("A");
    await until(() => Boolean(row(id)) && Math.abs(offset(id) - expectedOffset) < 2,
      "evicted production pane restores historical anchor");
    assert(aroundReads.includes(id), "history restoration did not read around the bookmarked message");
    assert(!host.querySelector(".transcript-search-target"), "restore must not create search highlighting");
    assert(host.querySelectorAll("[data-session-pane]").length === 3, "pane count changed");
    assert(useAppStore.getState().messages[0]?.id === "real-m110", "restore changed canonical/live input");
    const restoredOffset = offset(id);
    assert(!scroller().querySelector(".transcript-load-later"), "restoration must not expose manual paging");
    const readsBefore = forwardReads.length;
    const continuation = useAppStore.getState().transcriptViews["real-A"];
    assert(continuation?.hasMoreAfter, "restore must leave a real gap");
    const boundaryId = `real-m${continuation.messageEnd! - 1}`;
    const boundary = row(boundaryId)!;
    scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1000 }));
    scroller().scrollTop = scroller().scrollHeight - scroller().clientHeight;
    const boundaryOffset = boundary.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
    scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
    await until(() => useAppStore.getState().transcriptViews["real-A"]?.hasMoreAfter === false && Boolean(row("real-m139")),
      "scrolling continues restored history without a button");
    assert(forwardReads.length > readsBefore, "continuation must read a physical page");
    const continuedOffset = offset(boundaryId);
    assert(Math.abs(continuedOffset - boundaryOffset) < 2,
      `continuation moved the viewport: ${continuedOffset} vs ${boundaryOffset}`);
    assert(useAppStore.getState().messages[0]?.id === "real-m110", "continuation changed model input");
    console.info("READING_CONTINUATION_SCREENSHOT");
    await frame();
    await useAppStore.getState().navigateTranscript({ sessionId: "real-A", messageId: id, query: "Message" });
    await until(() => Boolean(scroller().querySelector(".transcript-load-later")), "search keeps manual continuation");
    const searchReads = forwardReads.length;
    scroller().scrollTop = scroller().scrollHeight - scroller().clientHeight;
    scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame(); await frame();
    assert(forwardReads.length === searchReads, "search must not automatically continue");
    flushSync(() => scroller().querySelector<HTMLButtonElement>(".transcript-load-later")!.click());
    await until(() => useAppStore.getState().transcriptViews["real-A"]?.hasMoreAfter === false,
      "search still loads subsequent pages manually");
    const jump = host.querySelector<HTMLButtonElement>('[data-visible="true"] .jump-latest-btn')!;
    flushSync(() => jump.click());
    await until(() => !useAppStore.getState().transcriptViews["real-A"] &&
      Math.abs(scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop) < 2,
    "return to latest exits history and resumes follow");
    assert(unexpected.length === 0, `unexpected IPC: ${unexpected}`);

    // A session the reader left at the bottom of the tail, after a manual
    // disclosure handed the scroller to its anchor and released follow mode,
    // must come back at the bottom - not restored into a history page.
    const atBottom = () => {
      const scrollerNow = scroller();
      return scrollerNow.scrollHeight - scrollerNow.clientHeight - scrollerNow.scrollTop < 2;
    };
    await until(atBottom, "A resumes the tail before the disclosure");
    let stableBottomFrames = 0;
    let previousHeight = -1;
    await until(() => {
      const height = scroller().scrollHeight;
      stableBottomFrames = atBottom() && height === previousHeight ? stableBottomFrames + 1 : 0;
      previousHeight = height;
      return stableBottomFrames >= 3;
    }, "the latest projection and mounted window settle before disclosure");
    const toolHeader = row("real-m140")?.querySelector<HTMLElement>(".tool-row-header");
    assert(toolHeader, "the expandable tool row did not render");
    flushSync(() => toolHeader.click());
    await frame();
    // The disclosure released follow mode; a scroll event at the bottom with no
    // gesture is what samples the bookmark again.
    scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame();
    assert(
      getTranscriptReadingPosition("real-A")?.pinned === true,
      `a disclosure at the bottom must not demote the reading bookmark: ${JSON.stringify({ position: getTranscriptReadingPosition("real-A"), gap: scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop })}`,
    );
    for (const id of ["B", "C", "D", "E"]) await select(id);
    assert(!host.querySelector('[data-session-pane="real-A"]'), "A was not evicted");
    await select("A");
    await until(atBottom, "a session left at the bottom returns to the tail");
    assert(
      !useAppStore.getState().transcriptViews["real-A"],
      "a bottom bookmark must not reopen a history page",
    );
    assert(unexpected.length === 0, `unexpected IPC: ${unexpected}`);
    return { ok: true, anchor: id, restoredOffset, aroundReads, panes: 3 };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), unexpected, aroundReads };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    window.minihAgent = bridge;
    useAppStore.setState(initial);
  }
};
