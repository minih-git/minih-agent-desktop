import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { skippedPackageMessageKey } = await import(
  "../src/features/settings/config-sync-skipped.ts"
);

test("each package bound gets its own sentence", () => {
  assert.equal(
    skippedPackageMessageKey("files"),
    "settings.configSync.skippedPackageFiles",
  );
  assert.equal(
    skippedPackageMessageKey("resourceBytes"),
    "settings.configSync.skippedPackageResourceBytes",
  );
  assert.equal(
    skippedPackageMessageKey("packageBytes"),
    "settings.configSync.skippedPackageBytes",
  );
  // A reason this build does not know reports the file-count sentence rather
  // than an untranslated key: the list still names the skill and the bound.
  assert.equal(
    skippedPackageMessageKey("somethingNew"),
    "settings.configSync.skippedPackageFiles",
  );
});