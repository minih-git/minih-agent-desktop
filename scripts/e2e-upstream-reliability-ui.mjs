#!/usr/bin/env node
/** Isolated real components, native window creation and window IPC contracts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "minih-upstream-reliability-ui-"));
try {
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const styles = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(styles.length, "Build Desktop before running this test");
  await mkdir(join(temp, "renderer"));
  await mkdir(join(temp, "preload"));
  await cp(join(renderer, "assets"), join(temp, "renderer/assets"), { recursive: true });
  await cp(join(root, "apps/desktop/out/preload/index.cjs"), join(temp, "preload/index.cjs"));
  await writeFile(join(temp, "renderer/index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:">${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<body><script src="renderer.js"></script>`);
  await build({
    entryPoints: [join(root, "scripts/e2e/upstream-reliability-ui.tsx")],
    outfile: join(temp, "renderer/renderer.js"), bundle: true,
    platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"test"}' },
    alias: {
      "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"),
      "@minih-agent/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: [join(root, "scripts/e2e/upstream-reliability-window.mjs")],
    outfile: join(temp, "main/main.mjs"), bundle: true, platform: "node", format: "esm",
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    external: ["electron"],
    alias: {
      "@minih-agent/shared": join(root, "packages/shared/src/index.ts"),
      "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"),
      "@minih-agent/agent-runtime": join(root, "packages/agent-runtime/src/index.ts"),
    },
  });
  const env = { ...process.env, ELECTRON_RENDERER_URL: "", MINIH_AGENT_CAPTURE: "0", MINIH_AGENT_START_MAXIMIZED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main/main.mjs"), temp], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, output.slice(-10000));
    const line = output.split(/\r?\n/).find((line) => line.startsWith("UPSTREAM_RELIABILITY_UI "));
    assert(line, output.slice(-10000));
    console.log(line);
  } finally { clearTimeout(timeout); }
} finally { await rm(temp, { recursive: true, force: true }); }
