/**
 * The H5 timeline renders an answer as Markdown and a user's own turn as plain
 * text.
 *
 * A phone reading a long answer needs the structure the model wrote — headings,
 * lists, tables, fenced code — and before this the client flattened all of it
 * into one unwrapped string. The asymmetry is deliberate: a user's text is
 * whatever they typed, so `**not bold**` in their own message stays exactly
 * that, while the same text in an answer is emphasis.
 *
 * Rendered through `react-dom/server` on purpose. This package runs no DOM
 * environment, and the question here is what the component produces, not what a
 * browser does with it afterwards.
 */
import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test } from "vitest";

import type { TimelineItem } from "../../lib/timeline-types.js";
import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";

import type { ChatTimelineProps } from "./ChatTimeline.js";
import { ChatTimeline } from "./ChatTimeline.js";

async function render(items: TimelineItem[], extraProps?: Partial<ChatTimelineProps>): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng: DEFAULT_LOCALE,
    resources: buildResources(),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(ChatTimeline, { items, ...extraProps })),
  );
}

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    id: "item-1",
    turnId: "turn-1",
    itemType: "message",
    status: "completed",
    text: "",
    ...overrides,
  } as TimelineItem;
}

test("an answer renders its Markdown instead of one flat string", async () => {
  const html = await render([
    item({ role: "assistant", text: "Plain **bold** and a `span`." }),
  ]);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>span<\/code>/);
  assert.match(html, /<div class="rm-prose">/);
});

test("an answer's headings, lists and fenced code keep their structure", async () => {
  const html = await render([
    item({
      role: "assistant",
      text: "## Result\n\n- first\n- second\n\n```js\nconst a = 1;\n```",
    }),
  ]);
  assert.match(html, /<h2>Result<\/h2>/);
  assert.match(html, /<ul>[\s\S]*<li>first<\/li>/);
  assert.match(html, /<pre><code class="language-js">const a = 1;/);
});

test("a table is wrapped so a phone can scroll it sideways", async () => {
  const html = await render([
    item({
      role: "assistant",
      text: "| left | right |\n| --- | --- |\n| 1 | 2 |",
    }),
  ]);
  assert.match(html, /<div class="rm-table-wrap"><table>/);
  assert.match(html, /<th>left<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test("a user's own turn stays plain text, Markdown characters included", async () => {
  const html = await render([
    item({ role: "user", text: "Keep **this** literal, with a `span`." }),
  ]);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /rm-prose/);
  // Only the inline-code convention the composer shares is applied.
  assert.match(html, /Keep \*\*this\*\* literal, with a <code[^>]*>span<\/code>/);
});

test("a run of blank lines in a user turn is still one plain string", async () => {
  const html = await render([item({ role: "user", text: "line one\n\n\nline two" })]);
  assert.match(html, /line one\n\n\nline two/);
  assert.doesNotMatch(html, /<p>/);
});

test("no answer text reaches the page as raw HTML", async () => {
  const html = await render([
    item({ role: "assistant", text: "<img src=x onerror=alert(1)> and **fine**" }),
  ]);
  // `react-markdown` drops raw HTML unless a rehype plugin opts in, so the
  // tag reads as text and the rest still renders.
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>fine<\/strong>/);
});

test("consecutive tool calls stay folded in one ToolRun even when thinking-only or empty assistant items sit between them", async () => {
  const html = await render([
    item({ id: "t1", itemType: "tool", role: "tool", toolName: "Bash", toolArgs: { command: "ls" }, status: "completed" }),
    item({ id: "m1", itemType: "message", role: "assistant", text: "", thinking: "checking next file" }),
    item({ id: "m2", itemType: "message", role: "assistant", text: "" }),
    item({ id: "t2", itemType: "tool", role: "tool", toolName: "Bash", toolArgs: { command: "pwd" }, status: "completed" }),
  ]);
  assert.match(html, /2 commands/);
});

test("an html code fence renders inline inside a sandboxed srcDoc iframe", async () => {
  const html = await render([
    item({
      role: "assistant",
      text: "Here is the page:\n\n```html\n<!doctype html><title>Demo Card</title><h1>Hello</h1>\n```",
    }),
  ]);
  assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.match(html, /Demo Card/);
});

test("a file:// HTML link renders as a safe button instead of an empty href anchor that reloads the root screen", async () => {
  const html = await render([
    item({
      role: "assistant",
      text: "[打开页面 · 灵感](file:///Users/minih/scratch/demo.html)",
    }),
  ]);
  assert.doesNotMatch(html, /<a[^>]*href=""/);
  assert.match(html, /<button type="button"/);
  assert.match(html, /打开页面 · 灵感/);
});
test("user message renders copy and edit-resend action buttons", async () => {
  const html = await render([item({ role: "user", text: "Hello AI" })], {
    onEditResendMessage: () => {},
  });
  assert.match(html, /aria-label="Copy text"/);
  assert.match(html, /aria-label="Edit and resend"/);
});

test("assistant message renders copy and regenerate buttons on latest completed reply", async () => {
  const html = await render(
    [
      item({ id: "u1", role: "user", text: "What is 1+1?" }),
      item({ id: "a1", role: "assistant", text: "It is 2." }),
    ],
    {
      onRegenerateMessage: () => {},
    },
  );
  assert.match(html, /aria-label="Copy text"/);
  assert.match(html, /aria-label="Regenerate reply"/);
});

test("a failed turn shows the status and the provider's sentence, not its JSON body", async () => {
  const html = await render([], {
    lastFailure: {
      kind: "turn.failed",
      turnId: "turn-1",
      code: "INVALID_ARGUMENT",
      message:
        '401: {"message":"Authentication Fails, Your api key: ****f073 is invalid (request_id: 595f21d0)","type":"authentication_error"}',
    },
  });
  // The row reads as one sentence a person can act on...
  assert.match(html, /Run failed: 401 · Authentication Fails, Your api key: \*\*\*\*f073 is invalid/);
  // ...and carries neither the envelope nor the id that names the call.
  assert.doesNotMatch(html, /request_id|authentication_error|\{&quot;message&quot;/);
});
