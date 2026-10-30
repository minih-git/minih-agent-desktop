import { createInstance } from "i18next";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { RacpEventEnvelope } from "@minih-agent/shared";

import { SessionScreen } from "../../apps/remote-web/src/screens/SessionScreen.js";
import { buildResources } from "../../apps/remote-web/src/locales/index.js";

/** Production screen/hook/reducer/transport; only the external fetch edge is synthetic. */
async function mountSession(locale: string) {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: buildResources(), keySeparator: false, nsSeparator: false });
  document.documentElement.lang = locale;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const checks: string[] = [];
  let sequence = 0;
  let serial = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let releaseStop: (() => void) | undefined;
  let removeAbortListener = () => {};
  const session = {
    id: "live-session", title: "Live reasoning regression", status: "running", mode: "agent",
    planningState: "inactive", permissionMode: "ask", queuedTurnIds: [], revision: 0,
    createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z",
  };
  const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "Content-Type": "application/json" } });
  const drop = () => { const current = stream; stream = undefined; current?.close(); removeAbortListener(); };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(":attach")) return json({ session, replayComplete: true, snapshot: {
      session, activeTurn: { id: "live-turn", sessionId: session.id, status: "running" },
      queuedTurns: [], pendingApprovals: [], pendingInputs: [], activeItems: [], hasMoreHistory: false,
      cursor: { epoch: "fixture", sequence: 0 }, revision: 0, generatedAt: session.updatedAt,
      items: [{ id: "prior-tool", turnId: "live-turn", itemType: "message", status: "completed", createdAt: session.createdAt,
        content: { id: "prior-tool", role: "tool", content: "", createdAt: session.createdAt, toolName: "Read",
          toolArgs: { path: "config.json" }, toolResult: "Fixture config", toolStatus: "success" } }],
    } });
    if (url.endsWith("/models")) return json({ models: [] });
    if (url.endsWith("/events")) {
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
      const signal = init?.signal;
      signal?.addEventListener("abort", drop, { once: true });
      removeAbortListener = () => signal?.removeEventListener("abort", drop);
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith(":stop")) return new Promise<Response>((resolve) => { releaseStop = () => resolve(json({ accepted: true })); });
    if (url.endsWith("/sessions")) return new Response("{}", { status: 503 });
    throw new Error(`Unexpected fixture fetch: ${url}`);
  };
  const check = (condition: unknown, label: string) => {
    if (!condition) throw new Error(`${locale}/${innerWidth}: ${label}`);
    checks.push(label);
  };
  const wait = async (condition: () => unknown, label: string) => {
    const deadline = performance.now() + 5000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error(`${locale}/${innerWidth}: timeout: ${label}`);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    checks.push(label);
  };
  const emit = (kind: RacpEventEnvelope["kind"], payload: unknown, ephemeral = false) => {
    check(stream, `stream ready for ${kind}`);
    const envelope = {
      eventId: `fixture-${++serial}`, scope: "session", sessionId: session.id, turnId: "live-turn",
      epoch: "fixture", revision: sequence, occurredAt: session.updatedAt, kind, payload,
      ...(ephemeral ? { afterSequence: sequence } : { sequence: ++sequence }),
    };
    stream!.enqueue(encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(envelope)}\n\n`));
  };
  const response = () => host.querySelector("main [role='status']");
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-item-id='${id}']`);
  const disclosure = (id: string) => row(id)?.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const click = (element: HTMLElement | null | undefined) => {
    check(element, "click target exists");
    flushSync(() => element!.click());
  };
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label);
  const thoughtMessage = (id: string, thinking = "") => ({ id, role: "assistant", content: "", thinking, createdAt: session.createdAt });
  const delta = (id: string, deltaThinking: string) => emit("item.delta", {
    itemType: "message", itemId: id, event: { type: "message_update", stream: "delta", message: thoughtMessage(id), deltaThinking },
  }, true);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><SessionScreen
    hostId="fixture-host" sessionId={session.id} gatewayOrigin="https://fixture.invalid"
    credential={{ kind: "cookie", csrfToken: "synthetic-fixture" }} hostLabel="Fixture computer" onBack={() => {}}
  /></I18nextProvider>));
  return {
    host, i18n, checks, check, wait, emit, delta, response, row, disclosure, click, button, thoughtMessage, drop,
    releaseStop: () => releaseStop?.(),
    close() { flushSync(() => root.unmount()); drop(); globalThis.fetch = originalFetch; host.remove(); },
  };
}

type Fixture = Awaited<ReturnType<typeof mountSession>>;
let fixture: Fixture | undefined;

export async function activeProbe(locale: string) {
  fixture = await mountSession(locale);
  const f = fixture;
  await f.wait(() => f.response(), "response indicator exists before assistant content");
  f.check(f.response()?.textContent === f.i18n.t("timeline.responding"), "response text is localized");
  f.check(f.host.querySelector("details")?.open === false, "completed tool starts folded");
  f.delta("live-thought", "Checking the current dependency.");
  await f.wait(() => f.disclosure("live-thought")?.getAttribute("aria-expanded") === "true", "live thought opens automatically");
  f.check(!f.row("live-thought")?.closest("details"), "live thought is outside the folded tool card");
  f.check(f.row("live-thought")?.innerText.includes("Checking the current dependency."), "live thought is actually visible");
  f.click(f.disclosure("live-thought"));
  f.check(f.disclosure("live-thought")?.getAttribute("aria-expanded") === "false", "reader can collapse live thinking");
  f.delta("live-thought", " More detail from the next delta.");
  await f.wait(() => !f.row("live-thought")?.innerText.includes("More detail"), "collapsed reasoning stays out of the visible page");
  // Wait for the following durable item to prove the preceding ephemeral delta was applied.
  f.emit("item.completed", { itemType: "message", itemId: "live-thought", event: { type: "message_end",
    message: f.thoughtMessage("live-thought", "Checking the current dependency. More detail from the next delta.") } });
  f.click(f.disclosure("live-thought"));
  await f.wait(() => f.row("live-thought")?.innerText.includes("More detail"), "reader can reopen the latest thinking");
  f.emit("item.started", { itemType: "tool", itemId: "next-tool",
    event: { type: "tool_start", toolCallId: "next-tool", toolName: "Read", args: { path: "dependency.json" } } });
  await f.wait(() => f.row("next-tool"), "following tool appears");
  f.check(f.row("live-thought")?.innerText.includes("More detail"), "latest reasoning stays visible during tool execution");
  f.check(!f.row("live-thought")?.closest("details"), "following tool does not absorb latest reasoning");
  f.emit("item.completed", { itemType: "tool", itemId: "next-tool",
    event: { type: "tool_end", toolCallId: "next-tool", result: "Dependency fixture" } });
  f.delta("latest-thought", "Now checking the next step.");
  await f.wait(() => f.disclosure("latest-thought")?.getAttribute("aria-expanded") === "true", "next thought opens outside the historical run");
  f.click(f.disclosure("latest-thought"));
  f.delta("latest-thought", " Update while manually folded.");
  f.emit("item.started", { itemType: "tool", itemId: "delta-fence-tool",
    event: { type: "tool_start", toolCallId: "delta-fence-tool", toolName: "Read", args: { path: "fixture.json" } } });
  await f.wait(() => f.row("delta-fence-tool"), "subsequent event proves delta processing completed");
  f.check(f.disclosure("latest-thought")?.getAttribute("aria-expanded") === "false", "manual collapse survives streaming updates");
  f.click(f.disclosure("latest-thought"));
  f.check(f.row("latest-thought")?.innerText.includes("Update while manually folded."), "folded thinking retains the next streamed delta");
  f.delta("delta-fence", "Event delivery fence");
  await f.wait(() => f.disclosure("delta-fence")?.getAttribute("aria-expanded") === "true", "newest reasoning remains visible");
  f.check(document.documentElement.scrollWidth <= innerWidth, "narrow screen has no horizontal overflow");
  return { checks: f.checks.length };
}

export async function stateProbe() {
  if (!fixture) throw new Error("activeProbe must run first");
  const f = fixture;
  try {
    f.emit("approval.requested", { id: "approval-1", sessionId: "live-session", turnId: "live-turn", kind: "tool",
      summary: "Allow the fixture read", expiresAt: "", revision: 1, allowedDecisions: ["allow-once", "deny"] });
    await f.wait(() => !f.response(), "awaiting approval hides the response indicator");
    f.emit("approval.resolved", { approvalId: "approval-1" });
    await f.wait(() => f.response(), "response resumes after approval");
    f.emit("input.requested", { id: "input-1", sessionId: "live-session", turnId: "live-turn", expiresAt: "",
      questions: [{ id: "question-1", question: "Which fixture?", options: ["A", "B"], multiSelect: false }] });
    await f.wait(() => !f.response(), "awaiting input hides the response indicator");
    f.emit("input.resolved", { inputId: "input-1" });
    await f.wait(() => f.response(), "response resumes after input");
    f.click(f.button(f.i18n.t("session.stop")));
    const stopTitle = f.i18n.t("session.stopSheet.afterStepTitle");
    const stopButton = [...f.host.ownerDocument.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.includes(stopTitle));
    f.click(stopButton);
    await f.wait(() => !f.response(), "stopping hides the response indicator");
    f.releaseStop();
    f.emit("turn.completed", {});
    await f.wait(() => !f.host.querySelector("main button[aria-expanded='true']"), "completed thoughts return to historical folding");
    f.check(!f.response(), "completed turn has no response indicator");
    const historical = f.row("delta-fence");
    const group = historical?.closest("details");
    f.click(group?.querySelector("summary"));
    f.click(historical?.querySelector("summary"));
    f.check(historical?.innerText.includes("Event delivery fence"), "historical thinking remains readable on demand");
    return { checks: f.checks.length };
  } finally { f.close(); fixture = undefined; }
}

export async function terminalProbe(locale: string) {
  let checks = 0;
  for (const kind of ["turn.completed", "turn.interrupted", "turn.canceled", "turn.failed"] as const) {
    const f = await mountSession(locale);
    try {
      await f.wait(() => f.response(), `${kind}: active response appears`);
      f.emit(kind, kind === "turn.failed" ? { event: { type: "error", error: { code: "FIXTURE_ERROR", message: "Synthetic fixture failure" } } } : {});
      await f.wait(() => !f.response(), `${kind}: terminal response disappears`);
      checks += f.checks.length;
    } finally { f.close(); }
  }
  const f = await mountSession(locale);
  try {
    await f.wait(() => f.response(), "active response before disconnect");
    f.drop();
    await f.wait(() => !f.response(), "disconnect hides the response indicator");
    checks += f.checks.length;
  } finally { f.close(); }
  return { checks };
}

Object.assign(globalThis, { activeProbe, stateProbe, terminalProbe });
