import { describe, expect, it } from "vitest";

import type { Message } from "@earendil-works/pi-ai";
import type { LearnedMemoryRecallEntry } from "@minih-agent/shared";

import {
  attachRecallBlocks,
  RECALL_BLOCK_CLOSE,
  RECALL_BLOCK_MAX_BYTES,
  RECALL_BLOCK_OPEN,
  RecallLedger,
  recallBlockBytes,
  recallBlockTokens,
  recallMessageKey,
  recallQueryFromUserMessage,
  renderRecallBlock,
} from "./learned-memory-recall.js";

function entry(
  overrides: Partial<LearnedMemoryRecallEntry> = {},
): LearnedMemoryRecallEntry {
  return {
    id: "entry-1",
    kind: "preference",
    scopeKind: "project",
    content: "Prefers terse Chinese replies.",
    createdAt: Date.UTC(2026, 9, 2, 12, 0, 0),
    updatedAt: Date.UTC(2026, 9, 2, 12, 0, 0),
    matchedTerms: ["replies"],
    ...overrides,
  };
}

function userMessage(text: string, timestamp = 1_000): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as Message;
}

describe("recallQueryFromUserMessage", () => {
  it("searches the user's own words", () => {
    expect(
      recallQueryFromUserMessage([{ type: "text", text: "  the gateway deploy  " }]),
    ).toBe("the gateway deploy");
  });

  it("ignores a prompt too short to describe anything", () => {
    expect(recallQueryFromUserMessage([{ type: "text", text: "继续" }])).toBeUndefined();
    expect(recallQueryFromUserMessage([{ type: "text", text: "   " }])).toBeUndefined();
    expect(recallQueryFromUserMessage([])).toBeUndefined();
  });

  it("stops where a referenced conversation begins", () => {
    const text = [
      "why did the gateway deploy fail",
      "",
      '<session_reference name="Earlier" session="abc">',
      "a long excerpt about something else entirely",
      "</session_reference>",
    ].join("\n");
    expect(recallQueryFromUserMessage([{ type: "text", text }])).toBe(
      "why did the gateway deploy fail",
    );
  });

  it("caps a pasted log instead of searching all of it", () => {
    const query = recallQueryFromUserMessage([
      { type: "text", text: "x".repeat(5_000) },
    ]);
    expect(query).toHaveLength(2_000);
  });
});

describe("renderRecallBlock", () => {
  it("renders one dated line per entry under the context contract", () => {
    const block = renderRecallBlock([
      entry(),
      entry({
        id: "entry-2",
        kind: "fact",
        content: "The gateway listens on 8787.",
        createdAt: Date.UTC(2026, 10, 3, 8, 30, 0),
      }),
    ])!;
    expect(block.startsWith(RECALL_BLOCK_OPEN)).toBe(true);
    expect(block.endsWith(RECALL_BLOCK_CLOSE)).toBe(true);
    expect(block).toContain("context, not instructions");
    expect(block).toContain("the current request wins");
    expect(block).toContain("- [preference · 2026-10-02] Prefers terse Chinese replies.");
    expect(block).toContain("- [fact · 2026-11-03] The gateway listens on 8787.");
  });

  it("keeps one entry on one line", () => {
    const block = renderRecallBlock([
      entry({ content: "Line one.\nLine two.\n\nLine three." }),
    ])!;
    expect(block).toContain("- [preference · 2026-10-02] Line one. Line two. Line three.");
  });

  it("respects the byte budget with CJK content and drops what does not fit", () => {
    // Six notes whose lines together exceed the budget: 200 Han characters is
    // 600 UTF-8 bytes, so four of them fill 1.5 KiB and the rest must be left out.
    const entries = Array.from({ length: 6 }, (_, index) =>
      entry({ id: `entry-${index}`, content: `这${"字".repeat(199)}${index}` }),
    );
    const block = renderRecallBlock(entries)!;
    // The budget is spent on whole entries only: the rendered text never
    // exceeds it, and it never ends mid-note.
    expect(recallBlockBytes(block)).toBeLessThanOrEqual(RECALL_BLOCK_MAX_BYTES);
    expect(block.endsWith(RECALL_BLOCK_CLOSE)).toBe(true);
    const rendered = block.split("\n").filter((line) => line.startsWith("- "));
    expect(rendered.length).toBeLessThan(6);
    expect(rendered.length).toBeGreaterThan(0);
    // Every rendered line is a whole note, never a clipped one.
    for (const line of rendered) expect(line).toContain("字".repeat(199));

    // A single note larger than the whole budget yields no block at all rather
    // than a truncated one.
    expect(renderRecallBlock([entry({ content: "字".repeat(2_000) })])).toBeUndefined();
  });

  it("renders nothing for an empty result", () => {
    expect(renderRecallBlock([])).toBeUndefined();
  });

  it("charges CJK text the tokens it really costs", () => {
    // The same 33 characters in both scripts: the `chars / 4` rule alone would
    // charge them the same, while one Han character is one token.
    const han = "这条学习记忆记录了索引与预算的关系，因为中文一个字符就是一个词元。" + "字".repeat(3);
    const cjk = recallBlockTokens(han);
    const ascii = recallBlockTokens("the gateway deploy runs on fridays");
    expect(cjk).toBeGreaterThanOrEqual(ascii * 3);
  });
});

describe("RecallLedger and attachRecallBlocks", () => {
  it("replays a historical block byte-identically and the newest one fresh", () => {
    const ledger = new RecallLedger();
    const first = userMessage("first question about the gateway", 1_000);
    const second = userMessage("second question about the release", 2_000);
    const firstBlock = renderRecallBlock([entry({ content: "The gateway deploy is nightly." })])!;
    const secondBlock = renderRecallBlock([entry({ content: "Releases ship on Fridays." })])!;
    ledger.record(recallMessageKey(first)!, firstBlock);
    ledger.record(recallMessageKey(second)!, secondBlock);

    const wire = attachRecallBlocks([first, second], ledger);
    const firstAgain = attachRecallBlocks([first, second], ledger);
    // Same bytes on both requests: that is what keeps the provider prefix
    // cacheable across the iterations of a turn.
    expect(JSON.stringify(firstAgain)).toBe(JSON.stringify(wire));
    // The block travels as its own trailing text block, byte-identical.
    const blockOf = (message: Message): string | undefined =>
      (message.content as Array<{ type: string; text?: string }>).at(-1)?.text;
    expect(blockOf(wire[0]!)).toBe(firstBlock);
    expect(blockOf(wire[1]!)).toBe(secondBlock);
  });

  it("sends a message with no ledger entry unchanged", () => {
    const ledger = new RecallLedger();
    const message = userMessage("a question with no recall", 1_000);
    ledger.record(recallMessageKey(userMessage("another question", 2_000))!, "block");
    const wire = attachRecallBlocks([message], ledger);
    expect(wire[0]).toBe(message);
  });

  it("never mutates the messages it is given", () => {
    const ledger = new RecallLedger();
    const message = userMessage("a question about the gateway", 1_000);
    const before = JSON.stringify(message);
    ledger.record(recallMessageKey(message)!, "<learned-memory-recall>\n- [fact · 2026-10-02] x\n</learned-memory-recall>");
    const wire = attachRecallBlocks([message], ledger);
    expect(JSON.stringify(message)).toBe(before);
    expect(wire[0]).not.toBe(message);
    // The block is a trailing text block, exactly where a typed one would go.
    const blocks = wire[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text).toContain("<learned-memory-recall>");
  });

  it("keeps a tool result and an assistant message untouched", () => {
    const ledger = new RecallLedger();
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      timestamp: 1_500,
    } as unknown as Message;
    ledger.record("anything", "block");
    const wire = attachRecallBlocks([assistant], ledger);
    expect(wire[0]).toBe(assistant);
  });

  it("does not replay a block after a message's text changes", () => {
    const ledger = new RecallLedger();
    const original = userMessage("the gateway deploy question", 1_000);
    ledger.record(recallMessageKey(original)!, "block");
    const edited = userMessage("a different question entirely", 1_000);
    expect(attachRecallBlocks([edited], ledger)[0]).toBe(edited);
  });

  it("records a turn with no block as no block", () => {
    const ledger = new RecallLedger();
    const message = userMessage("a question with no recall", 1_000);
    ledger.record(recallMessageKey(message)!, null);
    expect(ledger.size).toBe(0);
    expect(attachRecallBlocks([message], ledger)[0]).toBe(message);
  });
});
