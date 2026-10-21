/**
 * `pi.browser.openInPanel` — a plugin surface that is not a tool call can still
 * put a rendered page in front of the user.
 *
 * The behavior under test spans four layers, so this is a source-contract test
 * (like `browser-preview-tool.test.mjs`): the child-process facade forwards the
 * call, the host validates the path and emits the existing preview event with an
 * empty session, and the renderer substitutes the session it is showing. The
 * Electron behavior itself is covered by the app E2E, not here.
 */
import { readAppSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainSource = await readMainSource();
const appSource = await readAppSource();
const childSource = await readFile(
  new URL("../electron/main/plugin-host-process.mjs", import.meta.url),
  "utf8",
);
const sdkSource = await readFile(
  new URL("../../../packages/plugin-sdk/src/index.ts", import.meta.url),
  "utf8",
);
const specSource = await readFile(
  new URL("../../../docs/spec/07-plugins/03-plugin-api.md", import.meta.url),
  "utf8",
);

test("the plugin API exposes openInPanel under the browser namespace", () => {
  const browserBlock = sdkSource.slice(
    sdkSource.indexOf("browser: {"),
    sdkSource.indexOf("net: {", sdkSource.indexOf("browser: {")),
  );
  assert.match(
    browserBlock,
    /openInPanel: \(input: \{ path: string \}\) => Promise<\{ path: string \}>/,
  );
});

test("the child facade forwards it as a host call", () => {
  assert.match(
    childSource,
    /openInPanel: \(input\) => call\("browser\.openInPanel", \[input \?\? \{\}\]\)/,
  );
});

test("the host allows the API and dispatches it through the browser gate", () => {
  assert.match(mainSource, /"browser\.openInPanel",/);
  assert.match(
    mainSource,
    /case "browser\.openInPanel":\s*\n\s*return this\.invokeBrowser\(loaded, "openInPanel", payload\);/,
  );
  // The handler is reached through invokeBrowser, which asserts browser.cdp.
  const invoke = mainSource.slice(mainSource.indexOf("private async invokeBrowser("));
  assert.match(invoke, /this\.assertPermission\(loaded, "browser\.cdp"\)/);
  assert.match(invoke, /case "openInPanel":/);
});

test("the host validates the path before emitting the preview event", () => {
  const handler = mainSource.slice(
    mainSource.indexOf("openInPanel: async (pluginId, rawPath) =>"),
  );
  assert.match(handler, /isAbsolute\(requested\)/, "relative paths are refused");
  assert.match(handler, /await realpath\(requested\)/, "the real path is what gets checked");
  assert.match(handler, /info\.isFile\(\)/, "only a regular file is shown");
  assert.match(handler, /join\(dataDir, "scratch"\)/, "session scratch is allowed");
  assert.match(handler, /"plugins", "data", pluginId/, "the plugin's own data directory is allowed");
  assert.match(handler, /INVALID_ARGUMENT/, "a refusal names the error code");
  assert.match(
    handler,
    /sendToRenderer\(IPC\.event\.browserPreview, \{ sessionId: "", path: real \}\)/,
    "the event rides the existing preview channel with no session",
  );
});

test("the renderer opens the tab in the session the window is showing", () => {
  const listener = appSource.slice(
    appSource.indexOf("api.onBrowserPreview("),
    appSource.indexOf("api.onHostStatus("),
  );
  assert.match(
    listener,
    /const sessionId = event\.sessionId \|\| state\.activeSessionId \|\| "";/,
  );
  assert.match(listener, /if \(!sessionId\) return;/);
  assert.match(listener, /openWorkPanelTabForSession\(sessionId/);
  assert.doesNotMatch(listener, /openWorkPanelTabForSession\(event\.sessionId/);
});

test("the plugin API reference documents the method and its root rule", () => {
  assert.match(specSource, /pi\.browser\.openInPanel\(input: \{ path: string \}\)/);
  assert.match(specSource, /session scratch directory/);
  assert.match(specSource, /plugin's own data directory/);
});
