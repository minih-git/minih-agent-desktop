/**
 * The `mail` view token (ADR 0104 icon set).
 *
 * A view's icon is a token drawn from the host's own library, so a mail plugin
 * used to be forced onto `bell`. These checks pin the three places that have to
 * agree for `mail` to draw an envelope: the SDK's closed list, the renderer's
 * token→component map, and the icon component itself (wired to the envelope
 * glyph rather than a shape that reads as something else).
 *
 * The lists themselves are compared by `plugin-work-panel-views`; this file
 * covers the token's presence and the glyph.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const sdkSource = await read("../../../packages/plugin-sdk/src/index.ts");
const mapSource = await read("../src/lib/plugin-view-icons.ts");
const iconsSource = await read("../src/components/icons.tsx");

test("the SDK offers mail to a contributed view", () => {
  const start = sdkSource.indexOf("export const PLUGIN_VIEW_ICONS = [");
  const end = sdkSource.indexOf("] as const;", start);
  assert.ok(start !== -1 && end > start, "missing PLUGIN_VIEW_ICONS");
  const list = sdkSource
    .slice(start, end)
    .split("\n")
    .map((line) => line.trim().replace(/^"|",?$/g, "").replace(/,$/, ""))
    .filter((token) => token && token !== "export const PLUGIN_VIEW_ICONS = [");
  assert.ok(list.includes("mail"), "PLUGIN_VIEW_ICONS has no mail token");
  assert.equal(new Set(list).size, list.length, "PLUGIN_VIEW_ICONS has a duplicate");
});

test("the renderer maps mail to an envelope icon", () => {
  assert.match(mapSource, /^ {2}IconMail,$/m, "the renderer icon map does not import IconMail");
  assert.match(mapSource, /^ {2}mail: IconMail,$/m, "the renderer icon map has no mail entry");
  assert.match(
    iconsSource,
    /^export const IconMail = icon\(Mail\);$/m,
    "IconMail is not wired to the envelope glyph",
  );
  assert.match(iconsSource, /^ {2}Mail,$/m, "the envelope glyph is not imported from the icon set");
});