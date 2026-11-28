import type { UiMessage } from "@minih-agent/shared";
import { toolResultImages, type ToolImageRef } from "./tool-result-images";

/**
 * One image a turn's tool calls returned, keyed for a single strip.
 *
 * A turn runs many tool calls, and each one numbers its own images from zero.
 * The strip is one list across all of them, so the position becomes the
 * strip's position and `key` keeps React identity apart: two messages that
 * both returned `index: 0` are two tiles, not one.
 */
export type TurnToolImage = ToolImageRef & { key: string };

type ToolImageMessage = Pick<UiMessage, "id" | "toolName" | "toolResult">;

/**
 * Every image a turn's non-generating tool calls returned, in reading order.
 *
 * `GenerateImages` is excluded on purpose: a generated batch is the turn's
 * answer, not incidental evidence, and keeps its own large gallery. Everything
 * else — a Read of a screenshot, an MCP capture, a plugin's image resource —
 * is context the reader glances at, so those become one strip of small tiles.
 */
export function turnToolImages(messages: readonly ToolImageMessage[]): TurnToolImage[] {
  const images: TurnToolImage[] = [];
  for (const message of messages) {
    if (message.toolName === "GenerateImages") continue;
    for (const image of toolResultImages(message)) {
      images.push({
        ...image,
        index: images.length,
        key: `${message.id}:${image.index}`,
      });
    }
  }
  return images;
}
