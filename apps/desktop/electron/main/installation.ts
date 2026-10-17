import { app } from "electron";
import { currentAppId, currentAppName } from "@minih-agent/shared";
import {
  applyDevelopmentUserData,
  clearDataDirOverride,
  dataDirOverrideFromEnv,
  desktopDataDir,
} from "./data-paths";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.MINIH_AGENT_DEV === "1" || !app.isPackaged;
app.setName(currentAppName());
applyDevelopmentUserData(app, isDevelopmentBuild);
if (process.platform === "win32") app.setAppUserModelId(currentAppId());

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) clearDataDirOverride();
export const singleInstanceRequired = !dataDirOverrideFromEnv();
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = desktopDataDir(isDevelopmentBuild);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
