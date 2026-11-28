import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { toolResultImages } from "../src/features/chat/transcript/tool-result-images.ts";
import {
  IMAGE_STRIP_DRAG_THRESHOLD_PX,
  beginImageStripDrag,
  imageStripDragBlocksClick,
  moveImageStripDrag,
} from "../src/features/chat/transcript/image-strip-drag.ts";
import { slotSsr } from "./helpers/slot-ssr.mjs";

// `turn-tool-images` imports its sibling without an extension, as renderer
// sources do; the hook resolves that, so it is loaded after registering.
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { turnToolImages } = await import("../src/features/chat/transcript/turn-tool-images.ts");

const image = { type: "image", data: "cG5n", mimeType: "image/png" };
const message = (toolResult, toolName = "Read") => ({ toolName, toolResult });

test("Read, canonical MCP/plugin blocks and embedded MCP resources produce inline images", () => {
  for (const result of [
    { path: "shot.png", images: [image] },
    { content: [{ type: "text", text: "Screenshot" }, image], details: { status: "ok" } },
    [image],
    { content: [{ type: "resource", resource: { blob: image.data, mimeType: image.mimeType } }] },
    { content: { images: [image] } },
  ]) {
    assert.deepEqual(toolResultImages(message(result)), [
      { index: 0, dataUrl: "data:image/png;base64,cG5n", mimeType: "image/png" },
    ]);
  }
});

test("mirrored details do not duplicate images and distinct images preserve their order", () => {
  const second = { ...image, data: "dHdv" };
  assert.deepEqual(toolResultImages(message({ content: [image, second], details: { images: [image, second] } }))
    .map((item) => item.dataUrl), ["data:image/png;base64,cG5n", "data:image/png;base64,dHdv"]);
});

test("explicit local references use the host reader, never remote URLs or text guesses", () => {
  assert.deepEqual(toolResultImages(message({ images: [{ path: "/workspace/a.png", mimeType: "image/png" }, { ref: "attachments/hash", mimeType: "image/webp" }] })), [
    { index: 0, path: "/workspace/a.png", mimeType: "image/png" },
    { index: 1, path: "attachments/hash", mimeType: "image/webp" },
  ]);
  assert.equal(toolResultImages(message({ path: "C:\\work\\a.jpg" }))[0].path, "C:\\work\\a.jpg");
  for (const path of ["https://example.com/a.png", "file:///etc/secret.png", "data:image/png;base64,cG5n", "/etc/passwd"]) {
    assert.deepEqual(toolResultImages(message({ path })), []);
  }
  assert.deepEqual(toolResultImages(message({ content: [{ type: "text", text: "/workspace/a.png" }] })), []);
});

test("unsafe, malformed, unsupported and oversized inline image data is not rendered", () => {
  for (const value of [
    { ...image, mimeType: "image/svg+xml" },
    { ...image, mimeType: "text/html" },
    { ...image, data: "" },
    { ...image, data: "<script>" },
    { ...image, data: "a".repeat(24 * 1024 * 1024) },
    { ...image, data: 42 },
    null,
  ]) assert.deepEqual(toolResultImages(message({ images: [value] })), []);
});

test("generated and edited image batches retain success indices and skip failures", () => {
  const result = { details: { kind: "generated-images", results: [
    { status: "failed", errorCode: "IMAGE_TIMEOUT" },
    { status: "succeeded", path: "/scratch/edited.png", mimeType: "image/png" },
  ] } };
  assert.deepEqual(toolResultImages(message(result, "GenerateImages")), [
    { index: 1, path: "/scratch/edited.png", mimeType: "image/png" },
  ]);
});

test("saved tool results project identically after JSON round-trip without mutations", () => {
  const original = message({ content: [image], details: { images: [image] } }, "plugin_screenshot");
  const saved = JSON.stringify(original);
  assert.deepEqual(toolResultImages(original), toolResultImages(JSON.parse(saved)));
  assert.equal(JSON.stringify(original), saved);
  assert.deepEqual(toolResultImages(message({ content: [{ type: "text", text: "done" }] })), []);
});

/*
 * A turn's tool images are evidence the reader glances at, not the answer: they
 * become one row of small tiles instead of a 420px card per call. The row is
 * also a drag surface, so a press that moves must scroll rather than open the
 * tile it started on.
 */

const inline = (data) => ({ type: "image", mimeType: "image/png", data });

test("one turn's tool images merge into a single strip in reading order", () => {
  const strip = turnToolImages([
    { id: "read-1", toolName: "Read", toolResult: { path: "/workspace/read.png", images: [inline("cG5n")] } },
    {
      id: "mcp-1",
      toolName: "mcp_screenshot",
      toolResult: {
        content: [inline("cG5n"), inline("dHdv")],
        details: { images: [inline("cG5n"), inline("dHdv")] },
      },
    },
  ]);
  // Mirrored content/details blocks stay deduplicated inside their own message.
  assert.deepEqual(strip.map((item) => item.dataUrl), [
    "data:image/png;base64,cG5n",
    "data:image/png;base64,cG5n",
    "data:image/png;base64,dHdv",
  ]);
  // Positions belong to the strip, keys belong to the message they came from:
  // three tool calls may each return `index: 0` without colliding.
  assert.deepEqual(strip.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(strip.map((item) => item.key), ["read-1:0", "mcp-1:0", "mcp-1:1"]);
});

test("generated batches keep the large gallery and never join the strip", () => {
  const generated = {
    id: "gen-1",
    toolName: "GenerateImages",
    toolResult: {
      details: {
        kind: "generated-images",
        results: [
          { status: "succeeded", path: "/scratch/generated.png", mimeType: "image/png" },
          { status: "failed", errorCode: "IMAGE_TIMEOUT" },
        ],
      },
    },
  };
  assert.deepEqual(turnToolImages([generated]), []);
  assert.deepEqual(
    turnToolImages([generated, { id: "read-1", toolName: "Read", toolResult: { images: [image] } }])
      .map((item) => item.key),
    ["read-1:0"],
  );
  assert.deepEqual(turnToolImages([{ id: "bash-1", toolName: "Bash", toolResult: { stdout: "done" } }]), []);
});

test("a press within the drag threshold stays a click", () => {
  const press = beginImageStripDrag(1, 200, 120);
  const wobble = moveImageStripDrag(press, 200 + IMAGE_STRIP_DRAG_THRESHOLD_PX - 1);
  assert.equal(wobble.scrollLeft, null, "a click must not shift the row");
  assert.equal(imageStripDragBlocksClick(wobble.drag), false);
  assert.equal(wobble.drag.dragged, false);
});

test("a press past the threshold scrolls the row and drops the click", () => {
  let drag = beginImageStripDrag(1, 200, 120);
  let scrollLeft = null;
  for (const clientX of [203, 190, 150]) {
    const step = moveImageStripDrag(drag, clientX);
    drag = step.drag;
    if (step.scrollLeft !== null) scrollLeft = step.scrollLeft;
  }
  assert.equal(drag.dragged, true);
  assert.equal(imageStripDragBlocksClick(drag), true, "the tile under the drag must not open");
  assert.equal(scrollLeft, 170, "the row follows the pointer, not the delta from zero");
  // Once the gesture is a drag it stays one, even if it returns to its origin.
  const returned = moveImageStripDrag(drag, 200);
  assert.equal(returned.drag.dragged, true);
  assert.equal(imageStripDragBlocksClick(returned.drag), true);
  assert.equal(returned.scrollLeft, 120, "returning to the origin restores the row's offset");
  // A drag past the row's start cannot scroll before the first tile.
  assert.equal(moveImageStripDrag(beginImageStripDrag(1, 100, 10), 160).scrollLeft, 0);
  assert.equal(imageStripDragBlocksClick(null), false);
});

test("the strip renders one labelled row of small tiles and keeps failed images in place", async (t) => {
  const ssr = await slotSsr(t);
  const { ToolImageStrip } = await ssr.load("/src/features/chat/transcript/ToolImageStrip.tsx");
  const html = ssr.render(createElement(ToolImageStrip, {
    images: turnToolImages([
      { id: "read-1", toolName: "Read", toolResult: { images: [inline("cG5n")] } },
      { id: "mcp-1", toolName: "mcp_screenshot", toolResult: { content: [inline("dHdv")] } },
      // A local reference is read by the host after mount, so server rendering
      // shows the placeholder that a missing file keeps for its whole life.
      { id: "missing-1", toolName: "Read", toolResult: { images: [{ path: "/workspace/missing.png", mimeType: "image/png" }] } },
    ]),
  }));
  assert.match(html, /class="tool-images" role="group" aria-label="Tool images"/);
  const tiles = html.match(/<button[^>]*class="tool-image-strip-item[^"]*"/g) ?? [];
  assert.equal(tiles.length, 3, "every image keeps its place in the row");
  assert.match(html, /aria-label="Tool images 1"[\s\S]*aria-label="Tool images 2"[\s\S]*aria-label="Tool images 3"/);
  assert.equal(html.match(/<img src="data:image\/png;base64,/g)?.length, 2);
  assert.equal(html.match(/class="tool-image-strip-item is-unavailable"/g)?.length, 1);
  assert.match(html, /class="tool-image-strip-placeholder"/);
  // No download or other per-tile chrome: the tile opens the shared viewer.
  assert.doesNotMatch(html, /download=/);
});

test("the strip's classes exist and keep the row horizontal and scrollable", () => {
  // The component owns its stylesheet (ToolRow imports the same file), so read
  // that file rather than the globals.css cascade it is not part of.
  const css = readFileSync(new URL("../src/styles/generated-images.css", import.meta.url), "utf8");
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
  const strip = rule(".tool-image-strip");
  assert.match(strip, /display: flex/);
  assert.match(strip, /overflow-x: auto/);
  assert.doesNotMatch(strip, /flex-direction: column/);
  const tile = rule(".tool-image-strip-item");
  assert.match(tile, /flex: 0 0 auto/, "tiles keep one size instead of stretching");
  assert.match(rule(".tool-image-strip-item img"), /object-fit: cover/);
  for (const name of ["tool-images", "tool-image-strip", "tool-image-strip-item", "tool-image-strip-placeholder"]) {
    assert.match(css, new RegExp(`\\.${name}[ ,{]`), `${name} is painted by the stylesheet`);
  }
});
