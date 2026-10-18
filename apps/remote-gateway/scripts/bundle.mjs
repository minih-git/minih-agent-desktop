#!/usr/bin/env node
/**
 * Assemble the standalone `remote-gateway` bundle for one native target:
 *
 *   dist-bundle/remote-gateway-<version>-<platform>-<arch>/
 *     remote-gateway.js        the CLI, esbuild-bundled with every workspace package
 *     bin/node                 the Node runtime that runs it
 *     bin/remote-gateway       launcher
 *     package.json             { type: module, version }
 *     SHA256SUMS               verified content-addressed installation
 *
 * Usage: node scripts/bundle.mjs [--node <path>] [--platform linux|darwin] [--arch x64|arm64] [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writePackageManifest } from "../../agent-host-cli/scripts/package-integrity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const require = createRequire(import.meta.url);
const { version } = require(join(app, "package.json"));

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, index, all) =>
    arg.startsWith("--") && arg.length > 2 ? [[arg.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true]] : [],
  ),
);
const platform = String(args.platform ?? process.platform);
const arch = String(args.arch ?? process.arch);
const out = resolve(String(args.out ?? join(app, "dist-bundle", `remote-gateway-${version}-${platform}-${arch}`)));
const nodeRuntime = resolve(String(args.node ?? process.execPath));

// The runtime must match the label; a bundle is only valid on its own platform.
const runtime = JSON.parse(
  execFileSync(nodeRuntime, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  }),
);
if (
  !["linux", "darwin"].includes(platform) ||
  !["x64", "arm64"].includes(arch) ||
  platform !== process.platform ||
  arch !== process.arch ||
  runtime.platform !== platform ||
  runtime.arch !== arch ||
  Number(runtime.version.split(".")[0]) < 22
) {
  throw new Error(`Node runtime >=22 must match the bundle target ${platform}/${arch}; got ${JSON.stringify(runtime)}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });
execFileSync(
  require.resolve("esbuild/bin/esbuild"),
  [
    join(app, "src/cli.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--external:bufferutil",
    "--external:utf-8-validate",
    `--outfile=${join(out, "remote-gateway.js")}`,
    "--banner:js=import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);",
  ],
  { stdio: "inherit", cwd: app },
);
if (!existsSync(join(out, "remote-gateway.js"))) throw new Error("the bundle did not produce remote-gateway.js");
cpSync(nodeRuntime, join(out, "bin/node"));
chmodSync(join(out, "bin/node"), 0o755);
writeFileSync(
  join(out, "bin/remote-gateway"),
  `#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$here/node" "$here/../remote-gateway.js" "$@"
`,
);
chmodSync(join(out, "bin/remote-gateway"), 0o755);
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify({ name: "remote-gateway", version, type: "module", bin: { "remote-gateway": "./bin/remote-gateway" } }, null, 2)}\n`,
);
writePackageManifest(out);
console.log(`bundled ${out}`);
