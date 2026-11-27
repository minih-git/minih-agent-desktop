import assert from "node:assert/strict";
import test from "node:test";
import { toolResultImages } from "../src/features/chat/transcript/tool-result-images.ts";

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
