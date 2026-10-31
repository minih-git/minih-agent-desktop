import assert from "node:assert/strict";
import test from "node:test";
import { validateCatalog } from "../../../scripts/check-marketplace-catalog.mjs";

const packageFields = {
  version: "1.0.0",
  shasum: "a".repeat(64),
  url: "https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/packages/demo.hello-1.0.0.piplug",
  sizeBytes: 1024,
  permissions: ["ui.panel"],
};

function catalog(plugin) {
  return {
    schemaVersion: 1,
    providerId: "official",
    plugins: [plugin],
  };
}

test("preflight accepts a string catalog author", () => {
  const errors = validateCatalog(
    catalog({
      id: "demo.hello",
      author: "Minih-Agent-Desktop",
      versions: [packageFields],
    }),
    "demo.hello",
    "https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json",
  );
  assert.deepEqual(errors, []);
});

test("preflight rejects a plugin-manifest author object in the catalog", () => {
  const errors = validateCatalog(
    catalog({
      id: "com.minih.voice-assistant",
      author: { name: "Minih", url: "https://github.com/minih" },
      versions: [packageFields],
    }),
    "com.minih.voice-assistant",
    "https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json",
  );
  assert.ok(
    errors.some((error) =>
      error.includes("author must be a string (not a {name,url} object)"),
    ),
    errors.join("\n"),
  );
});

const giteaBase = "https://gitea.hungraim.com/minih/minih-agent-plugins/raw/branch/main";
const giteaCatalog = `${giteaBase}/catalog.json`;

test("preflight accepts relative packages on the Gitea catalog host", () => {
  const document = catalog({
    id: "demo.hello",
    author: "Minih-Agent-Desktop",
    versions: [{ ...packageFields, url: "packages/demo.hello-1.0.0.piplug" }],
  });
  document.artifact_base_url = giteaBase;
  assert.deepEqual(validateCatalog(document, "demo.hello", giteaCatalog), []);
});

test("preflight accepts absolute packages on the Gitea catalog host", () => {
  const document = catalog({
    id: "demo.hello",
    author: "Minih-Agent-Desktop",
    versions: [{ ...packageFields, url: `${giteaBase}/packages/demo.hello-1.0.0.piplug` }],
  });
  assert.deepEqual(validateCatalog(document, "demo.hello", giteaCatalog), []);
});

test("preflight validates the snake-case artifact base rather than the catalog host", () => {
  const document = catalog({
    id: "demo.hello",
    author: "Minih-Agent-Desktop",
    versions: [{ ...packageFields, url: "packages/demo.hello-1.0.0.piplug" }],
  });
  document.artifact_base_url = "https://untrusted.example/releases";
  const errors = validateCatalog(document, "demo.hello", giteaCatalog);
  assert.ok(errors.some((error) => error.includes("untrusted.example")), errors.join("\n"));
});

test("Gitea same-host acceptance does not allow lookalikes HTTP or credentials", () => {
  for (const url of [
    "https://gitea.hungraim.com.attacker.example/plugin.piplug",
    "https://sub.gitea.hungraim.com/plugin.piplug",
    "http://gitea.hungraim.com/plugin.piplug",
    "https://user:secret@gitea.hungraim.com/plugin.piplug",
  ]) {
    const document = catalog({
      id: "demo.hello",
      author: "Minih-Agent-Desktop",
      versions: [{ ...packageFields, url }],
    });
    assert.ok(validateCatalog(document, "demo.hello", giteaCatalog).length > 0, url);
  }
});

test("local release preflight accepts the official Gitea artifact base only", () => {
  const document = catalog({
    id: "demo.hello",
    author: "Minih-Agent-Desktop",
    versions: [{ ...packageFields, url: "packages/demo.hello-1.0.0.piplug" }],
  });
  document.artifact_base_url = giteaBase;
  assert.deepEqual(validateCatalog(document, "demo.hello", "./catalog.json"), []);
  document.artifact_base_url = "https://untrusted.example/releases";
  assert.ok(validateCatalog(document, "demo.hello", "./catalog.json").length > 0);
});
