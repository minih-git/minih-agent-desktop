import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { UiMessage } from "@minih-agent/shared";
import { useTranscriptContinuation } from "../../apps/desktop/src/hooks/use-transcript-continuation";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const page = (count: number): UiMessage[] => Array.from({ length: count }, (_, index) => ({
  id: `continuation-${index}`, role: "user", content: `Row ${index}`, createdAt: "2026-09-13T00:00:00Z",
}));
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
function Surface(props: {
  enabled: boolean; loading: boolean; messages: UiMessage[]; onLoadNewer: () => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useTranscriptContinuation({ ...props, cursor: props.messages.length, scrollRef, contentRef });
  return <div ref={scrollRef} style={{ height: 200, overflowY: "auto", overflowAnchor: "none" }}>
    <div ref={contentRef}>{props.messages.map((row) => <div key={row.id} style={{ height: 100 }}>{row.content}</div>)}</div>
  </div>;
}

declare global { var transcriptContinuationProbe: () => Promise<unknown>; }
globalThis.transcriptContinuationProbe = async () => {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.append(host);
  const root = createRoot(host);
  let calls = 0;
  let mounted = true;
  const onLoadNewer = async () => { calls++; };
  let props = { enabled: false, loading: false, messages: page(10), onLoadNewer };
  const render = (patch: Partial<typeof props> = {}) => {
    props = { ...props, ...patch };
    flushSync(() => root.render(<Surface {...props} />));
  };
  const scroll = () => host.firstElementChild as HTMLDivElement;
  const atBoundary = () => {
    scroll().scrollTop = scroll().scrollHeight - scroll().clientHeight;
    scroll().dispatchEvent(new Event("scroll"));
  };
  try {
    render(); atBoundary(); await frame();
    assert(calls === 0, "hidden/search panes must not continue");
    scroll().scrollTop = 0;
    render({ enabled: true }); await frame();
    assert(calls === 0, "a distant anchor must not drain later history");
    atBoundary();
    for (let i = 0; i < 4; i++) scroll().dispatchEvent(new Event("scroll"));
    assert(Number(calls) === 1, "boundary scroll/resize requests must coalesce");
    render({ loading: true }); render({ loading: false });
    await frame(); await frame();
    assert(Number(calls) === 1, "a failed page must not loop on loading or resize");
    scroll().dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }));
    scroll().scrollTop -= 10;
    scroll().dispatchEvent(new Event("scroll"));
    assert(Number(calls) === 2, "new reading input must allow a failed read retry");
    const top = scroll().scrollTop;
    render({ messages: page(20) }); await frame();
    assert(scroll().scrollTop === top, "appending rows must preserve the viewport");
    assert(Number(calls) === 2, "continuation stops away from the lower boundary");
    scroll().scrollTop = 0;
    render({ messages: page(1) }); await frame();
    assert(Number(calls) === 3, "a short range must fill the viewport");
    render({ messages: page(1) }); await frame();
    assert(Number(calls) === 3, "a non-advancing cursor must not loop");
    render({ enabled: false, messages: page(2) }); atBoundary(); await frame();
    assert(Number(calls) === 3, "hiding a pane stops continuation");
    const detached = scroll();
    flushSync(() => root.unmount()); mounted = false;
    detached.dispatchEvent(new Event("scroll")); await frame();
    assert(Number(calls) === 3, "unmount releases continuation listeners");
    return { ok: true, requests: calls };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), requests: calls };
  } finally {
    if (mounted) root.unmount();
    host.remove();
  }
};
