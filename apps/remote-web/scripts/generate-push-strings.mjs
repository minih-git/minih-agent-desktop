#!/usr/bin/env node
/**
 * Generate the platform string resources for push notifications (protocol
 * §11.6, R5 PR-6, ADR 0331 decision 7).
 *
 * The rules live in `src/lib/push-strings.ts` (pure, and guarded by a test); this
 * script is the writer, and it imports the same module so the files on disk and
 * the test can never disagree.
 *
 * English and Simplified Chinese are generated: the two languages the operator
 * ships a store listing for. The values are fixed copy — no session title, no
 * tool name, no prompt — so these resources cannot become a content channel.
 *
 * Usage: `node scripts/generate-push-strings.mjs`
 * (`--check` compares instead of writing, which is what CI-style checks want.)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Node runs the TypeScript module directly (type stripping), so the generator and
// the guard test share one implementation.
const { renderPushStrings, PUSH_STRING_TARGETS } = await import("../src/lib/push-strings.ts");
const { en } = await import("../src/locales/en.ts");
const { zhCN } = await import("../src/locales/zh-CN.ts");

const check = process.argv.includes("--check");
const rendered = renderPushStrings({ en, "zh-CN": zhCN });
let stale = 0;

for (const [relative, content] of Object.entries(rendered)) {
  const path = join(root, relative);
  if (check) {
    const current = await readFile(path, "utf8").catch(() => null);
    if (current !== content) {
      console.error(`push strings: ${relative} is stale`);
      stale += 1;
    }
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  console.log(`push strings: ${relative}`);
}

if (check) {
  if (stale > 0) {
    console.error("run `node scripts/generate-push-strings.mjs` to regenerate");
    process.exit(1);
  }
  console.log(`push strings: ${Object.keys(PUSH_STRING_TARGETS).length} files up to date`);
}
