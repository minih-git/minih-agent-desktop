import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { parseSessionLinks, serializeComposerFileReferences } from "@minih-agent/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/** Read one renderer source file as text, for the wiring contracts below. */
const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [completionsHook, autocompleteHook, panel, editor, smartStop, draftHook] = await Promise.all([
  readSource("../src/features/chat/composer/hooks/useComposerCompletions.ts"),
  readSource("../src/hooks/use-composer-autocomplete.ts"),
  readSource("../src/components/ComposerAutocomplete.tsx"),
  readSource("../src/features/chat/composer/editor.ts"),
  readSource("../src/features/chat/composer/session-targets.ts"),
  readSource("../src/features/chat/composer/hooks/useComposerDraft.ts"),
]);

const { promptAttachmentsFromDraft } = await import("../src/stores/helpers/store-helpers.ts");

/**
 * The Composer's `#` session target (D673), end to end:
 *
 * typing `#` opens the host's session group, accepting a row leaves an inline
 * `#title` chip, and submitting turns that chip into the one sentence the model
 * reads — `#title (Session ID: <id>)` — with no attachment and no session link,
 * so Electron main never attaches an excerpt of that conversation.
 *
 * The panel is a pure function of the controller, so it renders for real; the
 * hook's own decisions (which candidate list, when to open, what accepting
 * inserts) are asserted against their wiring, since this repository has no React
 * interaction harness.
 */

async function loadPanel() {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const module = await vite.ssrLoadModule("/src/components/ComposerAutocomplete.tsx");
  return { vite, ComposerAutocomplete: module.ComposerAutocomplete };
}

async function i18nInstance(locale = "en") {
  const { catalogs } = await import("@minih-agent/i18n");
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: catalogs[locale] } } });
  return i18n;
}

function controller(overrides) {
  return {
    open: true,
    mode: "session",
    items: [],
    hasItems: true,
    highlight: 0,
    setHighlight: () => {},
    truncated: false,
    noWorkspace: false,
    close: () => {},
    ...overrides,
  };
}

function sessionItem(id, title, ranges = []) {
  return {
    kind: "session",
    match: { score: 0, ranges },
    session: {
      id,
      title,
      messageCount: 3,
      mode: "agent",
      thinkingLevel: "off",
      permissionMode: "ask",
      projectPath: "/work/app",
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: new Date(Date.now() - 600_000).toISOString(),
    },
  };
}

function pluginItem(pluginId, pluginName) {
  return {
    kind: "plugin",
    pluginId,
    pluginName,
    row: { label: "Ticket 42", send: "issues/42" },
  };
}

test("the panel renders session rows under the host group, before any plugin group", () => {
  // A session row shows the title and its highlight; the id is only its title
  // attribute, never the visible text.
  assert.match(panel, /if \(item\.kind === "session"\) \{/);
  assert.match(panel, /<Highlighted text=\{session\.title\} ranges=\{match\.ranges\} \/>/);
  assert.match(panel, /title=\{session\.id\}/);
  assert.match(panel, /aria-label=\{session\.title\}/);
  // Its detail line is the relative update time, localised.
  assert.match(
    panel,
    /formatUpdated\(sessionTimestamp\(session\.updatedAt\), locale, t\("chat\.sessionTargetNoDate"\)\)/,
  );

  // The host's own `#` group is emitted before the plugin branch, so a plugin
  // owning the same symbol lists its rows after the host's — the `@` order.
  const sessionGroup = panel.indexOf('lastGroup !== "session"');
  const pluginGroup = panel.indexOf("item.kind === \"plugin\" && lastGroup !==");
  assert.ok(sessionGroup > -1, "the host session group must be rendered");
  assert.ok(pluginGroup > sessionGroup, "the plugin group must follow the host's");
  assert.match(panel, /t\("chat\.sessionTargetGroup"\)/);
});

test("the panel names the host group and closes for an empty or dismissed list", async (t) => {
  const { vite, ComposerAutocomplete } = await loadPanel();
  t.after(() => vite.close());

  // The menu's accessible name follows the mode, so `#` announces the target
  // list rather than the slash menu.
  assert.match(panel, /ac\.mode === "session"\s*\? "chat\.sessionTargetMenu"/);
  assert.match(panel, /chat\.sessionTargetMenu/);

  // The menu mounts through `AnchoredMenu`, which portals only after mount, so
  // the closed state is what can be rendered here: no `#123` placeholder, and
  // nothing at all while the host group has no match.
  const i18n = await i18nInstance();
  const render = (ac) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ComposerAutocomplete, { anchorRef: { current: null }, ac, onAccept: () => {} }),
      ),
    );
  const closed = render(controller({ open: false, mode: null, items: [] }));
  assert.doesNotMatch(closed, /composer-ac-item|composer-model-empty/);
});

test("typing # opens the host group only when a session matches", () => {
  // The candidate source is the store's sessions, filtered by the project rule.
  assert.match(autocompleteHook, /sessionTargetCandidates\(\{/);
  assert.match(autocompleteHook, /activeSessionId: sessionId/);
  assert.match(autocompleteHook, /activeProjectPath,/);
  // A session group with no match is not opened at all, which keeps `#123` and
  // `## heading` as the ordinary text they are.
  assert.match(
    autocompleteHook,
    /trigger\.mode === "session"\s*\?\s*items\.length > 0/,
  );
  // Esc dismissal reuses the existing per-token mechanism.
  assert.match(autocompleteHook, /const close = useCallback\(\(\) => \{\s*if \(triggerKey\) setDismissedKey\(triggerKey\);/);
  // IME composition freezes the same trigger state the menu renders.
  assert.match(autocompleteHook, /const trigger = composing \? frozenRef\.current : liveTrigger;/);
});

test("accepting a session row inserts an inline target chip with one space", () => {
  // The hook reports the target instead of splicing text itself...
  assert.match(
    autocompleteHook,
    /sessionTarget: \{ sessionId: item\.session\.id, title: item\.session\.title \}/,
  );
  // ...and the completions hook splices the chip token, exactly like a file chip.
  assert.match(completionsHook, /const acceptedSessionTarget = result\.sessionTarget;/);
  assert.match(
    completionsHook,
    /sessionTargetChipInsert\(token, result\.value\[result\.cursor\]\)/,
  );
  assert.match(completionsHook, /kind: "sessionTarget", token/);
  // The chip keeps the caret after itself.
  assert.match(completionsHook, /result\.cursor \+ insert\.length/);
  // `session-targets.ts` owns the one-space rule.
  assert.match(smartStop, /export function sessionTargetChipInsert/);
});

test("the chip shows a # and stays distinguishable from a session link", () => {
  // `#title` on the chip, and a mark of its own rather than the session bubble.
  assert.match(editor, /nameSpan\.textContent = target \? `#\$\{reference\.name\}` : reference\.name;/);
  assert.match(editor, /if \(reference\.kind === "sessionTarget"\) return "sessionTarget";/);
  assert.match(editor, /sessionTarget:\s*\n?\s*'<circle/);
  // It is not editable text, and it opens that conversation on click.
  assert.match(editor, /if \(reference\.kind === "sessionTarget"\) return false;/);
  assert.match(editor, /const session = reference\.kind === "session" \|\| target;/);
});

test("submitting a target sends the #title sentence, no link and no attachment", () => {
  const id = "0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d";
  const references = [
    { path: id, name: "Review\t the\n diff ", kind: "sessionTarget", token: "\uE001" },
  ];
  const prompt = serializeComposerFileReferences("ask \uE001 now", references);
  assert.equal(prompt, `ask #Review the diff (Session ID: ${id}) now`);
  // Main must resolve nothing here: a link would attach an excerpt instead.
  assert.deepEqual(parseSessionLinks(prompt), []);

  // A target never becomes a structured attachment, and a session link keeps
  // travelling as its link exactly as before.
  assert.deepEqual(promptAttachmentsFromDraft(references), []);
  assert.deepEqual(
    promptAttachmentsFromDraft([{ path: id, name: "Review", kind: "session", token: "\uE001" }]),
    [],
  );
  assert.equal(
    serializeComposerFileReferences("look \uE001 now", [
      { path: id, name: "Review", kind: "session", token: "\uE001" },
    ]),
    `look minih-agent-desktop://session/${id} now`,
  );
});

test("the draft cache carries a target chip across a remount", async () => {
  const cache = await import("../src/lib/composer-draft-cache.ts");
  cache.resetComposerDraftCache();
  cache.captureComposerDraft(
    "s1",
    "ask \uE001",
    [
      {
        sessionId: "s1",
        path: "target-id",
        name: "Review the diff",
        kind: "sessionTarget",
        token: "\uE001",
      },
    ],
    "/work/app",
  );
  const restored = cache.readComposerDraft("s1");
  assert.equal(restored.text, "ask \uE001");
  assert.deepEqual(restored.fileReferences, [
    { path: "target-id", name: "Review the diff", kind: "sessionTarget", token: "\uE001" },
  ]);
  cache.resetComposerDraftCache();
});

test("an older draft without the new kind still restores", async () => {
  const cache = await import("../src/lib/composer-draft-cache.ts");
  cache.resetComposerDraftCache();
  // A draft written before this feature: no kind at all, and a session link.
  cache.captureComposerDraft("s1", "look \uE001 \uE002", [
    { sessionId: "s1", path: "src/a.ts", name: "a.ts", token: "\uE001" },
    { sessionId: "s1", path: "abc", name: "Session · abc", kind: "session", token: "\uE002" },
  ]);
  const restored = cache.readComposerDraft("s1");
  assert.equal(restored.text, "look \uE001 \uE002");
  assert.deepEqual(
    restored.fileReferences.map((reference) => reference.kind),
    [undefined, "session"],
  );
  cache.resetComposerDraftCache();
});

test("every locale carries the target group, menu and chip copy", async () => {
  const { catalogs } = await import("@minih-agent/i18n");
  const keys = [
    "sessionTargetMenu",
    "sessionTargetGroup",
    "sessionTargetNoDate",
    "sessionTargetChip",
  ];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      assert.equal(typeof catalog.chat[key], "string", `${locale} is missing chat.${key}`);
      assert.ok(catalog.chat[key].trim().length > 0, `${locale} chat.${key} is empty`);
    }
    // The group heading is translated, not copied; a locale that legitimately
    // shares the English word (de "Sitzungen" differs, but a future locale may
    // not) is still covered by the presence and non-blank checks above.
    if (locale === "zh-CN") {
      assert.notEqual(catalog.chat.sessionTargetGroup, catalogs.en.chat.sessionTargetGroup, locale);
    }
  }
});

/**
 * A pressable chip needs a DOM: `paintEditorValue` only creates elements, text
 * nodes, attributes and listeners, so a recorder is enough to click the chip the
 * editor really paints.
 */
function installFakeDom() {
  const makeElement = (tagName) => {
    const listeners = new Map();
    const element = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      childNodes: [],
      attributes: {},
      dataset: {},
      classList: {
        contains: (name) => String(element.className ?? "").split(/\s+/).includes(name),
      },
      setAttribute(name, value) {
        element.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.hasOwn(element.attributes, name) ? element.attributes[name] : null;
      },
      addEventListener(type, handler) {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
      },
      dispatch(type, event = {}) {
        const handlers = listeners.get(type) ?? [];
        for (const handler of handlers) {
          handler({ target: element, preventDefault() {}, stopPropagation() {}, ...event });
        }
        return handlers.length;
      },
      append(...children) {
        element.childNodes.push(...children);
      },
      appendChild(child) {
        element.childNodes.push(child);
        return child;
      },
      replaceChildren(...children) {
        element.childNodes = [...children];
      },
    };
    return element;
  };
  globalThis.document = {
    createElement: makeElement,
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
  };
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  return makeElement("div");
}

test("activating a target chip opens the session it names", async (t) => {
  const { paintEditorValue } = await import("../src/features/chat/composer/editor.ts");
  const container = installFakeDom();
  t.after(() => {
    delete globalThis.document;
    delete globalThis.Node;
  });

  // Before this fix the chip was rendered as a button whose handler returned
  // early, so clicking it (or pressing Enter on it) did nothing at all.
  const id = "0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d";
  const token = "\uE001";
  const opened = [];
  const expanded = [];
  paintEditorValue(
    container,
    `ask ${token}`,
    new Map([[token, { path: id, name: "Review the diff", kind: "sessionTarget", token }]]),
    () => "Remove",
    "Session target",
    () => {},
    (value) => expanded.push(value),
    () => {},
    (value) => opened.push(value),
  );

  const chip = container.childNodes.find((child) => child.className === "composer-chip");
  assert.ok(chip, "a target must paint as a chip");
  assert.equal(chip.getAttribute("role"), "button");
  assert.equal(chip.getAttribute("aria-label"), "Session target · Review the diff");
  assert.equal(chip.tabIndex, 0);
  assert.equal(chip.dataset.action, "open-session-reference");
  assert.equal(chip.dataset.sessionId, id);
  assert.equal(chip.dataset.token, token);
  const name = chip.childNodes.find((child) => child.className === "composer-chip-name");
  assert.equal(name.textContent, "#Review the diff");

  assert.equal(chip.dispatch("click"), 1);
  assert.deepEqual(opened, [token]);
  // Enter and Space are the same activation on the focused chip...
  chip.dispatch("keydown", { key: "Enter" });
  chip.dispatch("keydown", { key: " " });
  assert.deepEqual(opened, [token, token, token]);
  // ...but a key event bubbling from the chip's own remove button is not.
  const remove = chip.childNodes.find((child) => child.className === "composer-chip-remove");
  chip.dispatch("keydown", { key: "Enter", target: remove });
  assert.deepEqual(opened, [token, token, token]);
  // A target never expands into editable draft text.
  assert.deepEqual(expanded, []);

  // The handler the chip calls is the one that selects the conversation, and a
  // target is routed exactly like a pasted session reference.
  assert.match(
    draftHook,
    /if \(!reference \|\| \(reference\.kind !== "session" && reference\.kind !== "sessionTarget"\)\) return;/,
  );
  assert.match(
    draftHook,
    /void useAppStore\.getState\(\)\.selectSession\(reference\.path\)\.catch\(\(\) => undefined\);/,
  );
  assert.match(draftHook, /\(token\) => openSessionReferenceRef\.current\(token\)/);
});

test("a workspace switch keeps the target chip and its token", () => {
  // The hook drops references pointing into the previous workspace. A target
  // names a conversation id, not a path, so it survives like a session link —
  // run the real filter rather than restating its clauses.
  const predicate = draftHook.match(
    /const survives = \(fileReference: ComposerFileReference\) =>\n([\s\S]*?);\n/,
  )?.[1];
  assert.ok(predicate, "the workspace-switch filter must exist");
  const askedFor = [];
  const survives = new Function(
    "isPersistedScratchReference",
    `return (fileReference) => ${predicate}`,
  )((path) => {
    askedFor.push(path);
    return path.startsWith("/tmp/minih-scratch/");
  });

  const id = "0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d";
  const target = { path: id, name: "Review the diff", kind: "sessionTarget", token: "\uE001" };
  assert.equal(survives(target), true);
  // The token lives on the reference itself, so the kept chip keeps its token.
  assert.equal(target.token, "\uE001");
  assert.equal(survives({ path: "abc", name: "Session", kind: "session", token: "\uE002" }), true);
  assert.equal(survives({ path: "/tmp/minih-scratch/notes.md", name: "notes.md" }), true);
  assert.equal(
    survives({ plugin: { pluginId: "tickets", kind: "mark" }, path: "", name: "Ticket 42" }),
    true,
  );
  // A file of the old workspace is still dropped.
  assert.equal(survives({ path: "src/a.ts", name: "a.ts", token: "\uE003" }), false);
  assert.deepEqual(askedFor, ["/tmp/minih-scratch/notes.md", "src/a.ts"]);
  assert.match(draftHook, /const kept = current\.filter\(survives\);/);
});

test("typing # never asks the host for a file index", () => {
  // The source effect returns before either host round trip, so opening the `#`
  // session group costs no IPC: its rows come from the store.
  // The guard is the effect's first statement, so neither round trip starts.
  const effect = autocompleteHook.match(
    /useEffect\(\(\) => \{\s*if \(!trigger \|\| dismissed \|\| trigger\.mode === "session"\) return;([\s\S]*?)\n  \}, \[trigger\?\.mode, dismissed, workspaceKey, hasWorkspace, sessionId, fileSourceKey\]\);/,
  )?.[1];
  assert.ok(effect, "the lazy source effect must return before it fetches");
  assert.match(effect, /void fetchComposerCommands\(workspaceKey\)/);
  assert.match(effect, /api\s*\.\s*fsIndex\(sessionId\)/);
});
