import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function repositoryRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function desktopPaths(root = repositoryRoot()) {
  const appDir = join(root, "apps", "desktop");
  const electronBinary =
    process.platform === "win32"
      ? join(appDir, "node_modules", "electron", "dist", "electron.exe")
      : join(appDir, "node_modules", ".bin", "electron");
  return { appDir, electronBinary };
}

export function resolveElectronBinary(root = repositoryRoot()) {
  const { appDir } = desktopPaths(root);
  const electronDir = join(appDir, "node_modules", "electron");
  const pathFile = join(electronDir, "path.txt");
  const relativeBinary = existsSync(pathFile)
    ? readFileSync(pathFile, "utf8").trim()
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const binary = join(electronDir, "dist", relativeBinary);
  if (!existsSync(binary)) {
    throw new Error("Electron binary missing: " + binary);
  }
  return { appDir, electronBinary: binary };
}

export function assertDesktopBuild(root = repositoryRoot()) {
  const { appDir } = desktopPaths(root);
  const mainPath = join(appDir, "out", "main", "index.js");
  const rendererPath = join(appDir, "out", "renderer", "index.html");
  if (!existsSync(mainPath)) {
    throw new Error("desktop app main is not built: " + mainPath);
  }
  if (!existsSync(rendererPath)) {
    throw new Error("desktop app renderer is not built: " + rendererPath);
  }
  return { appDir, mainPath, rendererPath };
}

export function createTempDataDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A kill or `node:test` budget that survives a slow CI runner.
 *
 * These Electron interaction tests boot a real window and drive the DOM; on a
 * two-core runner without a GPU the same work takes several times what it takes
 * on a developer machine, and a fixed budget then kills a run that would have
 * passed. CI sets `MINIH_E2E_TIMEOUT_SCALE` (see `.github/workflows/ci.yml`) so
 * every budget grows by one factor instead of each file guessing its own.
 *
 * The scale applies to timeouts only: no assertion changes with it, and a local
 * run without the variable keeps the original numbers.
 */
export function scaledTimeout(ms) {
  const raw = process.env.MINIH_E2E_TIMEOUT_SCALE;
  const scale = raw === undefined || raw.trim() === "" ? 1 : Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("MINIH_E2E_TIMEOUT_SCALE must be a positive number, got: " + raw);
  }
  return Math.round(ms * scale);
}
