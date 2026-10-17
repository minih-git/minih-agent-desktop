import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

const forwardedArgs = process.argv.slice(2);

// Dual-brand release lanes (see docs/spec/06-delivery/06-release-runbook.md).
// `DESKTOP_BRAND=hungraim` packages the Hungraim identity and the generic
// updates.hungraim.com feed; every other value packages the minih identity
// exactly as before. The GitHub release lane must never publish a hungraim
// artifact — that brand ships from its own distribution host.
const brand = process.env.DESKTOP_BRAND === "hungraim" ? "hungraim" : "minih";
if (brand === "hungraim" && process.env.GITHUB_ACTIONS === "true") {
  throw new Error(
    "DESKTOP_BRAND=hungraim must not be published through the GitHub release lane",
  );
}

const HUNGRAIM_APP_ID = "com.hungraim.agent";
const HUNGRAIM_PRODUCT_NAME = "Hungraim-Agent-Desktop";
const HUNGRAIM_PACKAGE_NAME = "hungraim-agent-desktop";
const HUNGRAIM_UPDATE_FEED_URL = "https://updates.hungraim.com/desktop/stable";
const APP_UPDATE_YML_PATH = new URL(
  "../apps/desktop/resources/app-update.yml",
  import.meta.url,
);

/**
 * electron-builder CLI overrides for the hungraim lane. `${version}`/`${arch}`/
 * `${ext}` stay literal electron-builder templates; arguments are passed as an
 * argv array, so no shell ever expands them.
 */
function brandBuilderArgs() {
  if (brand === "minih") return [];
  return [
    `-c.appId=${HUNGRAIM_APP_ID}`,
    `-c.productName=${HUNGRAIM_PRODUCT_NAME}`,
    `-c.mac.artifactName=${HUNGRAIM_PRODUCT_NAME}-\${version}-\${arch}-mac.\${ext}`,
    `-c.win.artifactName=${HUNGRAIM_PRODUCT_NAME}-\${version}-\${arch}.\${ext}`,
    `-c.nsis.shortcutName=${HUNGRAIM_PRODUCT_NAME}`,
    `-c.nsis.artifactName=${HUNGRAIM_PRODUCT_NAME}-Setup-\${version}.\${ext}`,
    `-c.portable.artifactName=${HUNGRAIM_PRODUCT_NAME}-Portable-\${version}.\${ext}`,
    `-c.linux.executableName=${HUNGRAIM_PACKAGE_NAME}`,
    `-c.linux.artifactName=${HUNGRAIM_PRODUCT_NAME}-\${version}-linux-\${arch}.\${ext}`,
    `-c.deb.packageName=${HUNGRAIM_PACKAGE_NAME}`,
    `-c.deb.artifactName=${HUNGRAIM_PACKAGE_NAME}_\${version}_\${arch}.\${ext}`,
    `-c.rpm.packageName=${HUNGRAIM_PACKAGE_NAME}`,
    `-c.rpm.artifactName=${HUNGRAIM_PACKAGE_NAME}-\${version}-\${arch}.\${ext}`,
    `-c.publish={"provider":"generic","url":"${HUNGRAIM_UPDATE_FEED_URL}"}`,
  ];
}

/**
 * The packaged `app-update.yml` is copied from resources/ via extraResources.
 * A hungraim build swaps in the generic feed for the duration of the builder
 * run and restores the minih file afterwards, so the working tree never keeps
 * the branded copy.
 */
function withBrandedAppUpdateYml(run) {
  if (brand === "minih") return run();
  const original = readFileSync(APP_UPDATE_YML_PATH, "utf8");
  writeFileSync(
    APP_UPDATE_YML_PATH,
    `provider: generic\nurl: ${HUNGRAIM_UPDATE_FEED_URL}\n`,
  );
  return run().finally(() => {
    writeFileSync(APP_UPDATE_YML_PATH, original);
  });
}

const hostTarget =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
  ? forwardedArgs.shift()
  : undefined;
const target = requestedTarget ?? hostTarget;

if (!["linux", "mac", "win"].includes(target)) {
  throw new Error(`Unsupported desktop release target: ${target}`);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpmCommand, ["exec", "electron-builder", ...args], {
      // Windows exposes pnpm as a .cmd shim. Launch it through the shell so
      // Node can start the shim consistently on the hosted Windows runner.
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `electron-builder ${target} target failed with ${
            code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

await withBrandedAppUpdateYml(async () => {
  if (target === "win") {
    await runBuilder([
      "--win",
      "nsis",
      "--publish",
      "never",
      ...forwardedArgs,
      ...brandBuilderArgs(),
      "-c.extraMetadata.piDistribution=installed",
    ]);
    await runBuilder([
      "--win",
      "zip",
      "--publish",
      "never",
      ...forwardedArgs,
      ...brandBuilderArgs(),
      "-c.extraMetadata.piDistribution=zip",
    ]);
    await runBuilder([
      "--win",
      "portable",
      "--publish",
      "never",
      ...forwardedArgs,
      ...brandBuilderArgs(),
      "-c.extraMetadata.piDistribution=portable",
    ]);
  } else {
    await runBuilder([
      `--${target}`,
      "--publish",
      "never",
      ...forwardedArgs,
      ...brandBuilderArgs(),
    ]);
  }
});
