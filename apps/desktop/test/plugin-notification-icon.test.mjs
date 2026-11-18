import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/*
 * `manifest.icon` is the only icon a plugin may put in host chrome: a package
 * member, raster, small, and served over the host-owned `plugin-asset:` scheme.
 * These are the boundary checks — the renderer test in
 * `notification-plugin-center.test.mjs` covers what the row does with the URL.
 */

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  PLUGIN_ICON_MAX_BYTES,
  normalizePluginIconPath,
  pluginIconUrl,
  readPluginIconBytes,
  resolvePluginIcon,
} = await import("../electron/main/plugin-icon-asset.ts");

// Smallest valid PNG header: enough for the magic-byte check.
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function pluginDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "minih-agent-desktop-plugin-icon-"));
  for (const [name, contents] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

test("a manifest icon must be a package member", () => {
  assert.equal(normalizePluginIconPath("icon.png"), "icon.png");
  assert.equal(normalizePluginIconPath("./assets/mark.webp"), "assets/mark.webp");
  assert.equal(normalizePluginIconPath("  assets/a/b.jpg  "), "assets/a/b.jpg");

  for (const icon of [
    "/etc/passwd.png",
    "assets/../../secret.png",
    "../secret.png",
    "assets\\mark.png",
    "node_modules/pkg/icon.png",
    "file:///etc/passwd.png",
    "data:image/png;base64,AAAA",
    "https://example.com/icon.png",
    "C:/Windows/icon.png",
    "icon.svg",
    "icon.gif",
    "icon",
    "",
    "   ",
  ]) {
    assert.equal(normalizePluginIconPath(icon), null, String(icon));
  }
  // Not a string at all: a manifest with a non-string icon declares nothing.
  assert.equal(normalizePluginIconPath({ path: "icon.png" }), null);
});

test("the served URL is the host scheme, never a disk path", () => {
  assert.equal(pluginIconUrl("acme.ci", "assets/mark.png"), "plugin-asset://acme.ci/assets/mark.png");
  const url = pluginIconUrl("acme.ci", "assets/my mark.png");
  assert.match(url, /^plugin-asset:\/\/acme\.ci\//);
  assert.doesNotMatch(url, /^\//);
});

test("only a real raster inside the package resolves", () => {
  const dir = pluginDir({ "icon.png": PNG, "readme.md": "text", "big.png": Buffer.alloc(PLUGIN_ICON_MAX_BYTES + 1) });

  const icon = resolvePluginIcon(dir, "icon.png");
  assert.ok(icon);
  assert.equal(icon.assetPath, "icon.png");
  assert.ok(icon.absolute.startsWith(realpathSync(dir)));

  // Declared but not an image extension, too large, or missing.
  assert.equal(resolvePluginIcon(dir, "readme.md"), null);
  assert.equal(resolvePluginIcon(dir, "big.png"), null);
  assert.equal(resolvePluginIcon(dir, "missing.png"), null);
  assert.equal(resolvePluginIcon(dir, undefined), null);
});

test("a symlink pointing outside the package is refused", () => {
  const outside = pluginDir({ "secret.png": PNG });
  const dir = pluginDir({ "icon.png": PNG });
  symlinkSync(join(outside, "secret.png"), join(dir, "linked.png"));

  assert.equal(resolvePluginIcon(dir, "linked.png"), null);
});

test("bytes are re-checked for size and image signature", () => {
  const dir = pluginDir({
    "icon.png": PNG,
    "fake.png": "#!/bin/sh\necho not an image\n",
    "big.png": Buffer.alloc(PLUGIN_ICON_MAX_BYTES + 1),
  });

  const real = resolvePluginIcon(dir, "icon.png");
  assert.ok(readPluginIconBytes(real.absolute));
  const fake = resolvePluginIcon(dir, "fake.png");
  assert.ok(fake, "extension alone still resolves");
  assert.equal(readPluginIconBytes(fake.absolute), null);
  assert.equal(readPluginIconBytes(join(dir, "big.png")), null);
  assert.equal(readPluginIconBytes(join(dir, "missing.png")), null);
});