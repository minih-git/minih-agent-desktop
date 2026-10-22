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
const { app, BrowserWindow, nativeTheme, session } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ORIGIN = process.env.REMOTE_WEB_E2E_ORIGIN ?? "";
const HOST_ID = process.env.REMOTE_WEB_E2E_HOST_ID ?? "";
const ARTIFACT_DIR = process.env.REMOTE_WEB_E2E_ARTIFACT_DIR ?? "";

/** The shell the theme paints: `document.body` stays transparent in both themes. */
const SHELL_BACKGROUND = "getComputedStyle(document.querySelector('#root > div')).backgroundColor";
const DARK_PREFERENCE = "matchMedia('(prefers-color-scheme: dark)').matches";
const VIEWPORTS = JSON.parse(process.env.REMOTE_WEB_E2E_VIEWPORTS ?? "[]");
const PROBE_LINE = "REMOTE_WEB_PROBE";

/** In-page helpers: every interaction is a real DOM query, click, or input event. */
const HELPERS = `(() => {
  const buttons = () => Array.from(document.querySelectorAll("button"));
  const textOf = (element) => (element.textContent || "").trim();
  const buttonWithText = (text) => buttons().find((candidate) => {
    const candidateText = textOf(candidate);
    return candidateText === text || candidateText.startsWith(text);
  }) || null;
  globalThis.__rw = {
    body: () => document.body.innerText,
    button: (text) => { const found = buttonWithText(text); return found ? { disabled: found.disabled } : null; },
    click: (text) => { const found = buttonWithText(text); if (!found) return false; found.click(); return true; },
    clickAria: (prefix) => { const found = buttons().find((candidate) => (candidate.getAttribute("aria-label") || "").startsWith(prefix)); if (!found) return false; found.click(); return true; },
    approvalCards: () => Array.from(document.querySelectorAll("section")).filter((card) => textOf(card).includes("Approval needed")).length,
    approvalButtons: () => buttons().filter((candidate) => (candidate.getAttribute("aria-label") || "").startsWith("Approval needed:")).map((candidate) => candidate.getAttribute("aria-label")),
    // A tool row is the button that folds one call open: an icon, the tool's own
    // name and a one-line summary, which is what the phone draws in place of a
    // "Tool" label and a full paragraph of arguments.
    toolRows: () => Array.from(document.querySelectorAll("li")).filter((row) => row.querySelector(":scope > button[aria-expanded]")).length,
    turnLabel: () => { const labels = Array.from(document.querySelectorAll("span")).map(textOf); if (labels.includes("Running") || labels.includes("Turn running") || labels.includes("Stopping…")) return "Turn running"; return labels.find((label) => label.startsWith("Turn ")) || null; },
    /** Every button's text: a failing click says what the page really offers. */
    buttonTexts: () => Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean),
    hasSession: (title) => document.querySelector('[aria-label="' + title + '"]') !== null,
    groupHeadings: () => Array.from(document.querySelectorAll("section[aria-label] button[aria-expanded]")).map((button) => (button.textContent || "").trim().replace(/\\s+/g, " ")),
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
    scroller: () => document.querySelector("main"),
    scrollState: () => {
      const main = document.querySelector("main");
      if (!main) return null;
      return {
        scrollTop: Math.round(main.scrollTop),
        scrollHeight: main.scrollHeight,
        clientHeight: main.clientHeight,
        distanceFromBottom: Math.round(main.scrollHeight - main.clientHeight - main.scrollTop),
      };
    },
    atBottom: () => {
      const main = document.querySelector("main");
      return main ? main.scrollHeight - main.clientHeight - main.scrollTop <= 8 : false;
    },
    scrollToTop: () => { const main = document.querySelector("main"); if (!main) return false; main.scrollTop = 0; main.dispatchEvent(new Event("scroll")); return true; },
    rowCount: () => Array.from(document.querySelectorAll("main ul > li")).length,
    rowLabels: () => Array.from(document.querySelectorAll("main ul > li")).map((row) => {
      const label = row.querySelector("span");
      return label ? (label.textContent || "").trim() : "";
    }),
    // A row whose body carries no text at all is the blank box the desktop hides.
    emptyRows: () => Array.from(document.querySelectorAll("main ul > li")).filter((row) => {
      // A row with nothing a reader can see is the blank box the desktop hides.
      // Screen-reader-only labels ("Tool") are not visible text.
      const clone = row.cloneNode(true);
      clone.querySelectorAll(".sr-only").forEach((element) => element.remove());
      return (clone.textContent || "").trim().length === 0;
    }).length,
    toolRowNames: () => Array.from(document.querySelectorAll("main ul > li"))
      .filter((row) => row.querySelector(":scope > button[aria-expanded]"))
      .map((row) => {
        const name = row.querySelector(":scope > button > span");
        return name ? (name.textContent || "").trim() : "";
      }),
    mainText: () => { const main = document.querySelector("main"); return main ? main.innerText : ""; },
    /**
     * The order the conversation's own prompts appear in, in document order.
     *
     * The long fixture types "filler turn N", so the sequence is a direct
     * reading of whether older pages were inserted in the right order.
     */
    fillerIndices: () => Array.from(document.querySelectorAll("main ul > li")).flatMap((row) => {
      const text = row.textContent || "";
      const marker = "filler turn ";
      const at = text.indexOf(marker);
      if (at < 0) return [];
      const digits = text.slice(at + marker.length).match(/[0-9]+/);
      return digits ? [Number(digits[0])] : [];
    }),
    /**
     * The first row's text and its position on screen.
     *
     * Comparing the same row's position before and after older rows are inserted
     * what "the reader keeps their place" means; it is measured in the browser
     * rather than inferred from the scroll offset, so an engine that does its own
     * anchoring cannot hide a missing compensation.
     */
    anchorRow: () => {
      const row = document.querySelector("main ul > li");
      return row ? { id: row.getAttribute("data-item-id"), top: Math.round(row.getBoundingClientRect().top) } : null;
    },
    /** The same row's position, found by its own id: text is not unique. */
    rowTopFor: (id) => {
      const row = document.querySelector('[data-item-id="' + id + '"]');
      return row ? Math.round(row.getBoundingClientRect().top) : null;
    },
    backButton: () => {
      const found = Array.from(document.querySelectorAll("button")).find((candidate) => (candidate.getAttribute("aria-label") || "") === "Back to latest ↓");
      return found ? (found.textContent || "").trim() : null;
    },
    clickBackToLatest: () => {
      const found = Array.from(document.querySelectorAll("button")).find((candidate) => (candidate.getAttribute("aria-label") || "") === "Back to latest ↓");
      if (!found) return false;
      found.click();
      return true;
    },
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
  if (!clicked) {
    const buttons = await evaluate(webContents, "JSON.stringify(__rw.buttonTexts())");
    const body = await evaluate(webContents, "__rw.body()");
    throw new Error(`the page has no "${label}" control; buttons=${String(buttons).slice(0, 600)}; page=${String(body).slice(0, 600)}`);
  }
}

/**
 * Click a control if the page offers it, and say whether it did.
 *
 * The long-session steps after this one are worth reporting even when the
 * control is missing, so the runner can show every defect one run saw.
 */
async function clickTextIfPresent(webContents, text) {
  return (await evaluate(webContents, `__rw.click(${JSON.stringify(text)})`)) === true;
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

/**
 * Wait for something, but keep going if it never happens.
 *
 * The long-session steps record what they saw and let the runner report every
 * defect at once; a load that does not arrive is a defect to report, not a
 * reason to lose the observations after it.
 */
async function waitForOrNull(webContents, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(webContents, expression);
    if (typeof value === "string" && value.startsWith("__rw_error:")) return false;
    if (value) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
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
 * Start one turn the way the client itself does: a same-origin POST with the
 * device cookie plus the CSRF header the registry holds. Used to make new rows
 * arrive while the reader is deliberately scrolled up.
 */
function startTurnScript(hostId, sessionId, text, requestId) {
  const host = JSON.stringify(hostId);
  const session = JSON.stringify(sessionId);
  return `(async () => {
    const entry = (__rw.registry() || []).find((candidate) => candidate.hostId === ${host});
    if (!entry) return { error: "the browser registry has no entry for this host" };
    const response = await fetch("/hosts/" + ${host} + "/v1/sessions/" + ${session} + "/turns", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": entry.csrfToken },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "e2e-" + ${JSON.stringify(requestId)},
        method: "turn/start",
        params: {
          sessionId: ${session},
          admission: "reject_if_busy",
          input: { text: ${JSON.stringify(text)} },
          context: { requestId: ${JSON.stringify(requestId)} },
        },
      }),
    });
    return { status: response.status, payload: await response.json() };
  })()`;
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
    await waitFor(
      webContents,
      "__rw.button('Use a pairing ticket') !== null || __rw.button('Add host') !== null",
      "the host list or connect screen",
    );
    if (await evaluate(webContents, "__rw.button('Use a pairing ticket') !== null")) {
      await clickText(webContents, "Use a pairing ticket");
    } else {
      await clickText(webContents, "Add host");
    }
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

    // The phone can create a session: the sheet opens on the project, the model,
    // the mode and the permission mode, and the composer of the new session is
    // what opens once it starts.
    await clickText(webContents, "New session");
    await waitFor(webContents, "__rw.button('Start') !== null", "the new-session sheet");
    observed.newSessionSheet = await evaluate(webContents, "__rw.body()");
    await capture("03-new-session-sheet");
    await clickText(webContents, "Project");
    await waitFor(webContents, "document.querySelectorAll('button[role=\"radio\"]').length > 0", "the project list");
    await clickText(webContents, view.projectLabel);
    await clickText(webContents, "Start");
    await waitFor(webContents, "document.querySelector('textarea[aria-label=\"Message the agent\"]') !== null", "the new session's composer");
    observed.createdSession = await evaluate(webContents, "__rw.turnLabel()");
    await capture("04-new-session");
    await clickAria(webContents, "Back", "Back (to the session list)");
    // The list reloads on arrival, so wait for the new session's own row (the
    // Host's default title) instead of reading the headings while it loads.
    await waitFor(webContents, "__rw.hasSession('New task')", "the created session in the list");
    observed.sessionsAfterCreate = await evaluate(webContents, "JSON.stringify(__rw.groupHeadings())");
    observed.groupOfCreatedSession = await evaluate(webContents, "__rw.groupOf('New task')");

    // The folder picker: walk from the Host's root, register a folder that is
    // not a project yet, and land in a session created in it.
    await clickText(webContents, "New session");
    await waitFor(webContents, "__rw.button('Start') !== null", "the new-session sheet");
    await clickText(webContents, "Project");
    await waitFor(webContents, "__rw.button('Add a project') !== null", "the project list with its add-project entry");
    await clickText(webContents, "Add a project");
    // The picker starts at the Host's browse root: it shows `~`, offers no way
    // up, and lists the folders the Host allows.
    await waitFor(webContents, "__rw.button('e2e-new-project') !== null", "the folder picker at the root");
    observed.pickerRoot = await evaluate(webContents, "__rw.body()");
    await clickText(webContents, "e2e-new-project");
    await waitFor(webContents, "__rw.button('Use this folder') !== null", "the chosen folder");
    await capture("05-add-project");
    await clickText(webContents, "Use this folder");
    // The sheet comes back on the folder that was just registered; starting the
    // session is the last step, exactly as it is for an existing project.
    await waitFor(webContents, "__rw.button('Start') !== null", "the sheet on the new project");
    observed.addedProjectSheet = await evaluate(webContents, "__rw.body()");
    await clickText(webContents, "Start");
    await waitFor(webContents, "document.querySelector('textarea[aria-label=\\\"Message the agent\\\"]') !== null", "the session of the new project");
    observed.newProjectComposer = await evaluate(
      webContents,
      'document.querySelector(\'textarea[aria-label="Message the agent"]\') !== null',
    );
    await clickAria(webContents, "Back", "Back (to the session list)");
    // The heading is styled uppercase, so it is matched on the section's own
    // label rather than on `innerText`.
    await waitFor(
      webContents,
      "Array.from(document.querySelectorAll('section[aria-label]')).some((section) => (section.getAttribute('aria-label') || '') === 'e2e-new-project')",
      "the new project's heading",
    );
    observed.headingsWithNewProject = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.groupHeadings())"));
    // 2. The host list, its sessions, then one session's timeline.
    await clickAria(webContents, "Back", "Back (to the host list)");
    await waitFor(webContents, "document.body.innerText.includes('Online')", "the host to probe as online");
    observed.hostList = await evaluate(webContents, "__rw.body()");
    await capture("06-hosts");
    await clickText(webContents, "Open");
    await waitFor(webContents, `__rw.hasSession(${JSON.stringify(view.title)})`, "the session list");
    observed.sessions = await evaluate(webContents, "__rw.body()");
    await evaluate(webContents, `document.querySelector('[aria-label=${JSON.stringify(view.title)}]').click()`);
    await waitFor(webContents, "document.body.innerText.includes('Live')", "the session event stream to go live");
    // The bar over the conversation names the computer the person paired, not the
    // id the Gateway minted for it.
    observed.sessionHeader = await evaluate(webContents, "__rw.body()");

    observed.sessionHeaderHost = HOST_ID;
    await capture("07-timeline");

    // 3. A turn that raises an approval, then a forced drop of its stream.
    await type("run the approval fixture");
    await clickText(webContents, "Send");
    await waitFor(webContents, "__rw.approvalCards() === 1", "the approval card");
    observed.approvalButtons = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.approvalButtons())"));
    observed.dropped = await dropStreams(view.sessionId);
    observed.resumed = await waitForResumedStream(view.sessionId);
    await waitFor(webContents, "__rw.approvalCards() === 1", "exactly one approval card after the reconnect");
    observed.approvalCardsAfterReconnect = await evaluate(webContents, "__rw.approvalCards()");
    await capture("08-approval-reconnect");

    // 4. Approve once; the tool must run once.
    await clickAria(webContents, "Approval needed: Allow once");
    // High-risk tool calls show a secondary confirmation sheet (Spec O4).
    await waitFor(
      webContents,
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          const btn = Array.from(dialog.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "Allow once");
          if (btn) { btn.click(); return true; }
        }
        return __rw.approvalCards() === 0;
      })()`,
      "high-risk confirmation sheet or resolved approval",
    );
    await waitFor(webContents, "__rw.approvalCards() === 0 && __rw.toolRows() === 1", "the approved tool row");
    await waitFor(webContents, "document.body.innerText.includes('Turn completed')", "the approved turn to complete");
    await capture("09-approved");

    // 5. Start + stop, then start + interrupt.
    await type("hold the turn open for a stop");
    await clickText(webContents, "Send");
    await waitFor(webContents, "__rw.turnLabel() === 'Turn running'", "the running turn before Stop");
    await clickText(webContents, "Stop");
    await waitFor(webContents, "__rw.button('Stop after this step') !== null", "the stop sheet");
    await clickText(webContents, "Stop after this step");
    await waitFor(webContents, "__rw.turnLabel() !== 'Turn running'", "the stopped turn");
    observed.afterStop = await evaluate(webContents, "__rw.turnLabel()");
    await type("hold the turn open for an interrupt");
    await clickText(webContents, "Send");
    await waitFor(webContents, "__rw.turnLabel() === 'Turn running'", "the running turn before Interrupt");
    await clickText(webContents, "Stop");
    await waitFor(webContents, "__rw.button('Stop now') !== null", "the stop sheet before interrupt");
    await clickText(webContents, "Stop now");
    await waitFor(webContents, "__rw.turnLabel() === 'Turn interrupted'", "the interrupted turn");
    observed.afterInterrupt = await evaluate(webContents, "__rw.turnLabel()");
    await capture("10-stop-interrupt");

    // 6. The same mutation twice with one idempotency key.
    observed.duplicate = await evaluate(webContents, duplicateTurnScript(HOST_ID, view.sessionId));
    await waitFor(webContents, "document.body.innerText.includes('answer once')", "the idempotent turn in the timeline");
    await capture("11-idempotent");

    await runLongSession(webContents, view, observed, capture);
    return observed;
  } finally {
    // Electron 43 cannot navigate a freshly created window once an earlier one
    // has been destroyed, so each viewport's window is kept alive until the
    // whole run is over and closed here only after the probe line is printed.
    openWindows.push(window);
  }
}

/**
 * A conversation longer than one snapshot page (rollout D).
 *
 * Opening it must land on the newest row (the whole document used to scroll, so
 * a long session opened at its oldest row with the composer below the fold), the
 * rows the desktop hides must stay hidden, older rows must be loadable without
 * the reader losing their place, and a row that arrives while they are scrolled
 * up must be announced rather than silently missed.
 */
async function runLongSession(webContents, view, observed, capture) {
  await clickAria(webContents, "Back", "Back (to the session list)");
  await waitFor(webContents, `__rw.hasSession(${JSON.stringify(view.longTitle)})`, "the long session row");
  await evaluate(webContents, `document.querySelector('[aria-label=${JSON.stringify(view.longTitle)}]').click()`);
  await waitFor(webContents, "document.body.innerText.includes('Live')", "the long session's event stream");

  // 1. It opens at the newest row, and the newest prompt is on screen.
  await waitFor(webContents, "__rw.atBottom()", "the timeline to open at the bottom");
  await waitFor(
    webContents,
    `__rw.mainText().includes(${JSON.stringify(view.longLastPrompt)})`,
    "the newest user message to be visible",
  );
  observed.longOpenedAtBottom = await evaluate(webContents, "__rw.scrollState()");
  observed.longRowCount = await evaluate(webContents, "__rw.rowCount()");
  observed.longOpenedOrder = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.fillerIndices())"));
  await capture("12-long-session");

  // 2. No blank rows, and tool rows carry their tool's name.
  observed.longEmptyRows = await evaluate(webContents, "__rw.emptyRows()");
  observed.longRowLabels = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.rowLabels())"));
  observed.longToolNames = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.toolRowNames())"));

  // 3. Older rows load in order, in one page-sized step, without moving the
  //    reader. The anchor is a row that is on screen before and after, so the
  //    comparison is what scroll anchoring would otherwise be doing for us.
  //    Every step below records what it saw and lets the runner report all of
  //    it, so a defect early on does not hide the ones after it.
  const beforeRows = observed.longRowCount;
  const beforeLoad = await evaluate(webContents, "__rw.scrollState()");
  observed.longLoadEarlierOffered = await clickTextIfPresent(webContents, "Load earlier");
  observed.longFirstLoadGrew = observed.longLoadEarlierOffered
    ? await waitForOrNull(webContents, `__rw.rowCount() > ${beforeRows}`)
    : false;
  observed.longAfterLoad = await evaluate(webContents, "__rw.scrollState()");
  observed.longBeforeLoad = beforeLoad;
  observed.longRowsAfterLoad = await evaluate(webContents, "__rw.rowCount()");
  observed.longAfterLoadOrder = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.fillerIndices())"));
  await capture("13-long-after-load");
  // While the reader is at the bottom there is nothing to jump back to.
  observed.longBackButtonBefore = await evaluate(webContents, "__rw.backButton()");

  // 4. Loading older rows while reading further up is not "new messages": the
  //    control that takes the reader back must not claim a count.
  await evaluate(webContents, "__rw.scrollToTop()");
  await waitFor(webContents, "__rw.atBottom() === false", "the reader to leave the bottom");
  observed.longScrollAfterTop = await evaluate(webContents, "__rw.scrollState()");
  observed.longAnchorBefore = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.anchorRow())"));
  observed.longBeforeSecond = JSON.parse(await evaluate(webContents, "JSON.stringify({ state: __rw.scrollState(), rows: __rw.rowCount(), first: __rw.anchorRow() })"));
  const rowsBeforeSecondLoad = await evaluate(webContents, "__rw.rowCount()");
  observed.longHeldIds = JSON.parse(await evaluate(webContents, "JSON.stringify(Array.from(document.querySelectorAll('main ul > li')).slice(0,3).map((row) => row.getAttribute('data-item-id')))"));
  observed.longSecondLoadOffered = await clickTextIfPresent(webContents, "Load earlier");
  observed.longSecondLoadGrew = observed.longSecondLoadOffered
    ? await waitForOrNull(webContents, `__rw.rowCount() > ${rowsBeforeSecondLoad}`)
    : false;
  observed.longAnchorAfter = await evaluate(webContents, `__rw.rowTopFor(${JSON.stringify((observed.longAnchorBefore ?? {}).id ?? "")})`);
  observed.longAfterSecond = JSON.parse(await evaluate(webContents, "JSON.stringify({ state: __rw.scrollState(), rows: __rw.rowCount(), first: __rw.anchorRow() })"));
  observed.longBackButtonWhileReading = await evaluate(webContents, "__rw.backButton()");
  observed.longOrderAfterSecondLoad = JSON.parse(await evaluate(webContents, "JSON.stringify(__rw.fillerIndices())"));

  // 5. A row that arrives while the reader is scrolled up is announced.
  const started = await evaluate(webContents, startTurnScript(HOST_ID, view.longSessionId, "answer once", "e2e-long-scroll"));
  observed.longTurnStarted = started.status;
  await waitFor(webContents, "__rw.backButton() !== null", "the back-to-latest control");
  observed.longScrollWhileReading = await evaluate(webContents, "__rw.scrollState()");
  await waitFor(webContents, "String(__rw.backButton()) !== 'Back to latest ↓'", "the count on the back-to-latest control");
  observed.longBackButtonAfter = await evaluate(webContents, "__rw.backButton()");
  await capture("14-long-scrolled-up");

  await evaluate(webContents, "__rw.clickBackToLatest()");
  await waitFor(webContents, "__rw.atBottom()", "the jump back to the newest row");
  observed.longBackAtBottom = await evaluate(webContents, "__rw.scrollState()");

  // 6. The same screen in dark mode, for the visual check. The client follows
  //    `prefers-color-scheme`, so the surface is read off the shell the theme
  //    paints — `document.body` itself stays transparent in both themes.
  nativeTheme.themeSource = "light";
  await sleep(200);
  observed.longLightBackground = await evaluate(webContents, SHELL_BACKGROUND);
  observed.longLightPrefers = await evaluate(webContents, DARK_PREFERENCE);
  nativeTheme.themeSource = "dark";
  await sleep(200);
  await capture("15-long-dark");
  observed.longDarkBackground = await evaluate(webContents, SHELL_BACKGROUND);
  observed.longDarkPrefers = await evaluate(webContents, DARK_PREFERENCE);
  nativeTheme.themeSource = "light";
  await sleep(100);
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
