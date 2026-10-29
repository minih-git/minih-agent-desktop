/** Pixel admission at the last model-facing projection, including old history. */
import type { Message } from "@earendil-works/pi-ai";
import { imageExceedsInlineDimensions, omittedImageNotice, probeBase64ImageDimensions } from "@minih-agent/shared";

type ContentBlock = Exclude<Message["content"], string>[number];

function admittedBlocks<T extends ContentBlock>(content: T[]): T[] {
  let next: T[] | undefined;
  content.forEach((block, index) => {
    if (block.type !== "image" || typeof block.data !== "string") return;
    const dimensions = probeBase64ImageDimensions(block.data);
    if (!imageExceedsInlineDimensions(dimensions)) return;
    next ??= content.slice();
    next[index] = { type: "text", text: omittedImageNotice(dimensions) } as T;
  });
  return next ?? content;
}

/** Preserve source identity when no known oversized image needs replacement. */
export function omitOversizedImages(messages: Message[]): Message[] {
  let next: Message[] | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "toolResult") return;
    if (!Array.isArray(message.content)) return;
    const content = admittedBlocks(message.content as ContentBlock[]);
    if (content === message.content) return;
    next ??= messages.slice();
    next[index] = { ...message, content } as Message;
  });
  return next ?? messages;
}
