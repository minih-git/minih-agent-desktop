#!/usr/bin/env node
/** Real Electron net.fetch + model discovery against an isolated TLS fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitForChildExitWithEscalation } from "./e2e/wait-for-child-exit.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-client-certificate-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/provider-client-certificate.ts")],
    outfile: join(temp, "main.mjs"), bundle: true, platform: "node", format: "esm",
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    external: ["electron"],
    // A request worktree carries no built package dist, so bundle the workspace
    // packages from source, as the other main-process E2E harnesses do.
    alias: {
      "@minih-agent/shared": join(root, "packages/shared/src/index.ts"),
      "@minih-agent/agent-runtime/proxy-tunnel": join(root, "packages/agent-runtime/src/socks5.ts"),
      "@minih-agent/agent-runtime/system-proxy-relay": join(root, "packages/agent-runtime/src/system-proxy-relay.ts"),
      "@minih-agent/agent-runtime": join(root, "packages/agent-runtime/src/index.ts"),
    },
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.mjs"), temp,
    join(root, "scripts/e2e/fixtures/certificates")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  // A probe that cannot start must fail this step, not hold the job open.
  // SIGTERM alone is not enough: Electron can ignore it while a renderer is
  // mid-init, and `close` then never arrives, so the step waits out the job
  // budget and is cancelled with no failing step to read. Escalate to SIGKILL
  // after a short grace period and say which signal fired.
  const { code, killedBy } = await waitForChildExitWithEscalation(child);
  assert.equal(
    killedBy,
    null,
    `provider client certificate E2E hung and was killed by ${killedBy} after ${killedBy === "SIGKILL" ? 65 : 60}s: ${output}`,
  );
  assert.equal(code, 0, output);
  assert.match(output, /provider client certificate E2E passed/);
} finally { await rm(temp, { recursive: true, force: true }); }
