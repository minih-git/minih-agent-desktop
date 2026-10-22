/**
 * Minimal `electron` surface for handler tests that must see what the host asks
 * the operating system to do.
 *
 * `shell` records every call, so a test can assert that a handler revealed a
 * path and never opened, read, or listed anything. Everything else is the
 * smallest shape the main-process modules touch at import time.
 */

/** Every `shell` call the code under test made, in order. */
export const shellCalls = [];

/** Clear the record between cases. */
export function resetShellCalls() {
  shellCalls.splice(0, shellCalls.length);
}

export const shell = {
  showItemInFolder: (path) => {
    shellCalls.push(["showItemInFolder", path]);
  },
  openPath: async (path) => {
    shellCalls.push(["openPath", path]);
    return "";
  },
  openExternal: async (url) => {
    shellCalls.push(["openExternal", url]);
    return "";
  },
  trashItem: async (path) => {
    shellCalls.push(["trashItem", path]);
  },
  beep: () => {},
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showMessageBox: async () => ({ response: 0 }),
};

export class BrowserWindow {
  static getAllWindows() {
    return [];
  }
  static getFocusedWindow() {
    return null;
  }
  static fromWebContents() {
    return null;
  }
}

export class WebContentsView {
  constructor() {
    this.webContents = {};
  }
}

export class IpcMainEvent {}
export class IpcMainInvokeEvent {}

export const app = {
  getPath: () => "",
  getName: () => "minih-agent-desktop",
  getVersion: () => "0.0.0-test",
  getAppPath: () => process.cwd(),
  isPackaged: false,
  on: () => {},
  whenReady: async () => {},
  quit: () => {},
};

export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} };
export const ipcRenderer = { invoke: async () => undefined, on: () => {}, removeListener: () => {} };
export const contextBridge = { exposeInMainWorld: () => {} };
export const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) };
export const Menu = { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} };
export const Tray = class {};
export const clipboard = { readText: () => "", writeText: () => {} };
export const webUtils = { getPathForFile: () => "" };
export const net = { fetch: async () => ({}) };
export default {
  app,
  shell,
  dialog,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  ipcRenderer,
  contextBridge,
  nativeTheme,
  screen,
  Menu,
  Tray,
  clipboard,
  webUtils,
  net,
};
