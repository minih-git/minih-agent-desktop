import { expect, it, vi } from "vitest";
import type { Api, Context, Model, Models } from "@earendil-works/pi-ai";
import { SideNoteAnswers } from "./side-note-answer.js";
import * as oneShot from "./one-shot-complete.js";

it("freezes tool-free reference text before awaiting the model and isolates lifecycle", async () => {
  let resolve!: (result: { text: string }) => void;
  const completion = vi.spyOn(oneShot, "completeOneShot").mockImplementation(() => new Promise(done => { resolve = done; }));
  const answers = new SideNoteAnswers();
  const messages = [{ role: "user" as const, content: "Original task", timestamp: 1 }];
  const input = {
    provider: { id: "provider", name: "provider", modelId: "model", apiKey: "", supportsReasoning: false, supportedThinkingLevels: ["off" as const] },
    model: {} as Model<Api>, models: {} as Models, messages, question: "Side question", history: [], thinkingLevel: "off" as const,
  };
  try {
    const pending = answers.answer(input);
    const [, context, , options] = completion.mock.calls[0]!;
    messages[0]!.content = "Changed task after snapshot";
    expect(JSON.stringify(context)).toContain("Original task");
    expect(JSON.stringify(context)).not.toContain("Changed task after snapshot");
    expect((context as Context).tools).toEqual([]);
    await expect(answers.answer(input)).rejects.toMatchObject({ errorCode: "AGENT_BUSY" });
    answers.dispose();
    expect(options?.signal?.aborted).toBe(true);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    resolve({ text: "Independent answer" });
    await rejected;
  } finally { completion.mockRestore(); }
});
