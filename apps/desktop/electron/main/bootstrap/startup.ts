import { app, BrowserWindow, crashReporter, Menu, safeStorage } from "electron";
import { createScheduledRunner } from "../runtime/scheduled-runner";
import {
  APP_VERSION,
  currentAppName,
  ErrorCodes,
  IPC,
  type AppMenuCommand,
  type AppSettings,
  type CloseBehavior,
  type KeybindingOverrides,
  type NativeMenuAction,
} from "@minih-agent/shared";
import { installApplicationMenu } from "../application-menu";
import { installPluginAssetProtocol } from "../plugin-asset-protocol";
import { installPluginRendererProtocol } from "../plugin-renderer-protocol";
import { registerPluginSchemes } from "../plugin-schemes";
import { applyNetworkProxyFromAppSettings } from "../network-proxy";
import { readCloseBehavior } from "../window-preferences";
import { createAgentHostBridge, type AgentHostBridge } from "../agent-host-bridge";
import { createBackendRouter, createDeleteOnlyOfflineBackend, type BackendRouter } from "../remote/backend-router";
import { createRemoteHostsBoot, setActiveRemoteHostsBoot } from "./remote-hosts";
import { createGatewayLinkBootstrap, setActiveGatewayLink } from "./gateway-link";
import { createAccountComputers } from "../remote/gateway-link/account-computers.js";
import { accountMetadataOf } from "../remote/remote-host-metadata.js";
import { racpGatewayLinkPort } from "../remote/gateway-link/racp-gateway-link-port.js";
import { HostLinkNotifier } from "@minih-agent/racp";
import {
  createMcpControlController,
  McpControlServer,
  mcpControlRendererEvent,
  type McpControlController,
  type McpControlInvokeInput,
} from "../mcp-control";
import type { ModelsDevCatalog } from "../models-dev-catalog";
import type { AppUpdaterController } from "../updater";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import { runSessionListProbe } from "../session-list-probe";
import {
  ensureCrashDumpsDirectory,
  reportPreviousCrashDumps,
} from "../crash-report";

type IpcInvoker = (
  channel: string,
  args?: readonly unknown[],
) => Promise<unknown>;

/**
 * The remote-host modules pass their log `data` as a structured object (e.g.
 * `{hostKey, error}`); a bare `String(data)` prints `[object Object]` and
 * loses the context. Errors keep their `String(error)` shape ("Error: ..."),
 * plain strings pass through, everything else JSON-stringifies.
 */
function formatRemoteLogData(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (typeof data === "string") return data;
  if (data instanceof Error) return String(data);
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export type StartupState = {
  applicationBooted: boolean;
  closeBehavior: CloseBehavior;
  agentHostBridge: AgentHostBridge | null;
  backendRouter: BackendRouter | null;
  desktopControl: McpControlController | null;
  mcpControl: McpControlServer | null;
};

export type StartupDependencies = {
  hasSingleInstanceLock: boolean;
  state: StartupState;
  dataDir: string;
  logger: Logger;
  updater: AppUpdaterController;
  modelsDevCatalog: ModelsDevCatalog;
  plugins: PluginRuntime;
  /**
   * Shared busy check from `runtime/session-coordination.ts`. The queue must
   * stay held while a turn's announcement is still running, so this cannot be
   * be derived from the startup state alone.
   */
  isSessionBusy: (sessionId: string) => boolean;
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  applyDevelopmentBranding: () => void;
  createTray: () => void;
  dispatchApplicationMenuCommand: (command: AppMenuCommand) => void;
  dispatchNativeMenuAction: (action: NativeMenuAction) => void;
  prewarmPluginLauncher: () => void;
  registerIpc: () => IpcInvoker;
  bootBackends: () => Promise<void>;
  planUiProbe: { install: () => void };
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyMacosWindowTranslucency: (
    settings?: { macosWindowTranslucency?: unknown } | null,
  ) => void;
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyPluginLauncherShortcut: (keybindings?: KeybindingOverrides) => void;
  applyToggleWindowShortcut: (keybindings?: KeybindingOverrides) => void;
  ensureWindow: () => Promise<boolean>;
  bootHostStatus: (bootError: unknown) => unknown;
  flushPendingApplicationMenuCommands: () => void;
  getSidecar?: () => unknown;
  invokeSessionCollaboration?: (input: McpControlInvokeInput) => Promise<unknown>;
  onSessionQueueChange?: () => void;
};

/**
 * Register the Electron-ready boot sequence. The sequence remains deliberately
 * ordered here, while its mutable process resources are supplied by the main
 * composition root through `StartupState` and dependency callbacks.
 */
export function registerApplicationStartup(deps: StartupDependencies): void {
  // Electron only accepts scheme privileges before the app is ready, and this
  // runs from the composition root, before the `whenReady` promise can settle.
  registerPluginSchemes();
  // Crashpad ships with Electron, so the reporter needs no native dependency.
  // Dumps stay local (`uploadToServer: false`) under the installation data
  // directory so a `MINIH_AGENT_DATA_DIR` profile does not share them. Started
  // before `ready`, so no crash can happen ahead of the handler. A failure
  // here is a warning: it never blocks boot.
  try {
    app.setPath("crashDumps", ensureCrashDumpsDirectory(deps.dataDir));
    crashReporter.start({ uploadToServer: false, productName: currentAppName() });
  } catch (error) {
    deps.logger.app("diagnostics", "warn", "crash reporter failed to start", {
      event: "crashReporterStartFailed",
      data: String(error),
    });
  }


  void app.whenReady().then(async () => {
    const {
      hasSingleInstanceLock,
      state,
      dataDir,
      logger,
      updater,
      modelsDevCatalog,
      plugins,
      isSessionBusy,
      getHost,
      getMainWindow,
      sendToRenderer,
      applyDevelopmentBranding,
      createTray,
      dispatchApplicationMenuCommand,
      dispatchNativeMenuAction,
      prewarmPluginLauncher,
      registerIpc,
      bootBackends,
      planUiProbe,
      applyApplicationMenuSettings,
      applyDeveloperMode,
      applyMacosWindowTranslucency,
      applyPreventScreenSleep,
      applyKeepAwakeWhileRunning,
      applyPluginLauncherShortcut,
      applyToggleWindowShortcut,
      ensureWindow,
      bootHostStatus,
      flushPendingApplicationMenuCommands,
    } = deps;

    // A launch that lost the single-instance lock is already quitting. Never
    // create a window, a tray, or a child process on top of the running app.
    if (!hasSingleInstanceLock) return;
    applyDevelopmentBranding();

    // A Chromium-process crash from a previous run left a minidump, and nothing
    // else would ever mention it. Report one durable line per new dump set,
    // classified by process type, then advance the marker. Reporting is
    // diagnostics: a failure warns and is dropped rather than holding up the
    // first window.
    reportPreviousCrashDumps({
      dataDir,
      crashDumpsDirectory: app.getPath("crashDumps"),
      logger,
    });

    // Serve declared theme assets before the renderer can ask for one; the
    // scheme itself was reserved in `registerApplicationStartup`.
    installPluginAssetProtocol((pluginId, assetPath) =>
      plugins.resolveThemeAsset(pluginId, assetPath),
    );
    // Serve renderer entry modules the same way — the current load of a
    // plugin that declared `manifest.renderer` and holds `renderer.extension`.
    installPluginRendererProtocol((pluginId, generation, requestPath) =>
      plugins.resolveRendererSource(pluginId, generation, requestPath),
    );
    // Load the close-behavior preference before the first window exists: the
    // close handler reads `closeBehavior` synchronously, and a window created
    // while it still held the "ask" default would prompt a user who already
    // chose.
    const storedBehavior = readCloseBehavior(dataDir);
    if (storedBehavior) state.closeBehavior = storedBehavior;
    createTray();
    app.setAboutPanelOptions({
      applicationName: currentAppName(),
      applicationVersion: APP_VERSION,
      version: APP_VERSION,
    });
    installApplicationMenu({
      locale: app.getLocale(),
      dispatch: dispatchApplicationMenuCommand,
      dispatchNative: dispatchNativeMenuAction,
    });
    // Start the retained launcher as soon as Electron is ready. It can load in
    // parallel with host/plugin boot, so the first post-boot Option+Space does
    // not race the renderer allocation just because backend startup was slow.
    prewarmPluginLauncher();
    const invokeIpc = registerIpc();
    // The backend router is the single seam that forwards a renderer IPC call
    // to a paired remote host; with no remote session registered it returns
    // ROUTE_LOCAL and the local handler runs unchanged. Assigned before the
    // first window can issue IPC. Remote host connections register their
    // sessions here once paired (later stages).
    //
    // `offline` is the same seam for a session whose Host is not connected: only
    // a delete has a local answer (forgetting the row of an account computer),
    // and the boot that owns the session directory is created a few lines down,
    // so the handler is bound there.
    let forgetOfflineSession: ((remoteSessionId: string) => Promise<unknown>) | null = null;
    state.backendRouter = createBackendRouter({
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
      offline: createDeleteOnlyOfflineBackend(IPC.invoke.sessionDelete, (sessionId) =>
        forgetOfflineSession ? forgetOfflineSession(sessionId) : Promise.reject(
          Object.assign(new Error("remote session is disconnected"), {
            errorCode: ErrorCodes.AGENT_UNAVAILABLE,
          }),
        ),
      ),
    });
    // Every paired remote `agent-host-cli` opens against the router this boot just
    // created. An empty registry (default install with no user pairing) makes
    // this a full no-op — nothing connects, no backend registers, every
    // renderer call keeps hitting the local handler byte-for-byte.
    const remoteHostsBoot = createRemoteHostsBoot({
      dataDir,
      encryption: {
        // Electron's safeStorage exposes `isEncryptionAvailable`; the port
        // keeps the shorter `isAvailable` name so a Node-side test can drop
        // in a fake without pulling in the Electron type.
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (buffer) => safeStorage.decryptString(buffer),
      },
      router: state.backendRouter,
      emit: sendToRenderer,
      getLocalHost: getHost,
      clientInfo: { name: currentAppName(), version: APP_VERSION },
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
    });
    setActiveRemoteHostsBoot(remoteHostsBoot);
    // Bound once the session directory exists: an offline delete of an account
    // computer's session forgets the row instead of failing forever.
    forgetOfflineSession = (sessionId) => remoteHostsBoot.forgetSession(sessionId);
    // Boot in the background: a slow or unreachable host must not delay the
    // first window. Failures for individual hosts are logged inside `open()`.
    void remoteHostsBoot.open().then((opened) => {
      if (opened > 0) {
        logger.app("runtime", "info", "remote hosts connected", { data: String(opened) });
      }
    }).catch((error: unknown) => {
      logger.app("runtime", "warn", "remote host boot failed", { data: String(error) });
    });
    // Account mode, client half (rollout R8 package E): once the Host link is
    // up, discover the account's other computers and hand them to the boot
    // above. Without this the list stayed empty forever — the Gateway could
    // list them and issue the token, but nothing on this desktop ever asked.
    const accountComputers = createAccountComputers({
      getHost,
      existingDeviceToken: async (publicOrigin) => {
        const records = await remoteHostsBoot.registry.list();
        for (const record of records) {
          const metadata = accountMetadataOf(record);
          if (metadata?.publicOrigin === publicOrigin && record.deviceToken) return record.deviceToken;
        }
        return undefined;
      },
      join: (input) => remoteHostsBoot.joinAccountComputers(input),
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
    });
    // Redacted push (§11.6, R5 PR-6): ONE notifier for this desktop. The Agent
    // Host reports the four events (§11.6) and the Gateway link carries them;
    // the link core attaches the sender while a link is up and detaches it when
    // it ends, so a notification never goes into a dead socket.
    const notifyHost = new HostLinkNotifier({
      log: (level, message, data) => logger.app("runtime", level, message, { data }),
    });
    state.agentHostBridge = createAgentHostBridge({
      invoke: invokeIpc,
      channels: IPC.invoke,
      getHost,
      isSessionBusy,
      onQueueChange: (event) => {
        sendToRenderer(IPC.event.agentQueueChanged, event);
        deps.onSessionQueueChange?.();
      },
      onNotifyEvent: (event) => notifyHost.notify(event),
      log: (level, message, data) => logger.app("runtime", level, message, { data }),
    });
    // Memory measurement hook for the isolated soak harness
    // (`scripts/perf-memory-soak.mjs` with --inspect). Env-gated like the other
    // probes; without it nothing is attached and nothing is exported.
    if (process.env.MINIH_AGENT_MEMORY_PROBE === "1") {
      (globalThis as { __minihAgentMemoryProbe?: () => unknown }).__minihAgentMemoryProbe = () =>
        state.agentHostBridge?.eventStreamStats() ?? null;
    }
    // Desktop as a connected Host (rollout R5, ADR 0331). Creation is side
    // effect free; `open()` below applies the persisted switch and only then
    // creates the link service, its store, and its server.
    const gatewayLink = createGatewayLinkBootstrap({
      dataDir,
      // The real transport (PR-2): mTLS enrollment and the outbound Host link.
      port: racpGatewayLinkPort,
      encryption: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (buffer) => safeStorage.decryptString(buffer),
      },
      getSettings: async () => {
        const host = getHost();
        if (!host) return null;
        return host.call<AppSettings>("settings.get");
      },
      saveSettings: async (remoteGateway) => {
        const host = getHost();
        if (!host) {
          throw Object.assign(new Error("host-core is not running"), {
            errorCode: ErrorCodes.AGENT_UNAVAILABLE,
          });
        }
        await host.call("settings.set", { remoteGateway });
      },
      // Package D: a desktop-class device may configure and delete a session
      // here. Configuration and deletion are idle-only, and the app's own turn
      // bookkeeping is the only source of that answer.
      isSessionBusy: (sessionId: string) => isSessionBusy(sessionId),
      // The delete itself reuses the local handler (`session/delete` IPC), so a
      // remote delete runs the same cleanup the person at this computer gets:
      // cancelling a pending memory extraction, dropping queued persistence,
      // forgetting rewrite history, disposing the runtime session.
      removeSession: async (sessionId: string) => {
        await invokeIpc(IPC.invoke.sessionDelete, [sessionId]);
      },
      getHost,
      getAgentHost: () => {
        const bridge = state.agentHostBridge;
        if (!bridge) throw new Error("the agent host bridge is not ready");
        return bridge.agentHost;
      },
      serverVersion: APP_VERSION,
      emitStatus: (status) => sendToRenderer(IPC.event.remoteGatewayStatusChanged, status),
      // Account mode (D666): the confirmation dialog lives in the renderer, so
      // main pushes the request there and the notice beside it.
      emitDeviceRequest: (request) => sendToRenderer(IPC.event.remoteGatewayDeviceRequest, request),
      emitDeviceNotice: (notice) => sendToRenderer(IPC.event.remoteGatewayDeviceNotice, notice),
      // Account mode (R8 package E): the link tells this desktop when it is up
      // in account mode, and the join round above turns the account's other
      // computers into remote hosts. The outcome is returned, not swallowed: the
      // link reports it to the page and retries a failed round, and discovery
      // still never delays or fails the link itself.
      onAccountLinkUp: (input) => accountComputers.run(input),
      // Redacted push (§11.6): the link service carries the notifier to
      // `host.notify`, and the Agent Host above feeds it the four events.
      notifier: notifyHost,
      log: (level, message, data) =>
        logger.app("runtime", level, message, { data: formatRemoteLogData(data) }),
    });
    setActiveGatewayLink(gatewayLink);
    const control = createMcpControlController({
      invoke: invokeIpc,
      channels: IPC.invoke,
      invokeSessionCollaboration: deps.invokeSessionCollaboration,
      onOperationComplete: async (operation, result, args, source) => {
        const event = mcpControlRendererEvent(operation, result, args, source);
        if (event) sendToRenderer(IPC.event.sessionsChanged, event);
      },
    });
    state.desktopControl = control;
    plugins.setServices({ desktopControl: control });
    // Load the bundled model snapshot at startup without blocking the first
    // window. Startup neither fetches nor rewrites the catalog; the snapshot
    // is refreshed on demand from Settings (see models-dev-catalog / the
    // 13-model-catalog-and-selection spec).
    void modelsDevCatalog.ensureLoaded();
    let bootError: unknown = null;
    try {
      await bootBackends();
    } catch (error) {
      bootError = error;
      logger.app("runtime", "error", "backend boot failed", {
        code: ErrorCodes.HOST_UNAVAILABLE,
        data: String(error),
      });
    }
    if (!bootError) planUiProbe.install();
    // The gateway switch lives in AppSettings, which host-core serves, so the
    // link boots after the backends. With the feature off it creates nothing:
    // no store, no `RacpServer`, no socket (S12).
    if (!bootError) {
      void gatewayLink.open().catch((error: unknown) => {
        logger.app("runtime", "warn", "gateway link boot failed", { data: String(error) });
      });
    }
    const scheduledRunner = createScheduledRunner({
      getHost,
      execute: (id) => invokeIpc(IPC.invoke.scheduledExecute, [id, true]),
      report: (error) => logger.app("runtime", "warn", "scheduled task dispatch failed", { data: String(error) }),
    });
    scheduledRunner.start();
    app.once("before-quit", () => scheduledRunner.stop());
    if (!bootError && state.agentHostBridge) {
      // Restore the persisted turn queue now that host-core answers. Restored
      // entries stay held until a controller attaches (D375).
      state.agentHostBridge.agentHost.start().catch((error) => {
        logger.app("runtime", "warn", "agent host queue restore failed", {
          data: String(error),
        });
      });
    }
    const host = getHost();
    if (host) {
      try {
        const stored = (await host.call("settings.get")) as {
          language?: unknown;
          theme?: unknown;
          keybindings?: unknown;
          developerMode?: unknown;
          macosWindowTranslucency?: unknown;
          preventScreenSleep?: unknown;
          keepAwakeWhileRunning?: unknown;
        } | null;
        applyApplicationMenuSettings(stored);
        applyDeveloperMode(stored);
        applyMacosWindowTranslucency(stored);
        applyPreventScreenSleep(stored);
        applyKeepAwakeWhileRunning(stored);
        await applyNetworkProxyFromAppSettings(stored);
      } catch {
        // Keep the OS-locale menu until settings can be read again, while
        // retaining the historical default launcher fallback for this failure.
        applyPluginLauncherShortcut();
        applyPluginLauncherShortcut();
        applyToggleWindowShortcut();
      }
    } else {
      // If the backend never started, retain the default focused/global path.
      applyPluginLauncherShortcut();
      applyToggleWindowShortcut();
    }
    await ensureWindow();
    if (process.env.MINIH_AGENT_MCP_CONTROL === "1") {
      try {
        state.mcpControl = new McpControlServer({
          dataDir,
          invoke: invokeIpc,
          channels: IPC.invoke,
          version: APP_VERSION,
          port: process.env.MINIH_AGENT_MCP_PORT
            ? Number(process.env.MINIH_AGENT_MCP_PORT)
            : undefined,
          controller: state.desktopControl ?? undefined,
          log: (level, message, data) => logger.app("runtime", level, message, { data }),
        });
        await state.mcpControl.start();
      } catch (error) {
        logger.app("runtime", "warn", "MCP control server failed to start", {
          data: String(error),
        });
        state.mcpControl = null;
      }
    }
    // GitHub discovery is delayed and time-bounded. Never start it before the
    // first window exists: a hung feed used to sit in "checking" for ~60s and
    // compete with boot for the net stack.
    // Adopt legacy NSIS baselines before the delayed feed check can start. The
    // filesystem work runs after the first window exists and never blocks boot.
    void updater
      .reclaimRelocatedUpdateCache()
      .finally(() => updater.startAutoCheck());
    // createWindow awaits the initial load (loadFile resolves on
    // did-finish-load), so the page is up; give React a beat to mount its
    // event subscriptions before pushing the boot outcome.
    setTimeout(() => {
      sendToRenderer(IPC.event.hostStatus, bootHostStatus(bootError));
      state.applicationBooted = true;
      flushPendingApplicationMenuCommands();
    }, 300);

    // Headless boot probe for automated e2e (scripts/e2e-electron-boot.mjs):
    // verifies the preload bridge, IPC round-trips, and Ctrl+R guard, then quits.
    if (process.env.MINIH_AGENT_BOOT_PROBE === "1") {
      setTimeout(() => {
        void (async () => {
          try {
            const window = getMainWindow();
            const probe = await window!.webContents.executeJavaScript(
              `(async () => {
               const api = window.minihAgent;
               if (!api || typeof api.invoke !== "function") {
                 return { ok: false, reason: "preload api missing" };
               }
               const version = await api.invoke(api.channels.invoke.appGetVersion);
               const windowState =
                 api.platform === "darwin"
                   ? null
                   : await api.invoke(api.channels.invoke.windowControl, {
                       action: "getState",
                     });
               // Project removal channel: a path that cannot have a durable row
               // still has to survive preload -> main -> host-core and come back
               // as the documented idempotent no-op.
               const projectRemove = await api.invoke(
                 api.channels.invoke.projectRemove,
                 { path: "minih-agent-desktop-boot-probe-unknown-project" },
               );
               return {
                 ok: version?.ok === true,
                 version: version?.data?.version,
                 hostProtocol: version?.data?.hostProtocolVersion,
                 platform: api.platform,
                 maximized: windowState?.data?.maximized ?? null,
                 projectRemove: {
                   ok: projectRemove?.ok === true,
                   removed: projectRemove?.data?.removed ?? null,
                   sessionsRemoved: projectRemove?.data?.sessionsRemoved ?? null,
                 },
               };
             })()`,
            );
            let ctrlRPrevented = false;
            const observeCtrlR = (
              event: Electron.Event,
              input: Electron.Input,
            ) => {
              if (
                input.type === "keyDown" &&
                input.code === "KeyR" &&
                input.control &&
                !input.meta &&
                !input.alt &&
                !input.shift
              ) {
                ctrlRPrevented = event.defaultPrevented;
              }
            };
            window!.webContents.on("before-input-event", observeCtrlR);
            try {
              window!.webContents.sendInputEvent({
                type: "keyDown",
                keyCode: "R",
                modifiers: ["control"],
              });
              window!.webContents.sendInputEvent({
                type: "keyUp",
                keyCode: "R",
                modifiers: ["control"],
              });
              await new Promise((resolve) => setTimeout(resolve, 100));
            } finally {
              window!.webContents.removeListener(
                "before-input-event",
                observeCtrlR,
              );
            }
            probe.ctrlRBlocked = ctrlRPrevented;
            probe.appName = app.getName();
            probe.menuCount = Menu.getApplicationMenu()?.items.length ?? 0;
            if (!host || !window) throw new Error("session-list probe requires a healthy desktop");
            probe.sessionList = await runSessionListProbe({
              dataDir,
              host,
              window,
              catalog: modelsDevCatalog,
            });
            console.log("BOOT_PROBE", JSON.stringify(probe));
          } catch (error) {
            console.log(
              "BOOT_PROBE",
              JSON.stringify({ ok: false, reason: String(error) }),
            );
          } finally {
            app.quit();
          }
        })();
      }, 800);
    }
    // Supervision probe (scripts/e2e-supervision.mjs): SIGKILL our own
    // host-core child, then assert the supervisor brings a fresh one back
    // that answers RPCs. Deterministic crash-recovery e2e without pid hunts.
    if (process.env.MINIH_AGENT_SUPERVISION_PROBE === "1") {
      const initialHost = getHost();
      setTimeout(() => {
        logger.app("runtime", "info", "supervision probe: killing host-core");
        (initialHost as any)?.child?.kill("SIGKILL");
      }, 1500);
      const startedAt = Date.now();
      const poll = setInterval(() => {
        void (async () => {
          if (Date.now() - startedAt > 30_000) {
            clearInterval(poll);
            console.log(
              "SUPERVISION_PROBE",
              JSON.stringify({ ok: false, reason: "timeout" }),
            );
            app.quit();
            return;
          }
          const currentHost = getHost();
          if (!currentHost || currentHost === initialHost) return;
          try {
            const health = await currentHost.call<{ ok: boolean }>("app.health");
            clearInterval(poll);
            console.log(
              "SUPERVISION_PROBE",
              JSON.stringify({ ok: health.ok === true, restarted: true }),
            );
            app.quit();
          } catch {
            // restart still settling; keep polling
          }
        })();
      }, 500);
    }
  });
}
