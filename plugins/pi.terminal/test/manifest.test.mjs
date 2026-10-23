import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_VIEW_PLACEMENTS, validateManifest } from "@minih-agent/plugin-sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));

test("the shipped manifest is valid and needs no manifest change to be understood", () => {
  const result = validateManifest(raw);
  assert.equal(result.error, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, "pi.terminal");
  assert.equal(result.manifest.main, "main.js");
});

test("the terminal is a sidebar-placed view, not a work-panel tab", () => {
  const [view] = raw.contributes.views;
  assert.equal(view.placement, "sidebar");
  assert.equal(view.id, "terminal");
  assert.equal(view.entry, "view/index.html");
  // The icon must be a host token; the page draws no host chrome of its own.
  assert.equal(view.icon, "terminal");
  assert.deepEqual(Object.keys(view.title).sort(), ["en", "zh-CN"]);
  for (const placement of [view.placement]) {
    assert.ok(PLUGIN_VIEW_PLACEMENTS.includes(placement));
  }
});

test("it asks for the view, the directory picker, and the clipboard, and nothing else", () => {
  assert.deepEqual([...raw.permissions].sort(), ["clipboard.write", "fs.read", "ui.view"]);
  // A terminal is a manual surface: it must not register agent tools, MCP
  // servers, prompt injection, or an agent extension.
  for (const forbidden of [
    "agentTools",
    "agentExtensions",
    "mcpServers",
    "services",
    "sessionSources",
    "composerTransforms",
  ]) {
    assert.equal(raw.contributes[forbidden], undefined, forbidden);
  }
  assert.equal(raw.ui, undefined, "no detached panel window");
});

test("both contract locales state that it runs local commands with the user's privileges", () => {
  for (const locale of ["en", "zh-CN"]) {
    const notes = raw.i18n[locale].safetyNotes;
    assert.equal(typeof notes, "string", locale);
    assert.ok(notes.trim().length > 40, `${locale} note must say something real`);
    assert.match(notes, locale === "en" ? /privileges|permissions/i : /权限/);
    assert.equal(raw.i18n[locale].name.length > 0, true);
  }
});
