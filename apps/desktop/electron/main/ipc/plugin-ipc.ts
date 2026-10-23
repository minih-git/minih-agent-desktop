import { dialog } from "electron";
import { IPC, type ActivationScope } from "@minih-agent/shared";
import { isTemplateName, scaffold } from "@minih-agent/plugin-devkit";
import { resolvePluginLocalizedString } from "@minih-agent/plugin-sdk";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { BrowserHost } from "../browser-host";
import type { HostProcess } from "../host-process";
import { BROWSER_PLUGIN_ID } from "../browser-host";
import type { Logger } from "../logger";
import {
  readDevPluginDeclaration,
  widenedFsScope,
  type PluginRuntime,
} from "../plugin-runtime";
import { PluginViewHost } from "../plugin-view-host";
import { rendererCallError } from "../plugin-renderer-extension";
import type { IpcRegistrar } from "./types";

export type PluginIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  plugins: PluginRuntime;
  agentExtensions: AgentExtensionBridge;
  browserHost: BrowserHost;
  pluginViews: PluginViewHost;
  pluginScopes: Map<string, ActivationScope>;
  rememberPluginScopes: (list: any[]) => void;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  logger: Pick<Logger, "app">;
  /** Active app locale, for the manifest's own display strings. */
  getUpdaterLocale: () => string;
  /**
   * Asks the named plugins what the user would lose, and returns `false` when
   * they declined. Every user-initiated teardown below asks it before its first
   * side effect (spec 07-plugins/05 §3.0).
   */
  confirmInterruption: (ids: readonly string[]) => Promise<boolean>;
};

/** Register plugin lifecycle, settings and installation channels. */
export function registerPluginIpc({
  registrar,
  getHost,
  plugins,
  agentExtensions,
  browserHost,
  pluginViews,
  pluginScopes,
  rememberPluginScopes,
  sendToRenderer,
  logger,
  getUpdaterLocale,
  confirmInterruption,
}: PluginIpcDependencies): void {
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };

  /**
   * Register a development plugin folder, load it with the permissions the user
   * just approved, and arm the watcher whose ceiling is that approval.
   *
   * `plugins.loadDev` rewrites the registry row from the manifest, so the row
   * always states the current declaration; `loadFromPath` filters the approval
   * through that declaration, so an answer can never exceed the request.
   */
  const loadDevPlugin = async (
    path: string,
    grantedPermissions: string[] = [],
    reason: "loadDev" | "reload",
  ) => {
    if (!host) throw new Error("host unavailable");
    const loaded = await host.call<{ plugin: any }>("plugins.loadDev", { path });
    await plugins.loadFromPath(path, grantedPermissions, { development: true });
    if (loaded.plugin?.id) plugins.watchDevPlugin(loaded.plugin.id);
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged, {
      reason,
      pluginId: loaded.plugin?.id,
    });
    return loaded;
  };

  /**
   * The manifest's own `safetyNotes`, resolved for the active locale.
   *
   * A review that lists permissions but omits what the author says the plugin
   * does with native access is not informed consent, and plugin entry code is
   * not sandboxed. Missing notes stay missing: the review never invents a
   * reassuring line (spec 07-plugins/04 §4.1).
   */
  const declaredSafetyNotes = (manifest: {
    i18n?: Record<string, { safetyNotes?: string }>;
  }): string | undefined => {
    const resolved = resolvePluginLocalizedString(
      {
        en: manifest.i18n?.en?.safetyNotes ?? "",
        "zh-CN": manifest.i18n?.["zh-CN"]?.safetyNotes ?? "",
      },
      getUpdaterLocale(),
      "",
    );
    return resolved.trim() || undefined;
  };

  /** A development plugin folder as a review the renderer can render. */
  const reviewFor = (
    path: string,
    kind: "load" | "reload",
    addedPermissions: string[] = [],
  ) => {
    const declared = readDevPluginDeclaration(path);
    return {
      kind,
      path,
      id: declared.manifest.id,
      name: declared.manifest.name,
      version: declared.manifest.version,
      permissions: declared.permissions,
      addedPermissions,
      safetyNotes: declaredSafetyNotes(declared.manifest),
    };
  };

  /**
   * What a manifest edit asks for beyond the current approval. Both the manual
   * reload and the hot reload answer this the same way, so a save and a click
   * cannot disagree about whether the user has to decide.
   */
  const beyondApproval = (pluginId: string, path: string) => {
    const approval = plugins.devApproval(pluginId);
    const declared = readDevPluginDeclaration(path);
    if (!approval) {
      // Never reviewed in this session: the load itself is the review.
      return { declared, added: declared.permissions, widened: [] as string[] };
    }
    const ceiling = new Set(approval.permissions);
    return {
      declared,
      added: declared.permissions.filter((permission) => !ceiling.has(permission)),
      widened: widenedFsScope(approval.fs, declared.fs),
    };
  };
  handle(IPC.invoke.pluginList, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await host.call<{ plugins: any[] }>("plugins.list");
    rememberPluginScopes(result.plugins ?? []);
    const pluginsWithSettings = await Promise.all(
      (result.plugins ?? []).map(async (plugin) => {
        const extensionIds = plugins
          .getAgentExtensions()
          .filter((extension) => extension.pluginId === plugin?.id)
          .map((extension) => extension.id);
        const withExtension = extensionIds.length
          ? { ...plugin, agentExtension: agentExtensions.statusForPlugin(extensionIds) }
          : plugin;
        // The renderer host loads from the live load, never from the registry
        // row: a plugin that is not running has nothing to load.
        const renderer = plugin?.id ? plugins.rendererDescriptor(plugin.id) : undefined;
        const withRenderer = renderer ? { ...withExtension, renderer } : withExtension;
        const withComposerTransforms = plugin?.id
          ? { ...withRenderer, composerTransforms: plugins.getComposerTransforms(plugin.id) }
          : withRenderer;
        if (!plugin?.settings?.length || !plugins.getLoaded(plugin.id)) return withComposerTransforms;
        try {
          const settings = await plugins.getPluginSettings(plugin.id);
          return { ...withComposerTransforms, settings };
        } catch {
          return withComposerTransforms;
        }
      }),
    );
    return { ...result, plugins: pluginsWithSettings };
  });

  // Renderer extensions run in the main window only (`PluginRendererHost`),
  // so no other window may relay into a plugin's headless entry.
  registrar.handleWithEvent(
    IPC.invoke.pluginRendererCall,
    async (event, pluginId: unknown, method: unknown, args: unknown) => {
      registrar.assertMainWindowSender(event);
      if (typeof pluginId !== "string" || !pluginId || typeof method !== "string" || !method) {
        throw rendererCallError("INVALID_ARGUMENT", "pluginId and method are required");
      }
      return plugins.callRenderer(pluginId, method, args);
    },
  );

  registrar.handleWithEvent(
    IPC.invoke.pluginComposerTransform,
    async (event, payload: unknown) => {
      registrar.assertMainWindowSender(event);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw rendererCallError("INVALID_ARGUMENT", "composer transform input is invalid");
      }
      const input = payload as Record<string, unknown>;
      if (
        typeof input.pluginId !== "string" ||
        typeof input.id !== "string" ||
        typeof input.text !== "string" ||
        (input.modelKey !== undefined && typeof input.modelKey !== "string")
      ) {
        throw rendererCallError("INVALID_ARGUMENT", "composer transform input is invalid");
      }
      return plugins.runComposerTransform({
        pluginId: input.pluginId,
        id: input.id,
        text: input.text,
        ...(typeof input.modelKey === "string" ? { modelKey: input.modelKey } : {}),
      });
    },
  );

  handle(IPC.invoke.pluginSettingsGet, async (id: string) => {
    const settings = await plugins.getPluginSettings(String(id ?? ""));
    return { settings };
  });

  handle(
    IPC.invoke.pluginSettingsSet,
    async (payload: { id?: string; settings?: Record<string, unknown> }) => {
      const settings = await plugins.setPluginSettings(
        String(payload?.id ?? ""),
        payload?.settings ?? {},
      );
      sendToRenderer(IPC.event.pluginChanged,{
        reason: "settings",
        pluginId: String(payload?.id ?? ""),
      });
      return { settings };
    },
  );

  handle(IPC.invoke.pluginLoadDev, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    // Picking the folder is not the grant. The folder declares what it wants,
    // the user answers, and only then is anything registered or loaded.
    return { canceled: false, review: reviewFor(result.filePaths[0], "load") };
  });

  handle(
    IPC.invoke.pluginLoadDevConfirm,
    async (input: { path?: unknown; grantedPermissions?: unknown }) => {
      if (!host) throw new Error("host unavailable");
      const path = typeof input?.path === "string" ? input.path : "";
      if (!path) throw new Error("INVALID_PARAMS: path required");
      const granted = Array.isArray(input?.grantedPermissions)
        ? input.grantedPermissions.filter(
            (permission): permission is string => typeof permission === "string",
          )
        : [];
      const loaded = await loadDevPlugin(path, granted, "loadDev");
      return { ...loaded, grantedPermissions: granted };
    },
  );

  handle(IPC.invoke.pluginReload, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const listed = await host.call<{ plugins: any[] }>("plugins.list");
    const plugin = (listed.plugins ?? []).find((candidate) => candidate?.id === id);
    if (!plugin?.path) throw new Error(`PLUGIN_NOT_FOUND: ${id}`);
    if (plugin.source === "dev") {
      // A manifest edit is a request for more, and the approval is the answer:
      // it is never widened by loading. Ask the user first instead.
      const { added, widened } = beyondApproval(id, plugin.path);
      if (added.length || widened.length) {
        return {
          plugin,
          review: reviewFor(plugin.path, "reload", [...added, ...widened]),
        };
      }
    }
    // The reload is about to unload and reload: ask before anything is closed.
    if (!(await confirmInterruption([id]))) return { plugin, canceled: true };
    await plugins.loadFromPath(plugin.path, plugin.permissions ?? [], {
      development: plugin.source === "dev",
    });
    if (plugin.source === "dev") plugins.watchDevPlugin(id);
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{ reason: "reload", pluginId: id });
    return { plugin };
  });

  handle(
    IPC.invoke.pluginReloadConfirm,
    async (input: { id?: unknown; grantedPermissions?: unknown }) => {
      if (!host) throw new Error("host unavailable");
      const id = typeof input?.id === "string" ? input.id : "";
      if (!id) throw new Error("INVALID_PARAMS: id required");
      const listed = await host.call<{ plugins: any[] }>("plugins.list");
      const plugin = (listed.plugins ?? []).find((candidate) => candidate?.id === id);
      if (!plugin?.path) throw new Error(`PLUGIN_NOT_FOUND: ${id}`);
      const granted = Array.isArray(input?.grantedPermissions)
        ? input.grantedPermissions.filter(
            (permission): permission is string => typeof permission === "string",
          )
        : [];
      if (!(await confirmInterruption([id]))) return { canceled: true };
      const loaded = await loadDevPlugin(plugin.path, granted, "reload");
      return { ...loaded, grantedPermissions: granted };
    },
  );

  // Scaffold a starter plugin and load it as a dev plugin in one step (D171),
  // so "I want to write a plugin" never starts with an empty folder. The
  // scaffold only writes files; loading waits for the same review as a folder
  // picked by hand.
  handle(
    IPC.invoke.pluginCreateFromTemplate,
    async (req: { template?: string }) => {
      if (!host) throw new Error("host unavailable");
      const template = req?.template;
      if (!isTemplateName(template)) {
        throw new Error(`unknown plugin template: ${String(template)}`);
      }
      const picked = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) {
        return { canceled: true };
      }
      const dir = picked.filePaths[0];
      const created = await scaffold({ dir, template });
      return {
        id: created.id,
        name: created.name,
        dir: created.dir,
        files: created.files,
        review: reviewFor(dir, "load"),
      };
    },
  );

  handle(IPC.invoke.pluginInstallFromPath, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const path = result.filePaths[0];
    // Reinstalling over a running plugin replaces its files: ask first, while
    // the declaration at that folder still says which plugin that is.
    const declaredId = readDevPluginDeclaration(path).manifest.id;
    if (!(await confirmInterruption([declaredId]))) return { canceled: true };
    const installed = await host.call<{ result: any }>("plugins.installFromPath", {
      path,
      enable: true,
    });
    if (installed.result?.plugin?.enabled && installed.result?.plugin?.path) {
      await plugins.loadFromPath(
        installed.result.plugin.path,
        installed.result.plugin.permissions ?? [],
      );
    }
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "install",
      pluginId: installed.result?.plugin?.id,
    });
    return installed;
  });

  handle(IPC.invoke.pluginInstallFromPackage, async () => {
    if (!host) throw new Error("host unavailable");
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "PI Plugin", extensions: ["piplug", "zip"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }
    const path = result.filePaths[0];
    // The archive's id is only inside the archive, so ask the host to read it
    // without installing: nothing on disk or in the registry is touched, and the
    // answer carries the checksum the file must still have at install time.
    const inspected = await host.call<{
      inspection: {
        id: string;
        name: string;
        version: string;
        shasum: string;
        installedVersion?: string | null;
        upgraded: boolean;
      };
    }>("plugins.inspectPackage", { path });
    const inspection = inspected?.inspection;
    if (!inspection?.id || !inspection.shasum) {
      throw new Error("PLUGIN_INVALID: package inspection returned no plugin identity");
    }
    // Asked and answered before the first byte of the installed copy changes.
    if (!(await confirmInterruption([inspection.id]))) return { canceled: true };
    const installed = await host.call<{ result: any }>("plugins.installFromPackage", {
      path,
      enable: true,
      // The package the user agreed to, not whatever is at that path now: the
      // host refuses the install when the bytes changed in between.
      expectedShasum: inspection.shasum,
    });
    if (installed.result?.plugin?.enabled && installed.result?.plugin?.path) {
      await plugins.loadFromPath(
        installed.result.plugin.path,
        installed.result.plugin.permissions ?? [],
      );
    }
    for (const toast of plugins.drainToasts()) {
      sendToRenderer(IPC.event.toast, { message: toast });
    }
    sendToRenderer(IPC.event.pluginChanged,{
      reason: "install",
      pluginId: installed.result?.plugin?.id,
    });
    return installed;
  });

  handle(IPC.invoke.pluginEnable, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ plugin: any }>("plugins.enable", { id });
    if (res.plugin?.path) {
      await plugins.loadFromPath(res.plugin.path, res.plugin.permissions ?? [], {
        development: res.plugin.source === "dev",
      });
      if (res.plugin.source === "dev") plugins.watchDevPlugin(id);
    }
    logger.app("plugin", "info", "plugin enabled", { pluginId: id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "enable", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginDisable, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    // Before the view is closed, the services stopped, and the host unloaded.
    if (!(await confirmInterruption([id]))) return { canceled: true };
    pluginViews.closePlugin(id);
    if (id === BROWSER_PLUGIN_ID) browserHost.disposeGuest();
    await plugins.unload(id);
    logger.app("plugin", "info", "plugin disabled", { pluginId: id });
    const res = await host.call("plugins.disable", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "disable", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginUninstall, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    if (!(await confirmInterruption([id]))) return { canceled: true };
    pluginViews.closePlugin(id);
    await plugins.unload(id);
    logger.app("plugin", "info", "plugin uninstalled", { pluginId: id });
    const res = await host.call("plugins.uninstall", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "uninstall", pluginId: id });
    return res;
  });

  handle(IPC.invoke.pluginSetAutoUpdate, async (payload: { id: string; enabled: boolean }) => {
    if (!host) throw new Error("host unavailable");
    return host.call("plugins.setAutoUpdate", {
      id: payload.id,
      enabled: payload.enabled,
    });
  });

  handle(
    IPC.invoke.pluginSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call<{ plugin?: { id?: string; scope?: ActivationScope } }>(
        "plugins.setScope",
        { id: payload.id, scope: payload.scope },
      );
      // Keep the dispatch-path cache honest without waiting for the next list.
      if (res.plugin?.id && res.plugin.scope) {
        pluginScopes.set(res.plugin.id, res.plugin.scope);
      }
      logger.app("plugin", "info", "plugin scope changed", {
        pluginId: payload.id,
        data: { mode: payload.scope?.mode, projects: payload.scope?.projects?.length ?? 0 },
      });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "scope", pluginId: payload.id });
      return res;
    },
  );

  // --- MCP servers the user owns -------------------------------------------
  // host-core persists and validates; this side owns the connections, so every
  // mutation is followed by a refresh that drops stale ones.
}
