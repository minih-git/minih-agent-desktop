/** Shared model-visible content restoration for parent and delegated history.
 * Each caller retains its own details, errors, and missing-result placeholder. */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { isRecord } from "./agent-messages.js";

export function hostContentBlockText(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource" && isRecord(block.resource) && typeof block.resource.text === "string") {
    return block.resource.text;
  }
  if (block.type === "resource_link" && typeof block.uri === "string") {
    const name = typeof block.name === "string" && block.name.trim() ? `${block.name.trim()}: ` : "";
    return `[resource link] ${name}${block.uri}`;
  }
  return undefined;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

function appendContentBlocks(blocks: ToolResultMessage["content"], entries: readonly unknown[]): void {
  for (const block of entries) {
    if (!isRecord(block)) continue;
    const text = hostContentBlockText(block);
    if (text !== undefined) blocks.push({ type: "text", text });
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
}

/** Restore canonical content, strings, and Host Read's top-level images.
 * Binary image payloads remain image blocks, never JSON prompt text. */
export function restoredToolResultContent(raw: unknown): ToolResultMessage["content"] {
  const blocks: ToolResultMessage["content"] = [];
  if (isRecord(raw) && Array.isArray(raw.content)) appendContentBlocks(blocks, raw.content);
  else if (Array.isArray(raw)) appendContentBlocks(blocks, raw);
  else if (typeof raw === "string" && raw.trim()) blocks.push({ type: "text", text: raw });
  else if (raw !== undefined && raw !== null) {
    if (isRecord(raw) && Array.isArray(raw.images)) {
      const rest = { ...raw };
      delete rest.images;
      blocks.push({ type: "text", text: safeJson(rest) });
      for (const image of raw.images) {
        if (isRecord(image) && typeof image.data === "string" && typeof image.mimeType === "string") {
          blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
      }
    } else blocks.push({ type: "text", text: safeJson(raw) });
  }
  return blocks;
}
