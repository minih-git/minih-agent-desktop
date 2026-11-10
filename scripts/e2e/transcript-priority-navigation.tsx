import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import type { UiMessage } from "@minih-agent/shared";
import { useTranscriptScroll } from "../../apps/desktop/src/features/chat/transcript/hooks/useTranscriptScroll";
import { transcriptEntryMessages } from "../../apps/desktop/src/lib/assistant-turns";
import { captureTranscriptReadingPosition, forgetTranscriptReadingState } from "../../apps/desktop/src/lib/transcript-reading-position";
import { SessionPane } from "../../apps/desktop/src/components/SessionPane";
import { ReviewTab } from "../../apps/desktop/src/components/workpanel/ReviewTab";
import { requestReviewFocus } from "../../apps/desktop/src/lib/review-focus-request";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  for (let n = 0; n < 600; n++) { if (predicate()) return; await frame(); }
  throw new Error(message);
}
const message = (id: string): UiMessage => ({ id, role: "user", content: `Readable history ${id}\n${"A stable message with visible text. ".repeat(10)}`,
  status: "complete", createdAt: "2026-11-05T00:00:00Z" });

let control: ReturnType<typeof useTranscriptScroll>;
function Paging({ id, rows, load }: { id: string; rows: UiMessage[]; load: () => Promise<void> }) {
  control = useTranscriptScroll({ sessionId: id, messages: rows, hasMoreBefore: true, onLoadOlder: load,
    isRunning: false, askPending: false, approvalPending: false, paneVisible: true,
    searchTarget: null, readingWindow: false, canonicalTailMessageId: rows.at(-1)?.id });
  const visible = transcriptEntryMessages(control.tailEntry ? [...control.historyEntries, control.tailEntry] : control.historyEntries);
  return <div ref={control.wrapRef} style={{ height: 460 }}>
    <div data-priority-scroller ref={control.scrollRef} onScroll={control.handleScroll}
      data-scroll-owner="transcript" style={{ height: "100%", overflowY: "auto", overflowAnchor: "none" }}>
      <div ref={control.contentRef}>
        {visible.map(row => <div key={row.id} data-message-id={row.id} style={{ height: 120, padding: 12, boxSizing: "border-box" }}>{row.content}</div>)}
      </div>
    </div>
  </div>;
}

declare global { var transcriptPriorityNavigationProbe: () => Promise<{ ok: true; checks: string[] }>; }
globalThis.transcriptPriorityNavigationProbe = async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  document.body.replaceChildren();
  document.documentElement.dataset.theme = "light";
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:24px;overflow:hidden;";
  document.body.append(host);
  const root = createRoot(host);
  const checks: string[] = [];
  let rows: UiMessage[] = [];
  let generation = 0;
  let calls = 0;
  let release: (() => void) | undefined;
  const load = () => { calls++; return new Promise<void>(resolve => { release = resolve; }); };
  const renderPaging = () => flushSync(() => root.render(<Paging key={generation} id={`priority-${generation}`} rows={rows} load={load} />));
  const scroller = () => host.querySelector<HTMLDivElement>("[data-priority-scroller]")!;
  const snapshot = () => captureTranscriptReadingPosition(scroller(), control.contentRef.current!, false, 60, rows.at(-1)?.id)!;
  const offset = (id: string) => scroller().querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)!.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  const move = (top: number) => {
    scroller().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }));
    flushSync(() => { scroller().scrollTop = top; scroller().dispatchEvent(new Event("scroll", { bubbles: true })); });
  };
  const reset = async () => {
    generation++; calls = 0; release = undefined;
    rows = Array.from({ length: 40 }, (_, n) => message(`row-${n}`));
    renderPaging();
    await until(() => scroller().querySelectorAll("[data-message-id]").length === 40 &&
      Math.abs(scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop) < 2, "paging fixture did not settle at latest");
  };
  const finishPage = async (lateLayout = false) => {
    check(release, "history did not issue a request");
    const done = release;
    rows = [...Array.from({ length: 20 }, (_, n) => message(`older-${n}`)), ...rows];
    renderPaging();
    if (lateLayout) {
      await frame();
      scroller().querySelector<HTMLElement>('[data-message-id="older-0"]')!.style.height = "420px";
      await frame();
    }
    done();
    await until(() => scroller().style.overflowY !== "hidden" && !control.loadingOlder, "page left scrolling locked");
    await frame();
  };
  try {
    await reset();
    move(40);
    check(calls === 1 && scroller().style.overflowY !== "hidden", "hard edge must start one nonblocking page");
    const held = snapshot();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 });
    scroller().dispatchEvent(wheel);
    check(!wheel.defaultPrevented, "hard-edge input was blocked");
    scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
    check(calls === 1, "two events duplicated a pending read");
    await finishPage(true);
    check(Math.abs(offset(held.messageId!) - held.offset) <= 2, "prepend/lazy layout moved the reading row");
    const heightBefore = scroller().scrollHeight;
    scroller().querySelector<HTMLElement>('[data-message-id="older-0"]')!.style.height = "540px";
    const below = scroller().querySelector<HTMLElement>('[data-message-id="row-39"]')!;
    below.style.height = "0px";
    below.style.padding = "0px";
    below.style.overflow = "hidden";
    await frame(); await frame();
    check(Math.abs(scroller().scrollHeight - heightBefore) <= 2, "opposing resize fixture changed total height");
    check(Math.abs(offset(held.messageId!) - held.offset) <= 2, "settled reading anchor lost opposing row resizes");
    checks.push("nonblocking hard-edge single flight and persistent pre-paint anchors after opposing resizes");

    await reset(); move(1200);
    check(calls === 1 && scroller().style.overflowY !== "hidden", "ahead load blocked input or did not start");
    move(1000);
    check(calls === 1, "ahead scroll duplicated IO");
    const ahead = snapshot();
    await finishPage(true);
    check(Math.abs(offset(ahead.messageId!) - ahead.offset) <= 2, "ahead prepend lost the new reading point");
    checks.push("ahead loading permits reader movement and preserves its newest position");

    await reset(); move(40);
    flushSync(() => control.jumpToLatest());
    await finishPage();
    await until(() => Math.abs(scroller().scrollHeight - scroller().clientHeight - scroller().scrollTop) <= 2,
      "late history stole latest navigation");
    checks.push("latest cancels old paging ownership");

    await reset(); move(40);
    check(release, "empty page request did not start");
    await until(() => control.loadingOlder, "empty page pending state was not rendered");
    release();
    await until(() => !control.loadingOlder && scroller().style.overflowY !== "hidden", "empty page kept input locked");
    scroller().dispatchEvent(new Event("scroll", { bubbles: true }));
    await frame(); await frame();
    check(calls === 1, "empty page automatically retried at an unchanged boundary");
    move(30);
    check(Number(calls) === 2, `new reader input did not permit an empty-page retry: calls=${calls},loading=${control.loadingOlder},top=${scroller().scrollTop}`);
    release();
    await until(() => !control.loadingOlder, "retry did not settle");
    checks.push("empty pages stop automatic retries and new input permits retry");

    const sessionId = "priority-real-session";
    const live = [message("live-tail")];
    const history = Array.from({ length: 35 }, (_, n) => message(`history-${n}`));
    const historical = () => ({ messages: history, messageStart: 20, messageEnd: 55,
      hasMoreBefore: false, hasMoreAfter: true, loading: null, focus: {
        sessionId, messageId: "history-12", query: "", requestId: 9000 + generation,
      } });
    let visible = true;
    const renderChat = () => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", minHeight: 0 }}><SessionPane sessionId={sessionId} visible={visible} /></div>
    </I18nextProvider>));
    const setHistory = () => {
      forgetTranscriptReadingState(sessionId);
      generation++;
      flushSync(() => useAppStore.setState({ activeSessionId: sessionId, messages: live,
        sessions: [{ id: sessionId, title: "Synthetic priority check", mode: "agent", updatedAt: "2026-11-05T00:00:00Z" }],
        retainedSessionIds: [sessionId], retainedTranscripts: { [sessionId]: live },
        sessionHistory: { [sessionId]: { hasMoreBefore: false } }, runningSessions: {},
        transcriptViews: { [sessionId]: historical() },
      }));
    };
    const chatScroll = () => host.querySelector<HTMLDivElement>(".thread-scroll")!;
    const latestButton = () => host.querySelector<HTMLButtonElement>(".jump-latest-btn")!;
    setHistory(); renderChat();
    await until(() => Boolean(latestButton()) && chatScroll().scrollHeight > chatScroll().clientHeight + 500, "real transcript did not render history");
    flushSync(() => latestButton().click());
    check(useAppStore.getState().transcriptViews[sessionId], "latest swapped history before its animation");
    await frame();
    chatScroll().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
    chatScroll().scrollTop = 700;
    chatScroll().dispatchEvent(new Event("scroll", { bubbles: true }));
    for (let n = 0; n < 40; n++) await frame();
    check(useAppStore.getState().transcriptViews[sessionId], "reader interruption committed latest");
    check(Math.abs(chatScroll().scrollTop - 700) <= 2, "old search/animation reclaimed reader position");
    flushSync(() => latestButton().click());
    await until(() => !useAppStore.getState().transcriptViews[sessionId], "latest did not commit live view");
    await until(() => chatScroll().scrollHeight - chatScroll().clientHeight - chatScroll().scrollTop <= 2, "live tail was not reached");
    checks.push("real SessionPane latest is interruptible, suspends search and commits live only at arrival");
    setHistory(); renderChat();
    await until(() => Boolean(latestButton()), "history did not reopen");
    flushSync(() => latestButton().click());
    visible = false; renderChat();
    await until(() => !useAppStore.getState().transcriptViews[sessionId], "hidden pane lost accepted latest intent");
    visible = true; renderChat();
    await frame();
    checks.push("pane hide commits latest intent without invisible animation");

    const edits: UiMessage[] = Array.from({ length: 28 }, (_, n) => ({ id: `edit-${n}`, role: "tool", content: "", status: "complete",
      createdAt: "2026-11-05T00:00:00Z", toolName: "Edit", toolStatus: "success", toolArgs: { path: `file-${n}.ts` },
      toolResult: { details: { root: "workspace", review: { version: 1, snapshotId: `snapshot-${n}`, messageId: `edit-${n}`,
        path: `file-${n}.ts`, operation: "edit", status: "modified", state: "active", additions: 1, deletions: 1, hunks: [], reversible: true } } },
    }));
    flushSync(() => useAppStore.setState({ activeSessionId: sessionId, messages: edits, transcriptViews: {} }));
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      <div data-review-ancestor style={{ height: 460, overflow: "auto" }}>
        <div style={{ height: 80 }}>Window chrome fixture</div>
        <div style={{ height: 460, display: "flex", flexDirection: "column", minHeight: 0 }}><ReviewTab /></div>
        <div style={{ height: 500 }} />
      </div>
    </I18nextProvider>));
    await frame();
    const ancestor = host.querySelector<HTMLDivElement>("[data-review-ancestor]")!;
    const review = host.querySelector<HTMLDivElement>(".review-scroll")!;
    ancestor.scrollTop = 25;
    flushSync(() => requestReviewFocus(["snapshot-24"], { sessionId, messages: edits, expand: true }));
    await until(() => review.scrollTop > 100, "review did not navigate to the selected file");
    check(ancestor.scrollTop === 25, "review navigation moved its ancestor/window chrome");
    check((document.activeElement as HTMLElement | null)?.classList.contains("review-change-card-header"), "review lost keyboard focus");
    checks.push("Review file focus scrolls only its list and retains keyboard focus");
    console.log("PRIORITY_NAVIGATION_SCREENSHOT");
    await frame();
    return { ok: true, checks };
  } finally {
    root.unmount(); host.remove();
    for (let n = 1; n <= generation; n++) forgetTranscriptReadingState(`priority-${n}`);
    forgetTranscriptReadingState("priority-real-session");
  }
};
