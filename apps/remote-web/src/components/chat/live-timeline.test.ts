import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test } from "vitest";

import type { TimelineItem } from "../../lib/timeline-types.js";
import { createInitialTimelineState, timelineReducer } from "../../lib/timeline.js";
import { buildResources } from "../../locales/index.js";
import { ChatTimeline, type ChatTimelineProps } from "./ChatTimeline.js";

async function render(props: ChatTimelineProps): Promise<string> {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: buildResources(), keySeparator: false, nsSeparator: false });
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(ChatTimeline, props)),
  );
}

const tool: TimelineItem = {
  id: "tool-1", turnId: "turn-1", itemType: "tool", role: "tool",
  toolName: "Read", text: "config contents", status: "completed",
};
const thought: TimelineItem = {
  id: "thought-1", turnId: "turn-1", itemType: "message", role: "assistant",
  text: "", thinking: "Checking the next dependency", status: "streaming",
};

test("the active thought stays visible outside the preceding folded tools", async () => {
  const html = await render({ items: [tool, thought], activeTurnId: "turn-1", responding: true });
  assert.match(html, /aria-expanded="true"/);
  assert.ok(html.indexOf("</details>") < html.indexOf('data-item-id="thought-1"'));
  assert.match(html, /Checking the next dependency/);
});

test("the latest thought stays visible while the following tool runs", async () => {
  const html = await render({
    items: [{ ...thought, status: "completed" }, { ...tool, status: "streaming", toolStatus: "running" }],
    activeTurnId: "turn-1", responding: true,
  });
  assert.match(html, /aria-expanded="true"/);
  assert.ok(html.indexOf("Checking the next dependency") < html.indexOf("<details"));
});

test("thinking beside answer text opens during the active response", async () => {
  const html = await render({
    items: [{ ...thought, text: "Here is the first part" }],
    activeTurnId: "turn-1", responding: true,
  });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Checking the next dependency/);
});

test("an active turn with no assistant content still shows a response indicator", async () => {
  const html = await render({ items: [], activeTurnId: "turn-1", responding: true });
  assert.match(html, /role="status"/);
  assert.match(html, /Responding/);
  assert.match(html, /motion-reduce:animate-none/);
  assert.doesNotMatch(html, /No messages yet/);
});

test("idle and decision-waiting timelines do not claim a response is arriving", async () => {
  for (const activeTurnId of [undefined, "turn-1"]) {
    const html = await render({ items: [tool], activeTurnId, responding: false });
    assert.doesNotMatch(html, /Responding/);
  }
});

test("old-turn and completed thinking keep the historical collapsed behavior", async () => {
  for (const activeTurnId of [undefined, "turn-2"]) {
    const html = await render({
      items: [{ ...thought, status: "completed" }], activeTurnId, responding: Boolean(activeTurnId),
    });
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /Checking the next dependency/);
  }
});

test("live thinking deltas project before a durable message_end arrives", () => {
  let state = { ...createInitialTimelineState(), attached: true };
  const message = { id: "live-message", role: "assistant" as const, content: "", createdAt: "" };
  for (const [index, deltaThinking] of ["First thought. ", "Next thought."].entries()) {
    state = timelineReducer(state, {
      type: "event",
      envelope: {
        eventId: `delta-${index}`, scope: "session", sessionId: "session-1", turnId: "turn-1",
        epoch: "epoch-1", afterSequence: 0, revision: 0, occurredAt: "", kind: "item.delta",
        payload: { itemType: "message", itemId: message.id,
          event: { type: "message_update", stream: "delta", message, deltaThinking } },
      },
    });
  }
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].thinking, "First thought. Next thought.");
  assert.equal(state.items[0].status, "streaming");
});
