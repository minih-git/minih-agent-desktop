/**
 * E2E-266 Electron driver: the real H5 client bundle in Chromium.
 *
 * One `BrowserWindow` per mobile viewport with `enableDeviceEmulation` and a
 * mobile user agent. Everything else is real: the built `apps/remote-web`
 * bundle, the same-origin proxy, the Gateway, the enrolled `agent-host-cli`
 * Host, and the loopback model stub. This process drives the DOM and reads its
 * own evidence (cookie attributes, `localStorage`, the proxy log) so the run
 * proves what a phone would see.
 *
 * Configuration travels in the environment (never on a command line, which the
 * process list would expose): origin, host id, the per-viewport tickets, and
 * the screenshot directory. The single stdout line `REMOTE_WEB_PROBE {json}` is
 * the only thing the runner parses, and no ticket or token is ever printed.
 */
const { app, BrowserWindow, session } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ORIGIN = process.env.REMOTE_WEB_E2E_ORIGIN ?? "";
const HOST_ID = process.env.REMOTE_WEB_E2E_HOST_ID ?? "";
const ARTIFACT_DIR = process.env.REMOTE_WEB_E2E_ARTIFACT_DIR ?? "";
const VIEWPORTS = JSON.parse(process.env.REMOTE_WEB_E2E_VIEWPORTS ?? "[]");
const PROBE_LINE = "REMOTE_WEB_PROBE";

/** In-page helpers: every interaction is a real DOM query, click, or input event. */
const HELPERS = `(() => {
  const buttons = () => Array.from(document.querySelectorAll("button"));
  const textOf = (element) => (element.textContent || "").trim();
  const buttonWithText = (text) => buttons().find((candidate) => textOf(candidate) === text) || null;
  globalThis.__rw = {
    body: () => document.body.innerText,
    button: (text) => { const found = buttonWithText(text); return found ? { disabled: found.disabled } : null; },
    click: (text) => { const found = buttonWithText(text); if (!found) return false; found.click(); return true; },
    clickAria: (prefix) => { const found = buttons().find((candidate) => (candidate.getAttribute("aria-label") || "").startsWith(prefix)); if (!found) return false; found.click(); return true; },
    approvalCards: () => Array.from(document.querySelectorAll("section")).filter((card) => textOf(card).includes("Approval needed")).length,
    approvalButtons: () => buttons().filter((candidate) => (candidate.getAttribute("aria-label") || "").startsWith("Approval needed:")).map((candidate) => candidate.getAttribute("aria-label")),
    toolRows: () => Array.from(document.querySelectorAll("li")).filter((row) => textOf(row).startsWith("Tool")).length,
    turnLabel: () => Array.from(document.querySelectorAll("span")).map(textOf).find((label) => label.startsWith("Turn ")) || null,
    hasSession: (title) => document.querySelector('[aria-label="' + title + '"]') !== null,
    groupHeadings: () => Array.from(document.querySelectorAll("section[aria-label] > button[aria-expanded]")).map((button) => (button.textContent || "").trim().replace(/\\s+/g, " ")),
    groupOf: (title) => {
      const row = document.querySelector('[aria-label="' + title + '"]');
      const section = row ? row.closest("section[aria-label]") : null;
      return section ? section.getAttribute("aria-label") : null;
    },
    write: (selector, value) => {
      const field = document.querySelector(selector);
      if (!field) return false;
      const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    registry: () => { const raw = localStorage.getItem("minih.remote-web.hosts.v1"); return raw ? JSON.parse(raw) : null; },
    storage: () => JSON.stringify(Object.fromEntries(Object.entries(localStorage))),
    visibleCookies: () => document.cookie,
  };
  return true;
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(webContents, expression) {
  return webContents.executeJavaScript(`(() => { try { return ${expression}; } catch (error) { return "__rw_error:" + String(error); } })()`, true);
}

async function waitFor(webContents, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(webContents, expression);
    if (typeof value === "string" && value.startsWith("__rw_error:")) throw new Error(`${label}: the page threw ${value}`);
    if (value) return value;
    if (Date.now() > deadline) {
      const body = await evaluate(webContents, "__rw.body()");
      const labels = await evaluate(webContents, "JSON.stringify(Array.from(document.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label')))");
      throw new Error(`deadline exceeded while waiting for ${label}; labels=${String(labels).slice(0, 400)}; the page said: ${String(body).slice(0, 600)}`);
    }
    await sleep(150);
  }
}

async function clickText(webContents, text, label = text) {
  const clicked = await evaluate(webContents, `__rw.click(${JSON.stringify(text)})`);
  if (!clicked) throw new Error(`the page has no "${label}" control`);
}

async function clickAria(webContents, prefix, label = prefix) {
  const clicked = await evaluate(webContents, `__rw.clickAria(${JSON.stringify(prefix)})`);
  if (!clicked) throw new Error(`the page has no "${label}" control`);
}

async function proxyLog() {
  const response = await fetch(`${ORIGIN}/__control/log`);
  if (!response.ok) throw new Error(`the proxy log endpoint answered ${response.status}`);
  return (await response.json()).entries;
}

/** Drop only this session's proxied stream: another viewport's window may still be open. */
async function dropStreams(sessionId) {
  const response = await fetch(`${ORIGIN}/__control/drop-streams?match=${encodeURIComponent(sessionId)}`, { method: "POST" });
  if (!response.ok) throw new Error(`the proxy drop endpoint answered ${response.status}`);
  return (await response.json()).dropped;
}

/** Wait until the proxy logged a *resumed* stream: a GET whose Last-Event-ID is set. */
async function waitForResumedStream(sessionId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resumed = (await proxyLog()).filter(
      (entry) => entry.lastEventId !== null && entry.url.includes(sessionId) && entry.url.endsWith("/events"),
    );
    if (resumed.length > 0) return resumed;
    if (Date.now() > deadline) throw new Error(`no event stream was resumed with Last-Event-ID for ${sessionId}`);
    await sleep(200);
  }
}

/**
 * The same mutation twice with one idempotency key, sent the way the client
 * itself sends it: a same-origin POST with the device cookie plus the CSRF
 * header the registry holds. The Host must answer the second call with the
 * stored turn instead of starting a second one.
 */
function duplicateTurnScript(hostId, sessionId) {
  const host = JSON.stringify(hostId);
  const session = JSON.stringify(sessionId);
  return `(async () => {
    const registry = __rw.registry() || [];
    const entry = registry.find((candidate) => candidate.hostId === ${host});
    if (!entry) return { error: "the browser registry has no entry for this host" };
    const post = (requestId) =>
      fetch("/hosts/" + ${host} + "/v1/sessions/" + ${session} + "/turns", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": entry.csrfToken },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "e2e-" + requestId,
          method: "turn/start",
          params: { sessionId: ${session}, admission: "reject_if_busy", input: { text: "answer once" }, context: { requestId } },
          idempotencyKey: "idem-e2e-duplicate",
        }),
      }).then(async (response) => ({ status: response.status, payload: await response.json() }));
    const first = await post("req-e2e-first");
    const second = await post("req-e2e-second");
    return { first, second };
  })()`;
}

async function runViewport(view, openWindows) {
  const partition = `remote-web-${view.name}`;
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: view.width,
    height: view.height,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, partition },
  });
  const webContents = window.webContents;
  webContents.setUserAgent(view.userAgent);
  webContents.setBackgroundThrottling(false);
  // Electron 43 segfaults when device emulation is enabled before the first
  // navigation, so the emulated viewport is applied once the page has loaded.
  const emulateViewport = () =>
    webContents.enableDeviceEmulation({
      screenPosition: "mobile",
      screenSize: { width: view.width, height: view.height },
      viewSize: { width: view.width, height: view.height },
      deviceScaleFactor: view.scale,
      viewPosition: { x: 0, y: 0 },
      scale: 1,
    });
  const consoleErrors = [];
  webContents.on("console-message", (event, level, message) => {
    const severity = typeof event?.level === "string" ? event.level : level;
    const text = typeof event?.message === "string" ? event.message : message;
    if (severity === "error") consoleErrors.push(String(text));
  });
  const observed = { name: view.name, screenshots: [], consoleErrors };
  const capture = async (name) => {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const path = join(ARTIFACT_DIR, `${view.name}-${name}.png`);
    // A hidden window paints lazily: ask for a repaint and let it settle, so
    // every screenshot is the state the assertions just observed.
    webContents.invalidate();
    await sleep(150);
    writeFileSync(path, (await webContents.capturePage()).toPNG());
    observed.screenshots.push(path);
    return path;
  };
  const type = async (text) => {
    const wrote = await evaluate(webContents, `__rw.write('textarea[aria-label="Message the agent"]', ${JSON.stringify(text)})`);
    if (!wrote) throw new Error("the composer field is missing");
  };

  try {
    await window.loadURL(`${ORIGIN}/`);
    emulateViewport();
    await evaluate(webContents, `(() => { ${HELPERS}; return true; })()`);

    // 1. Pair through the UI with the ticket the Host printed.
    await waitFor(webContents, "__rw.button('Add host') !== null", "the host list");
    await clickText(webContents, "Add host");
    await waitFor(webContents, "document.querySelector('#pair-ticket') !== null", "the pairing form");
    await evaluate(webContents, `__rw.write('#pair-ticket', ${JSON.stringify(view.ticket)})`);
    await evaluate(webContents, `__rw.write('#pair-label', ${JSON.stringify(view.label)})`);
    await clickText(webContents, "Pair");
    await waitFor(webContents, `__rw.hasSession(${JSON.stringify(view.title)})`, "the session list after pairing");

    const deviceCookies = await session.fromPartition(partition).cookies.get({ name: "racp_device" });
    observed.deviceCookie = deviceCookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      session: cookie.session,
      expirationDate: cookie.expirationDate ?? null,
    }));
    observed.storage = JSON.parse(await evaluate(webContents, "__rw.storage()"));
    observed.visibleCookies = await evaluate(webContents, "__rw.visibleCookies()");
    observed.registry = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.registry())"));
    await capture("01-paired");

    // The list is grouped: this viewport's session sits under its project's
    // heading, and the session with no project under "Other".
    observed.groups = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.groupHeadings())"));
    observed.groupOfOwnSession = await evaluate(webContents, `__rw.groupOf(${JSON.stringify(view.title)})`);
    observed.groupOfLooseSession = await evaluate(webContents, `__rw.groupOf("Loose session")`);
    await capture("02-groups");

    // The phone can create a session: pick the project, and the composer of the
    // new session is what opens, ready for the first message.
    await clickText(webContents, "New session");
    await waitFor(webContents, "document.body.innerText.includes('Choose a project')", "the project picker");
    await capture("03-choose-project");
    await clickText(webContents, view.projectLabel);
    await waitFor(webContents, "document.querySelector('textarea[aria-label=\"Message the agent\"]') !== null", "the new session's composer");
    observed.createdSession = await evaluate(webContents, "__rw.turnLabel()");
    await capture("04-new-session");
    await clickAria(webContents, "Back", "Back (to the session list)");
    // The list reloads on arrival, so wait for the new session's own row (the
    // Host's default title) instead of reading the headings while it loads.
    await waitFor(webContents, "__rw.hasSession('New task')", "the created session in the list");
    observed.sessionsAfterCreate = await evaluate(webContents, "JSON.stringify(__rw.groupHeadings())");
    observed.groupOfCreatedSession = await evaluate(webContents, "__rw.groupOf('New task')");
    // 2. The host list, its sessions, then one session's timeline.
    await clickAria(webContents, "Back", "Back (to the host list)");
    await waitFor(webContents, "document.body.innerText.includes('Online')", "the host to probe as online");
    observed.hostList = await evaluate(webContents, "__rw.body()");
    await capture("05-hosts");
    await clickText(webContents, "Open");
    await waitFor(webContents, `__rw.hasSession(${JSON.stringify(view.title)})`, "the session list");
    observed.sessions = await evaluate(webContents, "__rw.body()");
    await evaluate(webContents, `document.querySelector('[aria-label=${JSON.stringify(view.title)}]').click()`);
    await waitFor(webContents, "document.body.innerText.includes('Live')", "the session event stream to go live");
    await capture("06-timeline");

    // 3. A turn that raises an approval, then a forced drop of its stream.
    await type("run the approval fixture");
    await clickText(webContents, "Send");
    await waitFor(webContents, "__rw.approvalCards() === 1", "the approval card");
    observed.approvalButtons = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.approvalButtons())"));
    observed.dropped = await dropStreams(view.sessionId);
    observed.resumed = await waitForResumedStream(view.sessionId);
    await waitFor(webContents, "__rw.approvalCards() === 1", "exactly one approval card after the reconnect");
    observed.approvalCardsAfterReconnect = await evaluate(webContents, "__rw.approvalCards()");
    await capture("07-approval-reconnect");

    // 4. Approve once; the tool must run once.
    await clickAria(webContents, "Approval needed: Allow once");
    await waitFor(webContents, "__rw.approvalCards() === 0 && __rw.toolRows() === 1", "the approved tool row");
    await waitFor(webContents, "document.body.innerText.includes('Turn completed')", "the approved turn to complete");
    await capture("08-approved");

    // 5. Start + stop, then start + interrupt.
    await type("hold the turn open for a stop");
    await clickText(webContents, "Send");
    await waitFor(webContents, "__rw.turnLabel() === 'Turn running'", "the running turn before Stop");
    await clickText(webContents, "Stop");
    await waitFor(webContents, "__rw.turnLabel() !== 'Turn running'", "the stopped turn");
    observed.afterStop = await evaluate(webContents, "__rw.turnLabel()");
    await type("hold the turn open for an interrupt");
    await clickText(webContents, "Send");
    await waitFor(webContents, "__rw.turnLabel() === 'Turn running'", "the running turn before Interrupt");
    await clickText(webContents, "Interrupt");
    await waitFor(webContents, "__rw.turnLabel() !== 'Turn running'", "the interrupted turn");
    observed.afterInterrupt = await evaluate(webContents, "__rw.turnLabel()");
    await capture("09-stop-interrupt");

    // 6. The same mutation twice with one idempotency key.
    observed.duplicate = await evaluate(webContents, duplicateTurnScript(HOST_ID, view.sessionId));
    await waitFor(webContents, "document.body.innerText.includes('answer once')", "the idempotent turn in the timeline");
    await capture("10-idempotent");
    return observed;
  } finally {
    // Electron 43 cannot navigate a freshly created window once an earlier one
    // has been destroyed, so each viewport's window is kept alive until the
    // whole run is over and closed here only after the probe line is printed.
    openWindows.push(window);
  }
}

app.commandLine.appendSwitch("lang", "en-US");

app.whenReady().then(async () => {
  const results = [];
  const openWindows = [];
  let failure = null;
  try {
    for (const view of VIEWPORTS) results.push(await runViewport(view, openWindows));
  } catch (error) {
    failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  } finally {
    console.log(`${PROBE_LINE} ${JSON.stringify({ ok: failure === null, failure, viewports: results })}`);
    for (const open of openWindows) open.destroy();
    app.exit(failure === null ? 0 : 1);
  }
});
