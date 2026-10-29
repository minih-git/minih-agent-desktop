import type { Message } from "@earendil-works/pi-ai";
import type { UiMessage } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";
import { omitOversizedImages } from "./image-admission.js";
import { convertToLlm } from "./pi-runtime-messages.js";
import { toolResultFromUi } from "./runtime.js";

function image(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}
const tall = image(780, 14182);
const normal = image(1688, 1514);
const notice = "[Image omitted: 780x14182 px exceeds the 8000 px longest-edge limit for model input.]";

describe("model-facing pixel admission", () => {
  it("keeps image placement while leaving the persisted input unchanged", () => {
    const messages: Message[] = [{ role: "user", timestamp: 1, content: [
      { type: "text", text: "before" },
      { type: "image", data: tall, mimeType: "image/png" },
      { type: "image", data: normal, mimeType: "image/png" },
    ] }];
    const original = structuredClone(messages);
    expect(omitOversizedImages(messages)[0]?.content).toEqual([
      { type: "text", text: "before" }, { type: "text", text: notice },
      { type: "image", data: normal, mimeType: "image/png" },
    ]);
    expect(messages).toEqual(original);
  });
  it("keeps identity for admissible and unknown geometry", () => {
    const messages: Message[] = [{ role: "user", timestamp: 1, content: [
      { type: "image", data: image(8000, 100), mimeType: "image/png" },
      { type: "image", data: "unknown-image", mimeType: "image/png" },
    ] }];
    expect(omitOversizedImages(messages)).toBe(messages);
  });
  it("heals oversized Read images when reopening history before a provider request", () => {
    const row = {
      id: "tool-1", role: "tool", content: "", toolName: "read", toolCallId: "call-1", toolStatus: "done",
      toolResult: { path: "page.png", text: "Screenshot", images: [{ data: tall, mimeType: "image/png" }] },
    } as unknown as UiMessage;
    const original = structuredClone(row);
    const restored = toolResultFromUi(row, 1);
    expect(restored.content.some((block) => block.type === "image")).toBe(true);
    const outgoing = convertToLlm([restored])[0];
    expect(outgoing?.role).toBe("toolResult");
    expect(outgoing?.content).toContainEqual({ type: "text", text: notice });
    expect((outgoing?.content as Array<{ type: string }>).some((block) => block.type === "image")).toBe(false);
    expect(row).toEqual(original);
    expect(restored.content.some((block) => block.type === "image")).toBe(true);
  });
});
