import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Machine check for the browser entry (ADR 0331 / PR-1): bundling
 * `src/browser.ts` with esbuild on `platform: "browser"` must not reach any
 * `node:` builtin or the `ws` package. The H5 client imports
 * `@minih-agent/racp/browser`; this test keeps the entry Node-free.
 */
const scratch = mkdtempSync(join(tmpdir(), "racp-browser-entry-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("browser entry", () => {
  const esbuild = resolveEsbuild();

  it("bundles on platform=browser without node: builtins or ws", () => {
    expect(esbuild, "esbuild must be resolvable from the workspace to run this check").toBeTruthy();
    const outfile = join(scratch, "browser-bundle.js");
    const packageDir = dirname(dirname(esbuild!));
    // esbuild's bin file is a platform binary; run it through its JS wrapper
    // API so the check works wherever the store binary lives.
    const program = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          "import { build } from " + JSON.stringify(join(packageDir, "lib", "main.js")) + ";",
          "await build({",
          "  entryPoints: ['src/browser.ts'],",
          "  bundle: true,",
          "  outfile: " + JSON.stringify(outfile) + ",",
          '  platform: "browser",',
          '  format: "esm",',
          '  packages: "external",',
          "  logLevel: 'warning',",
          "});",
        ].join("\n"),
      ],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
    );
    expect(program.stderr).toBe("");
    expect(program.status).toBe(0);
    const bundle = readFileSync(outfile, "utf8");
    expect(bundle).toContain("RacpClient");
    expect(bundle).toContain("createHttpSseClient");
    // A `node:` import would appear as `import ... from "node:..."`; the `ws`
    // package would appear as a bare `from "ws"` import. `packages=external`
    // keeps workspace deps as import statements, so both stay visible.
    const nodeImports = bundle.match(/from\s*"(node:[^"]+)"/g) ?? [];
    expect(nodeImports).toEqual([]);
    expect(bundle).not.toMatch(/from\s*"ws"/);
    expect(bundle).not.toMatch(/import\s*"ws"/);
  });

  it("keeps the Node entry importing node: builtins (sanity for the check above)", () => {
    // The main entry deliberately keeps Node code (auth.ts uses node:crypto);
    // this guards the test against silently passing because bundling failed.
    const auth = readFileSync(new URL("../src/auth.ts", import.meta.url), "utf8");
    expect(auth).toContain('from "node:crypto"');
  });
});

function resolveEsbuild(): string | null {
  // pnpm keeps the real esbuild binary under node_modules/.pnpm; the desktop
  // app pins it, so resolve through the workspace store and verify by running.
  const storeRoot = join(process.cwd(), "..", "..", "node_modules", ".pnpm");
  try {
    for (const entry of readdirSync(storeRoot)) {
      if (!entry.startsWith("esbuild@")) continue;
      const binary = join(storeRoot, entry, "node_modules", "esbuild", "bin", "esbuild");
      if (statSync(binary).isFile()) return binary;
    }
  } catch {
    // The store layout changed; the test reports the failure explicitly.
  }
  return null;
}
