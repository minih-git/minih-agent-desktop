/**
 * A folder, an extensionless path, and a home path become links only once the
 * host confirms the entry exists, and a folder's click reveals it in the system
 * file manager instead of opening it.
 *
 * Both halves run for real: `Markdown` renders through Vite SSR with the
 * production linker, and the opener hooks are compiled and driven against a
 * recorded store and stubbed host replies. What a test asserts is what the
 * reader sees and which host call the click makes, not the shape of the code.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const reactExports = await import("react");
const sharedPackage = await import("@minih-agent/shared");

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Compile one desktop module and evaluate it against the given mocks. */
function loadModule(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(read(relative), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

function deferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ---------- the existence check ---------- */

test("existence is confirmed once per workspace, session, and path", async () => {
  const lookups = [];
  const gate = deferred();
  const hook = loadModule("../src/hooks/use-chat-ref-exists.ts", {
    react: await import("react"),
    "@minih-agent/shared": await import("@minih-agent/shared"),
    "../lib/api": {
      api: {
        fsResolveRef: async (ref, sessionId) => {
          lookups.push([ref, sessionId]);
          await gate.promise;
          return { match: { root: "workspace", relativePath: ref, absolutePath: ref, entryKind: "directory" } };
        },
      },
    },
    "../lib/chat-links": {
      UNVERIFIED_CHAT_REF_ATTRIBUTE: "data-chat-ref",
      resolvePreviewTarget: () => null,
      safeDecodeUri: (value) => value,
    },
    "../lib/verified-chat-files": {
      createChatFileVerificationQueue: () => (run, signal) =>
        signal.aborted ? Promise.resolve({ state: "pending" }) : run(),
    },
    "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "" },
    "./use-chat-session-capability": { useChatSessionCapability: () => true },
    "../stores/app-store": { useAppStore: () => "/project" },
  });

  const key = hook.chatRefExistenceKey("/project", "session-1", "apps/desktop/src");
  const first = hook.confirmChatRefExists("apps/desktop/src", "session-1", key, new AbortController().signal);
  // A second rendering of the same reference while the first is in flight must
  // share the request instead of asking main a second time.
  const second = hook.confirmChatRefExists("apps/desktop/src", "session-1", key, new AbortController().signal);
  await flush();
  assert.equal(lookups.length, 1);
  gate.resolve();
  assert.deepEqual(await first, { state: "exists", entryKind: "directory" });
  assert.deepEqual(await second, { state: "exists", entryKind: "directory" });
  // A settled answer is served from the cache.
  assert.deepEqual(
    await hook.confirmChatRefExists("apps/desktop/src", "session-1", key, new AbortController().signal),
    { state: "exists", entryKind: "directory" },
  );
  assert.equal(lookups.length, 1);
  assert.deepEqual(hook.peekChatRefExistence("apps/desktop/src", "/project", "session-1"), {
    state: "exists",
    entryKind: "directory",
  });
});

test("a cancelled lookup never reports the reference as existing", async () => {
  const controller = new AbortController();
  const hook = loadModule("../src/hooks/use-chat-ref-exists.ts", {
    react: await import("react"),
    "@minih-agent/shared": await import("@minih-agent/shared"),
    "../lib/api": { api: { fsResolveRef: async () => ({ match: null }) } },
    "../lib/chat-links": {
      UNVERIFIED_CHAT_REF_ATTRIBUTE: "data-chat-ref",
      resolvePreviewTarget: () => null,
      safeDecodeUri: (value) => value,
    },
    "../lib/verified-chat-files": {
      createChatFileVerificationQueue: () => (_run, signal) =>
        signal.aborted ? Promise.resolve({ state: "pending" }) : Promise.resolve({ state: "absent" }),
    },
    "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "" },
    "./use-chat-session-capability": { useChatSessionCapability: () => true },
    "../stores/app-store": { useAppStore: () => "/project" },
  });
  controller.abort();
  const result = await hook.confirmChatRefExists(
    "elsewhere/x",
    undefined,
    hook.chatRefExistenceKey("/project", null, "elsewhere/x"),
    controller.signal,
  );
  assert.equal(result.state, "pending");
  assert.equal(hook.peekChatRefExistence("elsewhere/x", "/project", null), null);
});

/* ---------- rendering a markdown reply ---------- */

const HOST_CALLS = Symbol.for("chat-ref-render-calls");

test("an unconfirmed reference renders as text and a confirmed one as a link", async (t) => {
  const calls = [];
  globalThis[HOST_CALLS] = calls;
  globalThis.window = {
    minihAgent: {
      platform: "linux",
      invoke: async (channel, payload) => {
        calls.push([channel, payload]);
        // Nothing exists at `/api/v1/users`: it is a route in a reply.
        if (payload?.ref === "foo/bar") {
          return {
            ok: true,
            data: { match: { root: "workspace", relativePath: "foo/bar", absolutePath: "/project/foo/bar", matchedBy: "exact-relative", entryKind: "directory", projectRoot: { primary: true } } },
          };
        }
        return { ok: true, data: { match: null } };
      },
    },
    matchMedia: () => ({ matches: false }),
  };
  t.after(() => {
    delete globalThis.window;
    delete globalThis[HOST_CALLS];
  });
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const state = {
    sessions: [{ id: "session-1", title: "Local" }],
    activeSessionId: "session-1",
    workspace: { path: "/project" },
    openUrlInWorkPanel: () => {},
    showToast: () => {},
  };
  useAppStore.setState(state);
  Object.assign(useAppStore.getInitialState(), state);
  const { Markdown } = await ssr.load("/src/components/Markdown.tsx");
  const html = ssr.render(
    createElement(Markdown, { source: "The handler lives at `/api/v1/users` today." }),
    { sessionId: "session-1" },
  );
  // No confirmation yet (server rendering runs no effects), so the route stays
  // the code chip the author wrote.
  assert.match(html, /<code[^>]*>\/api\/v1\/users<\/code>/);
  assert.doesNotMatch(html, /chat-code-link/);
  assert.deepEqual(calls, [], "an unconfirmed reference costs no host call while rendering");

  // Once the host has confirmed the entry, the same reply renders the same run
  // as the button that opens it.
  const exists = await ssr.load("/src/hooks/use-chat-ref-exists.ts");
  const key = exists.chatRefExistenceKey("/project", "session-1", "foo/bar");
  await exists.confirmChatRefExists("foo/bar", "session-1", key, new AbortController().signal);
  const confirmed = ssr.render(
    createElement(Markdown, { source: "The folder `foo/bar` holds it." }),
    { sessionId: "session-1" },
  );
  assert.match(confirmed, /class="chat-code-link"/);
  assert.match(confirmed, /<code[^>]*>foo\/bar<\/code><\/button>/);
});

/* ---------- the click a folder makes ---------- */

const state = {
  sessions: [],
  workspace: { path: "/project" },
  activeSessionId: "session-1",
  pluginViews: [],
  openFileInWorkPanel: () => {},
  openUrlInWorkPanel: () => {},
  openWorkPanelTab: () => {},
  showToast: () => {},
};

function loadPreviewTarget(calls, match, options = {}) {
  const store = {
    ...state,
    showToast: (...args) => calls.toasts.push(args),
    ...(options.remote ? { workspace: { path: "/project", remote: true } } : {}),
  };
  const useAppStore = Object.assign((selector) => selector(store), {
    getState: () => store,
    setState: (update) => Object.assign(store, update),
  });
  const shared = { isActiveInProject: () => true };
  return loadModule("../src/hooks/use-preview-target.ts", {
    react: reactExports,
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "@minih-agent/shared": shared,
    "../stores/app-store": { useAppStore },
    "./use-chat-session-capability": { useChatSessionCapability: () => true },
    "../lib/remote-session-safety": { sessionAllows: () => true },
    "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "" },
    "../lib/api": {
      api: {
        listPluginViews: async () => [],
        listPlugins: async () => ({ plugins: [] }),
        fsResolveRef: async (ref) => {
          calls.resolved.push(ref);
          const answer = typeof match === "function" ? match(ref) : match;
          // A caller may hand either a match or a whole result object, so a test
          // can exercise the "outside the roots" answer too.
          return answer && "match" in answer ? answer : { match: answer };
        },
        fsReveal: async (path, sessionId) => calls.reveals.push([path, sessionId]),
        fsRevealChatRef: async (path, sessionId) => calls.outsideReveals.push([path, sessionId]),
        fsOpen: async (path) => calls.opens.push(path),
      },
    },
    "../lib/chat-links": loadModule("../src/lib/chat-links.ts", {
      "@minih-agent/shared": sharedPackage,
      "./chat-link-scanner.ts": loadModule("../src/lib/chat-link-scanner.ts", {
        "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
      }),
      "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
    }),
    "../lib/open-http-url": { openHttpUrl: () => {} },
    "../lib/work-panel-tabs": loadModule("../src/lib/work-panel-tabs.ts", {}),
  });
}



async function clickReference(match, options) {
  const calls = { resolved: [], reveals: [], outsideReveals: [], opens: [], toasts: [] };
  const hook = loadPreviewTarget(calls, match, options);
  let open = null;
  function Harness() {
    open = hook.useOpenChatFileRef();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  assert.equal(typeof open, "function", "the hook returned a click handler");
  open("apps/desktop/src", undefined, undefined, {});
  await flush();
  return calls;
}

const folderMatch = {
  root: "workspace",
  relativePath: "apps/desktop/src",
  absolutePath: "/project/apps/desktop/src",
  matchedBy: "exact-relative",
  entryKind: "directory",
  projectRoot: { primary: true },
};

test("clicking a folder reveals it in the system file manager", async () => {
  const calls = await clickReference(folderMatch);
  // `fsOpen` would launch an `.app` bundle, and the file view has no folder
  // location, so the reveal call is the only correct destination.
  assert.deepEqual(calls.reveals, [["/project/apps/desktop/src", "session-1"]]);
  assert.deepEqual(calls.opens, []);
  assert.deepEqual(calls.toasts, []);
});

test("a remote session reports that a folder cannot be shown here", async () => {
  const calls = await clickReference(folderMatch, { remote: true });
  assert.deepEqual(calls.reveals, []);
  assert.deepEqual(calls.toasts.map(([key]) => key), ["chat.remoteFolderRevealUnsupported"]);
});

test("a file reference still opens where it always did", async () => {
  const calls = await clickReference({
    ...folderMatch,
    relativePath: "apps/desktop/src/App.tsx",
    absolutePath: "/project/apps/desktop/src/App.tsx",
    entryKind: "file",
  });
  assert.deepEqual(calls.reveals, []);
});

/* ---------- the marker through the whole render pipeline ---------- */

/**
 * The marker has to survive `ReactMarkdown` → `rehypeRaw` → `rehypeSanitize`
 * and then disappear from the DOM. Both halves matter: without the first the
 * link would render before the host answered, and without the second an
 * internal attribute would leak into the reader's markup.
 */
test("the unverified marker survives sanitization and never reaches the DOM", async (t) => {
  const calls = [];
  globalThis.window = {
    minihAgent: {
      platform: "linux",
      invoke: async (channel, payload) => {
        calls.push(payload?.ref);
        return { ok: true, data: { match: null } };
      },
    },
    matchMedia: () => ({ matches: false }),
  };
  t.after(() => {
    delete globalThis.window;
  });
  const ssr = await slotSsr(t, {
    plugins: [{
      name: "sanitize-probe",
      transform(source, id) {
        // Expose the schema the production renderer sanitizes with, so the test
        // asserts the real allow list instead of a copy of it.
        if (id.endsWith("/components/Markdown.tsx")) {
          return `${source}\nexport { sanitizeSchema as ProbeSanitizeSchema };`;
        }
      },
    }],
  });
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const state = {
    sessions: [{ id: "session-1", title: "Local" }],
    activeSessionId: "session-1",
    workspace: { path: "/project" },
    openUrlInWorkPanel: () => {},
    showToast: () => {},
  };
  useAppStore.setState(state);
  Object.assign(useAppStore.getInitialState(), state);
  const { Markdown, ProbeSanitizeSchema } = await ssr.load("/src/components/Markdown.tsx");

  assert.ok(
    (ProbeSanitizeSchema.attributes.a || []).includes("data-chat-ref"),
    "the sanitizer keeps the marker on <a>, otherwise the renderer could never read it",
  );

  const html = ssr.render(
    createElement(Markdown, { source: "The list lives under `/api/v1/users`." }),
    { sessionId: "session-1" },
  );
  assert.doesNotMatch(html, /data-chat-ref/, "the marker is markup, not content");
  assert.doesNotMatch(html, /chat-code-link/, "nothing becomes clickable before the host answers");
  assert.deepEqual(calls, [], "server rendering asks nothing; the effect does");
});

/**
 * A reply can contain `<a data-chat-ref="unverified" href="/etc/passwd">` as
 * text. Sanitization keeps the attribute, so the renderer must treat it exactly
 * like its own marker: ask once, and show plain text when nothing is there.
 */
test("a marker written by the model itself is confirmed once and then shown as text", async (t) => {
  const calls = [];
  globalThis.window = {
    minihAgent: {
      platform: "linux",
      invoke: async (channel, payload) => {
        calls.push([channel, payload?.ref]);
        return { ok: true, data: { match: null } };
      },
    },
    matchMedia: () => ({ matches: false }),
  };
  t.after(() => {
    delete globalThis.window;
  });
  const ssr = await slotSsr(t);
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const state = {
    sessions: [{ id: "session-1", title: "Local" }],
    activeSessionId: "session-1",
    workspace: { path: "/project" },
    openUrlInWorkPanel: () => {},
    showToast: () => {},
  };
  useAppStore.setState(state);
  Object.assign(useAppStore.getInitialState(), state);
  const { Markdown } = await ssr.load("/src/components/Markdown.tsx");
  const html = ssr.render(
    createElement(Markdown, {
      source: '<a data-chat-ref="unverified" href="/etc/passwd">the password file</a>',
    }),
    { sessionId: "session-1" },
  );
  // Server rendering runs no effect, so the reference is still unresolved and
  // the anchor is not rendered at all.
  assert.match(html, /the password file/);
  assert.doesNotMatch(html, /href="\/etc\/passwd"/);
  assert.doesNotMatch(html, /data-chat-ref/);

  // The confirmation is one lookup, and its absence keeps the text plain.
  const existence = await ssr.load("/src/hooks/use-chat-ref-exists.ts");
  const key = existence.chatRefExistenceKey("/project", "session-1", "/etc/passwd");
  const answer = await existence.confirmChatRefExists(
    "/etc/passwd",
    "session-1",
    key,
    new AbortController().signal,
  );
  assert.deepEqual(answer, { state: "absent" });
  assert.equal(calls.length, 1, "one confirmation, not one per render");
  assert.equal(existence.peekChatRefExistence("/etc/passwd", "/project", "session-1"), null);
});

/* ---------- a miss is not permanent ---------- */

test("a path that does not exist yet becomes a link once it does", async () => {
  let exists = false;
  const calls = [];
  const hook = loadModule("../src/hooks/use-chat-ref-exists.ts", {
    react: await import("react"),
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "@minih-agent/shared": await import("@minih-agent/shared"),
    "../lib/api": {
      api: {
        fsResolveRef: async (ref) => {
          calls.push(ref);
          return exists
            ? { match: { root: "workspace", relativePath: ref, absolutePath: `/project/${ref}`, entryKind: "directory" } }
            : { match: null };
        },
      },
    },
    "../lib/chat-links": {
      UNVERIFIED_CHAT_REF_ATTRIBUTE: "data-chat-ref",
      resolvePreviewTarget: () => null,
      safeDecodeUri: (value) => value,
    },
    "../lib/verified-chat-files": {
      createChatFileVerificationQueue: () => (run, signal) =>
        signal.aborted ? Promise.resolve({ state: "pending" }) : run(),
    },
    "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "" },
    "./use-chat-session-capability": { useChatSessionCapability: () => true },
    "../stores/app-store": { useAppStore: () => "/project" },
  });

  const key = hook.chatRefExistenceKey("/project", "session-1", "out");
  assert.deepEqual(
    await hook.confirmChatRefExists("out", "session-1", key, new AbortController().signal),
    { state: "absent" },
  );
  // A reply often names a folder it is about to create, so the miss must not
  // survive the component that asked.
  assert.equal(hook.peekChatRefExistence("out", "/project", "session-1"), null);

  exists = true;
  assert.deepEqual(
    await hook.confirmChatRefExists("out", "session-1", key, new AbortController().signal),
    { state: "exists", entryKind: "directory" },
  );
  assert.deepEqual(calls, ["out", "out"]);
  // The confirmation is durable.
  assert.deepEqual(hook.peekChatRefExistence("out", "/project", "session-1"), {
    state: "exists",
    entryKind: "directory",
  });
});

/* ---------- a session without local tools asks nothing ---------- */

test("a session that may not use local tools sends no lookup at all", async () => {
  const lookups = [];
  const hook = loadModule("../src/hooks/use-chat-ref-exists.ts", {
    react: await import("react"),
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "@minih-agent/shared": await import("@minih-agent/shared"),
    "../lib/api": {
      api: {
        fsResolveRef: async (ref) => {
          lookups.push(ref);
          return { match: null };
        },
      },
    },
    "../lib/chat-links": {
      UNVERIFIED_CHAT_REF_ATTRIBUTE: "data-chat-ref",
      resolvePreviewTarget: () => ({ kind: "file", path: "/etc/passwd", unverified: true }),
      safeDecodeUri: (value) => value,
    },
    "../lib/verified-chat-files": {
      createChatFileVerificationQueue: () => (run, signal) =>
        signal.aborted ? Promise.resolve({ state: "pending" }) : run(),
    },
    "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "remote:host:session" },
    "./use-chat-session-capability": { useChatSessionCapability: () => false },
    "../stores/app-store": { useAppStore: (selector) => selector({ workspace: { path: "/project" }, activeSessionId: "remote:host:session" }) },
  });

  let state = null;
  function Harness() {
    state = hook.useChatRefLinkState(true, "/etc/passwd", "/project", "");
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  await flush();
  // Probing whether a path exists is a local operation, so a session without
  // that capability never asks.
  assert.deepEqual(lookups, []);
  assert.equal(state?.unconfirmed, true);
  assert.equal(state?.entryKind, undefined);
});

/* ---------- an entry outside every allowed root ---------- */

const outsideFolderMatch = {
  match: null,
  reason: "outside-allowed-roots",
  outside: { absolutePath: "/elsewhere/notes", entryKind: "directory" },
};

test("clicking an outside reference offers a menu instead of reporting a restriction", async () => {
  const calls = { resolved: [], reveals: [], opens: [], toasts: [], outsideReveals: [], menus: [] };
  const hook = loadPreviewTarget(calls, outsideFolderMatch);
  let open = null;
  function Harness() {
    open = hook.useOpenChatFileRef();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  open("/elsewhere/notes", undefined, undefined, {});
  await flush();
  // The reveal goes through the dedicated channel; the guarded `fsReveal` is
  // never asked about a path it would refuse.
  assert.deepEqual(calls.outsideReveals, [["/elsewhere/notes", "session-1"]]);
  assert.deepEqual(calls.reveals, []);
  assert.deepEqual(calls.opens, []);
  assert.deepEqual(calls.toasts, []);
});

test("an outside reference has exactly the actions a path it cannot read has", async () => {
  const calls = { resolved: [], reveals: [], opens: [], toasts: [], outsideReveals: [], copied: [] };
  const hook = loadPreviewTarget(calls, outsideFolderMatch);
  let items = null;
  const menu = loadModule("../src/hooks/use-chat-file-menu.tsx", {
    react: reactExports,
    "react/jsx-runtime": await import("react/jsx-runtime"),
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "@minih-agent/shared": sharedPackage,
    "../components/icons": {
      IconBrowser: () => null,
      IconCopy: () => null,
      IconExternal: () => null,
      IconFolderOpen: () => null,
      IconGlobe: () => null,
    },
    "../lib/chat-links": loadModule("../src/lib/chat-links.ts", {
      "@minih-agent/shared": sharedPackage,
      "./chat-link-scanner.ts": loadModule("../src/lib/chat-link-scanner.ts", {
        "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
      }),
      "./render-diagnostics.ts": { beginRenderDiagnostic: () => () => {} },
    }),
    "../components/ContextMenu": {
      useContextMenu: () => ({ contextMenu: null, openContextMenu: () => {}, closeContextMenu: () => {} }),
    },
    "./use-preview-target": hook,
    "./use-chat-session-capability": { useChatNativeFilesAllowed: () => true },
  });
  function Harness() {
    items = menu.useChatFileMenuItems();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  const outsideItems = items({ path: "/elsewhere/notes", outsideProject: true });
  assert.deepEqual(outsideItems.map((item) => item.id), ["reveal-outside-ref", "copy-absolute-path"]);
  // A folder inside the project keeps both copy actions and adds the reveal.
  const folderItems = items({ path: "apps/desktop/src", entryKind: "directory" });
  assert.deepEqual(
    folderItems.map((item) => item.id),
    ["reveal-in-file-manager", "copy-full-path", "copy-relative-path"],
  );
});
