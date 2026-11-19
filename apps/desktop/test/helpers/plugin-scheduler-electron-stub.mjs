import { EventEmitter } from "node:events";
export const app = Object.assign(new EventEmitter(), { whenReady: async () => {}, quit: () => {} });
export const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleTime: () => 120 });
export const globalShortcut = { unregister: () => {} };
