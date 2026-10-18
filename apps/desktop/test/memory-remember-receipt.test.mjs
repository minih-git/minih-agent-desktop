import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

// ADR agent-long-term-memory §3.1: a saved memory is a receipt, not a generic
// tool row. The row shows what was written, where it applies, and the two
// actions that matter. Server rendering runs no effects, so these assertions
// are about the first frame: what the user reads before pressing anything.

function rememberMessage(overrides = {}) {
  return {
    id: "memory-remember-1",
    role: "tool",
    content: "",
    createdAt: "2026-10-09T00:00:00.000Z",
    status: "complete",
    toolName: "MemoryRemember",
    toolCallId: "memory-call-1",
    toolStatus: "success",
    toolArgs: { content: "Prefers terse Chinese replies.", kind: "preference" },
    toolResult: {
      content: [{ type: "text", text: "Saved." }],
      details: {
        entry: {
          id: "entry-1",
          kind: "preference",
          scope: "project",
          content: "Prefers terse Chinese replies.",
          revision: 3,
        },
        duplicate: false,
        note: "Saved. It applies from the next session.",
      },
    },
    ...overrides,
  };
}

test("a saved memory renders as a receipt with the note, its scope, and undo", async (t) => {
  const ssr = await slotSsr(t, {
    translationOverrides: {
      memory: {
        ...undefined,
        rememberSaved: "Saved to learned memory",
        rememberScopeProject: "This project",
        rememberNote: "It applies from your next session.",
        rememberUndo: "Undo",
        edit: "Edit",
        kind: { preference: "Preference" },
      },
    },
  });
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const html = ssr.render(createElement(ToolRow, { message: rememberMessage() }));

  assert.match(html, /data-memory-entry="entry-1"/);
  assert.match(html, /Prefers terse Chinese replies\./);
  assert.match(html, /Saved to learned memory/);
  assert.match(html, /This project/);
  assert.match(html, /Preference/);
  assert.match(html, /It applies from your next session\./);
  assert.match(html, /Undo/);
  assert.match(html, /Edit/);
});

test("a refused memory says why, by its stable code, and never repeats the text", async (t) => {
  const ssr = await slotSsr(t, {
    translationOverrides: {
      memory: {
        rememberSaved: "Saved to learned memory",
        rememberRefused: "Not saved: {{reason}}",
        reason: { MEMORY_CREDENTIAL_DETECTED: "it looks like a credential" },
      },
    },
  });
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
  const html = ssr.render(
    createElement(ToolRow, {
      message: rememberMessage({
        toolStatus: "error",
        isError: true,
        toolArgs: { content: `The key is ${secret}`, kind: "fact" },
        toolResult: {
          content: [
            {
              type: "text",
              text: "memory content looks like a credential and was not stored",
            },
          ],
          details: {
            error: "memory content looks like a credential and was not stored",
            code: "MEMORY_CREDENTIAL_DETECTED",
          },
        },
      }),
    }),
  );
  assert.match(html, /Not saved: it looks like a credential/);
  assert.doesNotMatch(html, new RegExp(secret));
  assert.doesNotMatch(html, /looks like a credential and was not stored/);
});

test("a duplicate says nothing changed but still offers the actions", async (t) => {
  const ssr = await slotSsr(t, {
    translationOverrides: {
      memory: {
        rememberDuplicate: "Already saved",
        rememberScopeUser: "All projects",
        rememberUndo: "Undo",
        edit: "Edit",
        kind: { preference: "Preference" },
        rememberNote: "It applies from your next session.",
      },
    },
  });
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const message = rememberMessage();
  message.toolResult.details.duplicate = true;
  message.toolResult.details.entry.scope = "user";
  const html = ssr.render(createElement(ToolRow, { message }));
  assert.match(html, /Already saved/);
  assert.match(html, /All projects/);
  assert.match(html, /Undo/);
  assert.match(html, /Edit/);
});
