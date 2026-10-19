import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * What a ToolSearch row and a generic string array look like once expanded.
 *
 * ToolSearch answers with tool names, and a tool is not a file: the row lists
 * the names as text, with no preview tooltip and no click-to-open, and the same
 * name is not repeated once per result field. A plugin or MCP tool's plain
 * string array (`tags: ["alpha", "beta"]`) is text too, while the entries that
 * really are file paths keep opening.
 *
 * This renders the production components through Vite SSR, so the assertions
 * read the markup a user gets rather than the source that produces it.
 */

const toolSearchMessage = (details) => ({
  id: "tool-search-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-19T00:00:00.000Z",
  status: "complete",
  toolName: "ToolSearch",
  toolCallId: "tool-search-call-1",
  toolStatus: "success",
  toolArgs: { query: details.query },
  toolResult: {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  },
});

const pluginMessage = (details) => ({
  id: "plugin-call-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-19T00:00:00.000Z",
  status: "complete",
  toolName: "pi.some-plugin",
  toolCallId: "plugin-call-1",
  toolStatus: "success",
  toolResult: {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  },
});

/** The entries the markup offers as links, in document order. */
const linkedEntries = (markup) =>
  [...markup.matchAll(/class="tool-file-item is-linked"[^>]*>([^<]*)</g)].map(
    (match) => match[1],
  );

/** The entries the markup renders as plain text, in document order. */
const plainEntries = (markup) =>
  [...markup.matchAll(/<span class="tool-file-item">([^<]*)<\/span>/g)].map(
    (match) => match[1],
  );

test("an activated ToolSearch row lists tool names as text, never as files", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const markup = ssr.render(
    createElement(ToolRow, {
      // Detailed density opens the payload, which is what the user expands.
      autoOpen: true,
      message: toolSearchMessage({
        query: "remember",
        matches: ["MemoryRemember"],
        activated: ["MemoryRemember"],
        addedToolNames: ["MemoryRemember"],
      }),
    }),
  );

  // The name is shown once, and nothing on the row can be clicked open.
  assert.equal(markup.split("MemoryRemember").length - 1, 1, markup);
  assert.deepEqual(linkedEntries(markup), [], markup);
  assert.deepEqual(plainEntries(markup), ["MemoryRemember"], markup);
  assert.doesNotMatch(markup, /previewFile/);
  // The runtime's own bookkeeping never reaches the screen.
  assert.doesNotMatch(markup, /addedToolNames/);
  assert.doesNotMatch(markup, /activated|matches/);
});

test("a ToolSearch row says when the matches were already available", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const blocks = buildToolPresentation(
    toolSearchMessage({
      query: "preview",
      matches: ["BrowserPreview", "PluginCheck"],
      activated: [],
    }),
    { hideSummaryArg: true },
  );
  const markup = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  assert.deepEqual(plainEntries(markup), ["BrowserPreview", "PluginCheck"], markup);
  assert.deepEqual(linkedEntries(markup), [], markup);
  assert.match(markup, /Already available/);
});

test("a ToolSearch row with no match explains itself", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const blocks = buildToolPresentation(
    toolSearchMessage({ query: "nothing like this", matches: [], activated: [] }),
    { hideSummaryArg: true },
  );
  const markup = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  assert.match(markup, /No matching on-demand tool\./);
  assert.deepEqual(plainEntries(markup), [], markup);
  assert.deepEqual(linkedEntries(markup), [], markup);
});

test("a plugin string array links its file paths and leaves the rest as text", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const blocks = buildToolPresentation(
    pluginMessage({ tags: ["alpha", "beta"], files: ["src/a.ts", "README.md"] }),
    { hideSummaryArg: true },
  );
  const markup = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  assert.deepEqual(plainEntries(markup), ["alpha", "beta"], markup);
  assert.deepEqual(linkedEntries(markup).sort(), ["README.md", "src/a.ts"], markup);
});

/*
 * The same failure shape through the real row: an interrupted ToolSearch keeps
 * the row's failed status, so its body must not say that nothing matched, and
 * nothing on it may look like a file to open.
 */
test("an interrupted ToolSearch row does not say that nothing matched", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const blocks = buildToolPresentation(
    {
      id: "tool-search-aborted",
      role: "tool",
      content: "",
      createdAt: "2026-10-19T00:00:00.000Z",
      status: "complete",
      toolName: "ToolSearch",
      toolCallId: "tool-search-call-aborted",
      toolStatus: "error",
      toolArgs: { query: "remember" },
      toolResult: {
        content: [{ type: "text", text: "Operation aborted" }],
        details: {},
      },
    },
    { hideSummaryArg: true },
  );
  const markup = ssr.render(createElement(ToolDetailBlocks, { blocks }));

  assert.doesNotMatch(markup, /No matching on-demand tool/);
  assert.doesNotMatch(markup, /Activated for the next model turn|Already available/);
  assert.deepEqual(linkedEntries(markup), [], markup);
  assert.deepEqual(plainEntries(markup), [], markup);
});
