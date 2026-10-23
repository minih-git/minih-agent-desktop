import { app, globalShortcut, type Tray } from "electron";
import type { CloseBehavior } from "@minih-agent/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { BrowserHost } from "../browser-host";
import type { HostProcess } from "../host-process";
import type { InflightCheckpointer } from "@minih-agent/host-runtime";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginPanelHost } from "../plugin-panel-host";
import type { PluginRuntime } from "../plugin-runtime";
import type { PluginViewHost } from "../plugin-view-host";
import type { AppUpdaterController } from "../updater";
import type { UserMcpRuntime } from "../user-mcp";
import type { McpControlServer } from "../mcp-control";
import type { McpOAuthManager } from "../mcp-oauth";
import { getActiveRemoteHostsBoot, setActiveRemoteHostsBoot } from "./remote-hosts";
import { getActiveGatewayLink, setActiveGatewayLink } from "./gateway-link";
import type { LiveCallService } from "../live-voice/call-service";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { FinishTurn } from "../runtime/plans";
import { markTurnInterrupted, settleInterruptedTurn } from "../runtime/turn-interrupt";

const QUIT_TURN_SETTLE_BUDGET_MS = 2_000;

type AgentHostShutdownHandle = Pick<AgentHostBridge, "markAborting"> & { dispose?: () => void };
export type ShutdownState = {
  shutdownComplete: boolean;
  shutdownPromise: Promise<void> | null;
  quitting: boolean;
  quitConfirmed: boolean;
  closeBehavior: CloseBehavior;
  tray: Tray | null;
  pluginLauncherAccelerator: string | null;
  toggleWindowAccelerator: string | null;
};

export type ShutdownDependencies = {
  hasSingleInstanceLock: boolean;
  state: ShutdownState;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getMcpControl: () => McpControlServer | null;
  activeTurns: Map<string, string>;
  persistenceOutbox: PersistenceOutbox;
  inflightCheckpointer: InflightCheckpointer;
  flushEventPersistence: () => Promise<void>;
  pluginPanels: Pick<PluginPanelHost, "closeAll">;
  plugins: Pick<PluginRuntime, "disposeAll">;
  userMcp: Pick<UserMcpRuntime, "disposeAll">;
  mcpOAuth?: Pick<McpOAuthManager, "disposeAll">;
  browserHost: Pick<BrowserHost, "dispose">;
  pluginViews: Pick<PluginViewHost, "dispose">;
  updater: Pick<AppUpdaterController, "dispose" | "isInstallingUpdate">;
  logger: Pick<Logger, "app">;
  confirmQuitDialog: () => Promise<boolean>;
  disposePowerSaveBlockers: () => void;
  liveCallService?: Pick<LiveCallService, "endForLifecycle">;
  disposeSystemProxyRelay?: () => Promise<void>;
  /**
   * The optional extractor: quitting cancels its pending runs, so no model call
   * outlives the app (ADR agent-long-term-memory §4). Absent in a fixture that
   * exercises no learned memory at all.
   */
  disposeMemoryExtraction?: () => void;
  /** Terminal-owner hooks the quit settlement shares with the in-app Stop path. */
  finishTurn: FinishTurn;
  lockAbortReason: (sessionId: string, turnId: string | null | undefined) => void;
  getAgentHostBridge: () => AgentHostShutdownHandle | null;
};

/** Register the last-window and before-quit resource lifecycle handlers. */
export function registerShutdownHandlers({
  hasSingleInstanceLock,
  state,
  getHost,
  getSidecar,
  getMcpControl,
  finishTurn,
  lockAbortReason,
  getAgentHostBridge,
  activeTurns,
  persistenceOutbox,
  inflightCheckpointer,
  flushEventPersistence,
  pluginPanels,
  plugins,
  userMcp,
  mcpOAuth,
  browserHost,
  pluginViews,
  updater,
  logger,
  confirmQuitDialog,
  disposePowerSaveBlockers,
  liveCallService,
  disposeSystemProxyRelay,
  disposeMemoryExtraction,
}: ShutdownDependencies): void {
  app.on("window-all-closed", () => {
    // The D216 tray is resident on every platform, so its presence says nothing
    // about whether the app should survive a closed window — the user's close
    // behavior does. Under "tray" a window destroyed for any reason must not
    // take the app down (the tray click recreates it); otherwise closing the
    // last window on Windows/Linux exits the app as before.
    if (process.platform === "darwin") return;
    if (state.closeBehavior === "tray" && state.tray) return;
    app.quit();
  });

  app.on("before-quit", (event) => {
    // A duplicate launch has no host, sidecar, panel, or outbox of its own, and
    // the shutdown sequence below would write into the running instance's data
    // directory. Let it exit straight away.
    if (!hasSingleInstanceLock) return;
    if (state.shutdownComplete) return;
    event.preventDefault();
    if (state.shutdownPromise) return;

    // Show a confirmation dialog on the first explicit quit (Cmd+Q, tray quit,
    // application-menu Quit). The data-saving shutdown runs after confirmation.
    // Skip confirmation in automated probe/capture modes where no human is
    // present to interact with the dialog.
    const isAutomatedMode =
      process.env.MINIH_AGENT_BOOT_PROBE === "1" ||
      process.env.MINIH_AGENT_SUPERVISION_PROBE === "1" ||
      process.env.MINIH_AGENT_CAPTURE === "1";
    // Skip confirmation for the quit that an in-app update performs. The
    // installer for that update was already spawned before app.quit(), and it
    // aborts once the app stays alive for a few seconds, so deferring this quit
    // behind a dialog fails the update. There is no decision left either: the
    // user chose "restart to update" to get here.
    const isUpdateRestart = updater.isInstallingUpdate();
    if (!state.quitConfirmed && !isAutomatedMode && !isUpdateRestart) {
      state.quitConfirmed = true;
      void confirmQuitDialog().then((confirmed) => {
        if (confirmed) {
          app.quit();
        } else {
          // User cancelled: allow future quit requests to prompt again.
          state.quitConfirmed = false;
        }
      });
      return;
    }

    state.quitting = true;
    // Persist the confirmed shutdown before any awaited cleanup so a forced
    // process termination still leaves an observable lifecycle boundary.
    logger.app("lifecycle", "info", "app shutdown");
    // Nothing extracts while the app is closing: the pending debounces go now,
    // before any awaited cleanup, so no model call starts behind the quit.
    disposeMemoryExtraction?.();
    disposePowerSaveBlockers();
    // Stop the Agent Host's housekeeping timer before the ordered shutdown: it
    // must not fire a sweep against a host that is being torn down.
    getAgentHostBridge()?.dispose?.();
    state.tray?.destroy();
    state.tray = null;
    if (state.pluginLauncherAccelerator) {
      globalShortcut.unregister(state.pluginLauncherAccelerator);
      state.pluginLauncherAccelerator = null;
    }
    if (state.toggleWindowAccelerator) {
      globalShortcut.unregister(state.toggleWindowAccelerator);
      state.toggleWindowAccelerator = null;
    }
    state.shutdownPromise = (async () => {
      await liveCallService?.endForLifecycle("app-quit");
      // Close every paired remote host before the local host-core so any
      // in-flight remote turn's abort still goes over a live socket. Bounded
      // parallelism inside `closeAll`; safe to run before local disposals.
      const remoteHostsShutdown = getActiveRemoteHostsBoot()?.closeAll();
      setActiveRemoteHostsBoot(null);
      // The desktop Host link closes before host-core goes away, so a remote
      // device sees a clean link close instead of a dangling relay.
      const gatewayLinkShutdown = getActiveGatewayLink()?.dispose();
      setActiveGatewayLink(null);
      // Replies still streaming are stopped through the sidecar first so their
      // aborted final rows can reach the transcript while host-core is alive;
      // whatever does not make it in time is covered by the last checkpoint
      // (D299). Bounded: a quit must not hang on an unresponsive provider.
      await settleRunningTurnsForQuit({
        activeTurns,
        getHost,
        getSidecar,
        inflightCheckpointer,
        persistenceOutbox,
        logger,
        finishTurn,
        lockAbortReason,
        getAgentHostBridge,
      });
      // Panel windows and docked views are the only pages that call the plugin
      // runtime over the panel bridge. They are torn down, and their pages are
      // waited for, before the runtime and the host stop: a call such a page
      // already sent while its surface was closing is otherwise answered by a
      // runtime that is already shutting down, and surfaces as a bridge failure
      // nobody can act on. The wait is bounded inside the hosts, so a page that
      // refuses to close cannot hold up the quit.
      const pluginSurfacesShutdown = Promise.allSettled([
        pluginPanels.closeAll(),
        pluginViews.dispose(),
      ]);
      await pluginSurfacesShutdown;
      // Stop event production before draining the terminal writes. A finished
      // turn can already have left activeTurns while its branch archive is
      // still awaiting the host; closing host-core first loses that archive.
      const sidecarShutdown = getSidecar()?.dispose();
      await Promise.allSettled([sidecarShutdown]);
      await inflightCheckpointer.flushAll();
      let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          flushEventPersistence().then(() => true),
          new Promise<boolean>((resolve) => {
            persistenceTimer = setTimeout(() => resolve(false), QUIT_TURN_SETTLE_BUDGET_MS);
          }),
        ]);
        if (!settled) {
          logger.app("lifecycle", "warn", "quit before event persistence settled");
        }
      } finally {
        if (persistenceTimer) clearTimeout(persistenceTimer);
      }
      await persistenceOutbox.flush(getHost);
      const hostShutdown = getHost()?.dispose();
      const mcpShutdown = getMcpControl()?.stop();
      updater.dispose();
      // Plugin hosts are stopped as a shutdown, not left for the process teardown
      // to kill: an unannounced exit is indistinguishable from a crash, and would
      // end every quit in error logs, toasts, and restarts into a closing app.
      const pluginShutdown = plugins.disposeAll();
      userMcp.disposeAll();
      mcpOAuth?.disposeAll();
      browserHost.dispose();
      inflightCheckpointer.dispose();

      try {
        await hostShutdown;
      } catch (error) {
        logger.app("lifecycle", "warn", "host shutdown failed", { data: String(error) });
      }
      await Promise.allSettled([
        pluginShutdown,
        sidecarShutdown,
        mcpShutdown,
        remoteHostsShutdown,
        gatewayLinkShutdown,
      ]);
      await disposeSystemProxyRelay?.();
    })();

    const releaseQuit = () => {
      state.shutdownComplete = true;
      app.quit();
    };
    void state.shutdownPromise.then(releaseQuit, releaseQuit);
  });
}

type TurnSettlementDependencies = {
  activeTurns: Map<string, string>;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  inflightCheckpointer: InflightCheckpointer;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
  /** The finalizer and cancellation lock every terminal path shares. */
  finishTurn: FinishTurn;
  lockAbortReason: (sessionId: string, turnId: string | null | undefined) => void;
  /** Agent Host's cancellation record; absent when no agent host is running. */
  getAgentHostBridge: () => AgentHostShutdownHandle | null;
};

async function settleRunningTurnsForQuit({
  activeTurns,
  getHost,
  getSidecar,
  inflightCheckpointer,
  persistenceOutbox,
  logger,
  finishTurn,
  lockAbortReason,
  getAgentHostBridge,
}: TurnSettlementDependencies): Promise<void> {
  const sessions = [...activeTurns.entries()];
  const deadline = Date.now() + QUIT_TURN_SETTLE_BUDGET_MS;
  // The newest snapshot of every streaming reply lands first: it is the
  // fallback if the abort below does not produce a final row in time.
  await inflightCheckpointer.flushAll();
  if (sessions.length === 0) {
    await persistenceOutbox.flush(getHost);
    return;
  }
  const sidecar = getSidecar();
  const agentHostBridge = getAgentHostBridge();
  const interruptDeps = {
    lockAbortReason,
    finishTurn,
    ...(agentHostBridge
      ? { markAborting: (id: string) => agentHostBridge.markAborting(id) }
      : {}),
  };
  // Quit interrupts every running turn; it never completes one. The reason is
  // recorded before the cancel request leaves, so the clean `agent_end` that
  // follows stops settling the turn as `completed` — which also filed a
  // `task.completed` notification for a reply the user never received. Each
  // turn is settled here as well, so a terminal event that never lands cannot
  // leave it `running`.
  const settlements = sessions.map(async ([sessionId, turnId]) => {
    markTurnInterrupted(interruptDeps, sessionId, turnId);
    if (sidecar) {
      await Promise.race([
        sidecar.call("agent.abort", { sessionId, turnId }),
        new Promise((resolve) => setTimeout(resolve, 800)),
      ]);
    }
    await settleInterruptedTurn(interruptDeps, sessionId, turnId);
  });
  await Promise.race([
    Promise.allSettled(settlements),
    new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, deadline - Date.now())),
    ),
  ]);
  // The abort surfaces as message_end + error/agent_end, which finishTurn
  // turns into a settled turn and an outbox append. Wait for that, bounded.
  while (Date.now() < deadline) {
    await persistenceOutbox.flush(getHost);
    if (activeTurns.size === 0 && persistenceOutbox.size() === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await persistenceOutbox.flush(getHost);
  if (activeTurns.size > 0 || persistenceOutbox.size() > 0) {
    logger.app("lifecycle", "warn", "quit before streaming replies settled", {
      data: { running: activeTurns.size, pendingAppends: persistenceOutbox.size() },
    });
  }
}
