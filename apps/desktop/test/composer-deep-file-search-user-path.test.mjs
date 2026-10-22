/** Production editor/completion wiring with only filesystem IPC responses stubbed. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { useComposerDraft } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerDraft";
import { useComposerCompletions } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerCompletions";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
import { ComposerAutocomplete } from "../../apps/desktop/src/components/ComposerAutocomplete";
import { setEditorCaret } from "../../apps/desktop/src/features/chat/composer/editor";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const DEEP = "Assets/_Game/Scripts/Gameplay/Player/Controllers/FeatureController.cs";
const SAVE = "Assets/Systems/Save/SaveSlots.cs";
const shallow = Array.from({ length: 8000 }, (_, i) => ({ path: "Assets/Art/asset_" + i + ".png", kind: "file" }));
let fileIndex = { entries: shallow, truncated: true };
const searches = [];
api.fsIndex = async () => fileIndex;
api.fsSearch = (sessionId, query) => new Promise((resolve, reject) => searches.push({ sessionId, query, resolve, reject }));
// Control only the new debounce boundary; unrelated timers retain browser behavior.
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
const timers = new Map();
let nextTimer = -1;
window.setTimeout = (callback, delay, ...args) => {
  if (delay !== 150) return realSetTimeout(callback, delay, ...args);
  const id = nextTimer--;
  timers.set(id, () => callback(...args));
  return id;
};
window.clearTimeout = (id) => { if (!timers.delete(id)) realClearTimeout(id); };
const pauseTyping = () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); };
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const settle = async () => { await frame(); await frame(); };
const check = (value, message) => { if (!value) throw new Error(message); };
const until = async (predicate, label) => { for (let i = 0; i < 180; i++) { if (predicate()) return; await frame(); } throw new Error(label); };
const noop = () => {};
const sessions = ["s1", "s2"].map((id) => ({ id, title: id === "s2" ? "Other conversation" : "Current", source: "desktop", mode: "agent", permissionMode: "ask", thinkingLevel: "off", messageCount: 0, createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z" }));
await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false, resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
useAppStore.setState({ activeSessionId: "s1", sessions, workspace: { path: "/large", name: "large" }, activeProjectPath: null, plugins: [] });
let draft;
let controller;
function Fixture() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  draft = useComposerDraft({ variant: "docked", activeSessionId: sessionId, workspacePath: "/large", sessions, composerPrefill: null, clearComposerPrefill: noop, t: (key) => key, invalidateComposerTransforms: noop, inputBlocked: false });
  const completions = useComposerCompletions({ value: draft.value, cursor: draft.cursor, composing: draft.composing, enabled: true, referenceSessionId: sessionId, fileReferencesRef: draft.fileReferencesRef, applyEditorDraft: draft.applyEditorDraft, handleInput: draft.handleInput, invalidateComposerTransforms: noop });
  controller = completions.ac;
  return <div className="composer-shell" style={{ position: "absolute", left: 40, top: 500, width: 650 }}>
    <ComposerInput inputRef={draft.ref} value={draft.value} placeholderText="" placeholderKey="fixture" inputBlocked={false} pasting={false} enterToSend={false} runActive={false} composerAc={completions.ac} onPaste={noop} onAcceptCompletion={completions.acceptCompletion} onSubmit={noop} onInsertNewline={noop} onHistoryNavigate={() => false} onInput={completions.handleInput} onCompositionStart={() => draft.setComposing(true)} onCompositionEnd={() => draft.setComposing(false)} onSettledInput={() => draft.setComposing(false)} onFocus={noop} onBlur={noop} />
    <ComposerAutocomplete anchorRef={draft.ref} ac={completions.ac} onAccept={completions.acceptCompletion} />
  </div>;
}
const rootNode = createRoot(document.getElementById("root"));
const editor = () => document.querySelector(".composer-input");
const rows = () => [...document.querySelectorAll('[role="option"] .composer-ac-path')].map((row) => row.textContent);
const note = () => document.querySelector(".composer-ac-truncated") !== null;
async function type(text) {
  const el = editor(); el.textContent = text; setEditorCaret(el, text.length);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  await until(() => draft.value === text, "editor input did not reach its draft");
  await settle();
}
window.deepSearchProbe = async () => {
  flushSync(() => rootNode.render(<Fixture />)); await settle(); editor().focus();
  await type("@"); await until(() => rows().length > 0, "bare @ menu missing");
  check(note() && timers.size === 0, "bare @ must show snapshot without searching");
  await type("@FeatureController"); check(searches.length === 0, "search must debounce"); pauseTyping();
  check(searches[0]?.query === "FeatureController" && searches[0]?.sessionId === "s1", "wrong search owner/query");
  searches[0].resolve({ entries: [{ path: DEEP, kind: "file" }, { path: DEEP, kind: "file" }], truncated: false });
  await until(() => rows().includes(DEEP), "deep file missing");
  check(rows().filter((path) => path === DEEP).length === 1 && !note(), "duplicate or incomplete result state");
  editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
  check(draft.fileReferencesRef.current.some((ref) => ref.path === DEEP), "accept did not create file chip");
  await type("@Feat"); pauseTyping();
  await type("@Save"); check(note(), "a previous query cannot mark the new query complete"); pauseTyping();
  searches[2].resolve({ entries: [{ path: SAVE, kind: "file" }], truncated: false });
  await until(() => rows().includes(SAVE), "new query missing");
  searches[1].resolve({ entries: [{ path: "SaveFeature.cs", kind: "file" }], truncated: false }); await settle();
  check(!rows().includes("SaveFeature.cs"), "late query replaced current results");
  await type("@"); check(note() && !rows().includes(SAVE), "bare @ inherited searched rows");
  await type("@Missing"); pauseTyping(); searches[3].resolve({ entries: [], truncated: true }); await settle(); check(note(), "incomplete search lost note");
  await type("@Broken"); pauseTyping(); searches[4].reject(new Error("fixture search failure")); await settle(); check(note(), "failed search lost note");
  await type("@Cross"); pauseTyping();
  flushSync(() => useAppStore.setState({ activeSessionId: "s2" })); await settle();
  await type("@Cross"); pauseTyping(); check(searches[6]?.sessionId === "s2", "same-project session search reused old owner");
  searches[6].resolve({ entries: [{ path: "CrossNew.cs", kind: "file" }], truncated: false });
  await until(() => rows().includes("CrossNew.cs"), "new session result missing");
  searches[5].resolve({ entries: [{ path: "CrossOld.cs", kind: "file" }], truncated: false }); await settle();
  check(!rows().includes("CrossOld.cs"), "old-session result leaked");
  flushSync(() => useAppStore.setState({ activeSessionId: "s1" })); await settle();
  await type("#Other"); await until(() => controller.mode === "session" && controller.hasItems, "Minih session completion missing");
  check(controller.items.some((item) => item.kind === "session" && item.session.id === "s2"), "session candidate lost");
  check(timers.size === 0 && searches.length === 7, "session completion triggered file search");
  fileIndex = { entries: [{ path: "README.md", kind: "file" }], truncated: false };
  flushSync(() => useAppStore.setState({ workspace: { path: "/small", name: "small" } }));
  await type("@README"); await until(() => rows().includes("README.md"), "complete snapshot missing");
  check(timers.size === 0 && !note(), "complete index must not search");
  return { passed: true, searches: searches.length, sessionCompletionPreserved: true };
};
`;

test("deep file completion accepts a chip and rejects stale query/session answers", { timeout: 90_000 }, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "minih-deep-file-search-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"), "@minih-agent/shared": join(root, "packages/shared/src/index.ts"), react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"), i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const renderer = join(root, "apps/desktop/out/renderer");
    const html = await readFile(join(renderer, "index.html"), "utf8");
    const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
    assert.ok(css.length, "Build Desktop before this user-path test");
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
    await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<div id="root"></div><script type="module" src="renderer.js"></script>`);
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.deepSearchProbe()");
    if (process.env.PI_E2E_ARTIFACT_DIR) {
      const fs = require("node:fs"); fs.mkdirSync(process.env.PI_E2E_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.PI_E2E_ARTIFACT_DIR, "composer-deep-file-search.png"), (await win.webContents.capturePage()).toPNG());
    }
    console.log("DEEP_FILE_SEARCH_PROBE " + JSON.stringify(result)); app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("DEEP_FILE_SEARCH_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("DEEP_FILE_SEARCH_PROBE ".length)), { passed: true, searches: 7, sessionCompletionPreserved: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
