export const PROTOCOL_VERSION = 12 as const;
export const SCHEMA_VERSION = 16 as const;
/**
 * Pre-branding constants, kept for backward compatibility: persisted schema
 * fields, tests, and external tooling compare against these minih values.
 * User-visible identity comes from `currentAppName` / `currentAppId`, which
 * resolve the brand this bundle was built for (see ./brand.ts).
 */
export const APP_ID = "org.hmini.agent";
export const APP_NAME = "Minih-Agent-Desktop";
export const APP_VERSION = "0.25.0";

export const APP_MENU_COMMANDS = [
  "newTask",
  "openProject",
  "openSettings",
  "openSearch",
  "openCommandPalette",
  "toggleSidebar",
  "openHelp",
  "openLogs",
  "checkForUpdates",
] as const;

export type AppMenuCommand = (typeof APP_MENU_COMMANDS)[number];

export const NATIVE_MENU_ACTIONS = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "reload",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "toggleFullScreen",
  "minimize",
  "toggleMaximize",
  "close",
  "restoreMainWindow",
  "toggleMainWindow",
] as const;

export type NativeMenuAction = (typeof NATIVE_MENU_ACTIONS)[number];

export const WINDOW_CONTROL_ACTIONS = [
  "getState",
  "minimize",
  "toggleMaximize",
  "close",
] as const;

export type WindowControlAction = (typeof WINDOW_CONTROL_ACTIONS)[number];

export const IPC = {
  invoke: {
    storageGet: "minih-agent-desktop/storage/get",
    storageChoose: "minih-agent-desktop/storage/choose",
    storageMigrate: "minih-agent-desktop/storage/migrate",
    storageClearCache: "minih-agent-desktop/storage/clearCache",
    storageRemoveBackup: "minih-agent-desktop/storage/removeBackup",
    appGetVersion: "minih-agent-desktop/app/getVersion",
    appOpenFeedback: "minih-agent-desktop/app/openFeedback",
    appHealth: "minih-agent-desktop/app/health",
    appGetOnboarding: "minih-agent-desktop/app/getOnboarding",
    appDismissOnboarding: "minih-agent-desktop/app/dismissOnboarding",
    /**
     * Quit the whole application through the ordered shutdown. Exposed for the
     * surfaces that own the window while the shell has no data yet — a stuck
     * startup must always be able to exit the app (issue #831).
     */
    appQuit: "minih-agent-desktop/app/quit",
    /** Installed system font families, resolved by Electron main. */
    systemFontsList: "minih-agent-desktop/app/systemFonts",
    updatesGetState: "minih-agent-desktop/updates/getState",
    updatesCheck: "minih-agent-desktop/updates/check",
    updatesDownload: "minih-agent-desktop/updates/download",
    updatesInstall: "minih-agent-desktop/updates/install",
    updatesOpenReleases: "minih-agent-desktop/updates/openReleases",
    /** Persist the user's decision to stop nudging about one version (#1317). */
    updatesDismiss: "minih-agent-desktop/updates/dismiss",
    notificationList: "minih-agent-desktop/notification/list",
    notificationMarkRead: "minih-agent-desktop/notification/markRead",
    notificationMarkAllRead: "minih-agent-desktop/notification/markAllRead",
    notificationClear: "minih-agent-desktop/notification/clear",
    notificationShowNative: "minih-agent-desktop/notification/showNative",
    notificationRecordPrompt: "minih-agent-desktop/notification/recordPrompt",
    notificationSetViewingSession: "minih-agent-desktop/notification/setViewingSession",
    agentPrompt: "minih-agent-desktop/agent/prompt",
    agentSteer: "minih-agent-desktop/agent/steer",
    agentSideNote: "minih-agent-desktop/agent/sideNote",
    agentSideNotesList: "minih-agent-desktop/agent/sideNotesList",
    speechTranscribe: "minih-agent-desktop/speech/transcribe",
    speechSynthesize: "minih-agent-desktop/speech/synthesize",
    speechGetStatus: "minih-agent-desktop/speech/getStatus",
    voiceStart: "minih-agent-desktop/voice/start",
    voiceStop: "minih-agent-desktop/voice/stop",
    voiceCancel: "minih-agent-desktop/voice/cancel",
    voiceGetState: "minih-agent-desktop/voice/getState",
    voiceGetDevices: "minih-agent-desktop/voice/getDevices",
    voiceGetModels: "minih-agent-desktop/voice/getModels",
    voiceDownloadModel: "minih-agent-desktop/voice/downloadModel",
    voiceDeleteModel: "minih-agent-desktop/voice/deleteModel",
    voiceUpdateSettings: "minih-agent-desktop/voice/updateSettings",
    voiceCheckPermission: "minih-agent-desktop/voice/checkPermission",
    voiceRequestPermission: "minih-agent-desktop/voice/requestPermission",
    liveVoiceStatus: "minih-agent-desktop/voice/live/status",
    liveVoicePrepare: "minih-agent-desktop/voice/live/prepare",
    liveVoiceConnect: "minih-agent-desktop/voice/live/connect",
    liveVoiceSetMuted: "minih-agent-desktop/voice/live/setMuted",
    liveVoiceReportMedia: "minih-agent-desktop/voice/live/reportMedia",
    liveVoiceReportPlayback: "minih-agent-desktop/voice/live/reportPlayback",
    liveVoiceReportDelegation: "minih-agent-desktop/voice/live/reportDelegation",
    liveVoiceReportControlApplied: "minih-agent-desktop/voice/live/reportControlApplied",
    liveVoiceEnd: "minih-agent-desktop/voice/live/end",
    liveVoiceHeartbeat: "minih-agent-desktop/voice/live/heartbeat",
    liveVoiceResolveWorkSelection: "minih-agent-desktop/voice/live/work/resolveSelection",
    liveVoiceStopWorkOperation: "minih-agent-desktop/voice/live/work/stopOperation",
    liveVoiceCancelQueuedOperation: "minih-agent-desktop/voice/live/work/cancelQueuedOperation",
    liveVoiceWidgetAction: "minih-agent-desktop/voice/live/widget/action",
    liveVoiceWidgetOwnerState: "minih-agent-desktop/voice/live/widget/ownerState",
    liveVoiceWidgetVisibility: "minih-agent-desktop/voice/live/widget/visibility",
    agentCompact: "minih-agent-desktop/agent/compact",
    agentAbort: "minih-agent-desktop/agent/abort",
    agentStopSubagents: "minih-agent-desktop/agent/stop-subagents",
    agentStop: "minih-agent-desktop/agent/stop",
    agentQueuePush: "minih-agent-desktop/agent/queue/push",
    agentQueueList: "minih-agent-desktop/agent/queue/list",
    agentQueueRemove: "minih-agent-desktop/agent/queue/remove",
    agentQueuePrioritize: "minih-agent-desktop/agent/queue/prioritize",
    agentQueueReorder: "minih-agent-desktop/agent/queue/reorder",
    agentGetStatus: "minih-agent-desktop/agent/getStatus",
    agentInstructionsGet: "minih-agent-desktop/agent/instructions/get",
    agentInstructionsSave: "minih-agent-desktop/agent/instructions/save",
    sessionList: "minih-agent-desktop/session/list",
    sessionCreate: "minih-agent-desktop/session/create",
    sessionFork: "minih-agent-desktop/session/fork",
    sessionMoveProject: "minih-agent-desktop/session/moveProject",
    sessionSearch: "minih-agent-desktop/session/search",
    sessionSearchContext: "minih-agent-desktop/session/searchContext",
    sessionGet: "minih-agent-desktop/session/get",
    /** Read-only delegation summaries for the work panel's session roster. */
    sessionDelegations: "minih-agent-desktop/session/delegations",
    /** Read-only conversation of one delegation chain, read on demand. */
    sessionDelegation: "minih-agent-desktop/session/delegation",
    sessionCollaboration: "minih-agent-desktop/session/collaboration",
    /** Validate and select a durable session from a reviewed host operation. */
    sessionOpen: "minih-agent-desktop/session/open",
    sessionDelete: "minih-agent-desktop/session/delete",
    /** Isolated sessions in git worktrees (ADR 0329). */
    worktreeProbe: "minih-agent-desktop/worktree/probe",
    worktreePreview: "minih-agent-desktop/worktree/preview",
    worktreeMerge: "minih-agent-desktop/worktree/merge",
    worktreePendingWork: "minih-agent-desktop/worktree/pendingWork",
    /** "Sync from project": project commits the session lacks, and the sync. */
    worktreeBehind: "minih-agent-desktop/worktree/behind",
    worktreeSync: "minih-agent-desktop/worktree/sync",
    /** Behind counts of every isolated session, for the sidebar marker. */
    worktreeBehindAll: "minih-agent-desktop/worktree/behindAll",
    worktreeSetupLog: "minih-agent-desktop/worktree/setupLog",
    /** Opens the worktree folder in the OS file manager; no path is returned. */
    worktreeReveal: "minih-agent-desktop/worktree/reveal",
    worktreeSetupCommandGet: "minih-agent-desktop/worktree/setupCommand/get",
    worktreeSetupCommandSet: "minih-agent-desktop/worktree/setupCommand/set",
    sessionRename: "minih-agent-desktop/session/rename",
    /** Deterministic first-prompt title for a session that is still untitled. */
    sessionDeriveTitle: "minih-agent-desktop/session/deriveTitle",
    sessionConfigure: "minih-agent-desktop/session/configure",
    /** The model catalog of the host that owns the session (remote sessions). */
    sessionModels: "minih-agent-desktop/session/models",
    sessionImportScan: "minih-agent-desktop/session/importScan",
    sessionImportRun: "minih-agent-desktop/session/importRun",
    modelConfigImportScan: "minih-agent-desktop/modelConfig/importScan",
    modelConfigImportRun: "minih-agent-desktop/modelConfig/importRun",
    sessionReplaceMessages: "minih-agent-desktop/session/replaceMessages",
    sessionSaveRevision: "minih-agent-desktop/session/saveRevision",
    sessionListRevisions: "minih-agent-desktop/session/listRevisions",
    sessionActivateRevision: "minih-agent-desktop/session/activateRevision",
    sessionGetScratchPath: "minih-agent-desktop/session/getScratchPath",
    sessionOpenScratchPath: "minih-agent-desktop/session/openScratchPath",
    projectOpenFolder: "minih-agent-desktop/project/openFolder",
    settingsGet: "minih-agent-desktop/settings/get",
    settingsSet: "minih-agent-desktop/settings/set",
    configSyncGetState: "minih-agent-desktop/configSync/getState",
    backgroundTasksList: "minih-agent-desktop/backgroundTasks/list",
    backgroundTasksOutput: "minih-agent-desktop/backgroundTasks/output",
    backgroundTasksStop: "minih-agent-desktop/backgroundTasks/stop",
    configSyncConfigure: "minih-agent-desktop/configSync/configure",
    configSyncTest: "minih-agent-desktop/configSync/test",
    configSyncSyncNow: "minih-agent-desktop/configSync/syncNow",
    configSyncPause: "minih-agent-desktop/configSync/pause",
    configSyncUnlock: "minih-agent-desktop/configSync/unlock",
    configSyncApprove: "minih-agent-desktop/configSync/approve",
    configSyncReject: "minih-agent-desktop/configSync/reject",
    configSyncMapProject: "minih-agent-desktop/configSync/mapProject",
    configSyncListHistory: "minih-agent-desktop/configSync/listHistory",
    configSyncRestore: "minih-agent-desktop/configSync/restore",
    configSyncChangePassword: "minih-agent-desktop/configSync/changePassword",
    configSyncDisconnect: "minih-agent-desktop/configSync/disconnect",
    /** Explicit project archive: one logical project or group as a ZIP file. */
    projectArchiveExport: "minih-agent-desktop/projectArchive/export",
    projectArchiveImport: "minih-agent-desktop/projectArchive/import",
    networkProxyTest: "minih-agent-desktop/network/testProxy",
    commandShellList: "minih-agent-desktop/commandShell/list",
    secretsSet: "minih-agent-desktop/secrets/set",
    secretsDelete: "minih-agent-desktop/secrets/delete",
    secretsHas: "minih-agent-desktop/secrets/has",
    projectOpen: "minih-agent-desktop/project/open",
    projectPickFolders: "minih-agent-desktop/project/pickFolders",
    projectMemoryGet: "minih-agent-desktop/project/memory/get",
    projectMemorySave: "minih-agent-desktop/project/memory/save",
    projectGroupList: "minih-agent-desktop/project-group/list",
    projectGroupCreateRemote: "minih-agent-desktop/project-group/createRemote",
    projectGroupCreate: "minih-agent-desktop/project-group/create",
    projectGroupRename: "minih-agent-desktop/project-group/rename",
    projectGroupUpdate: "minih-agent-desktop/project-group/update",
    projectGroupMemoryGet: "minih-agent-desktop/project-group/memory/get",
    projectGroupMemorySave: "minih-agent-desktop/project-group/memory/save",
    projectGroupInstructionsGet: "minih-agent-desktop/project-group/instructions/get",
    projectGroupInstructionsSave: "minih-agent-desktop/project-group/instructions/save",
    projectClone: "minih-agent-desktop/project/clone",
    projectCloneCheckout: "minih-agent-desktop/project/cloneCheckout",
    projectGet: "minih-agent-desktop/project/get",
    projectList: "minih-agent-desktop/project/list",
    projectSet: "minih-agent-desktop/project/set",
    projectClear: "minih-agent-desktop/project/clear",
    projectRemove: "minih-agent-desktop/project/remove",
    scheduledList: "minih-agent-desktop/scheduled/list",
    scheduledCreate: "minih-agent-desktop/scheduled/create",
    scheduledUpdate: "minih-agent-desktop/scheduled/update",
    scheduledDelete: "minih-agent-desktop/scheduled/delete",
    scheduledRun: "minih-agent-desktop/scheduled/run",
    scheduledExecute: "minih-agent-desktop/scheduled/execute",
    scheduledListRuns: "minih-agent-desktop/scheduled/listRuns",
    memoryList: "minih-agent-desktop/memory/list",
    memoryUpdate: "minih-agent-desktop/memory/update",
    memoryArchive: "minih-agent-desktop/memory/archive",
    memoryRestore: "minih-agent-desktop/memory/restore",
    memoryDelete: "minih-agent-desktop/memory/delete",
    // The transcript receipt's "remember again": the user's own action, and the
    // only path that clears a delete. Never reachable from a model tool.
    memoryRememberAgain: "minih-agent-desktop/memory/rememberAgain",
    memorySessionGet: "minih-agent-desktop/memory/session/get",
    memorySessionSetExcluded: "minih-agent-desktop/memory/session/setExcluded",
    // The suggestion inbox: what extraction proposed, and the user's decision.
    memorySuggestionsList: "minih-agent-desktop/memory/suggestions/list",
    memorySuggestionsDecide: "minih-agent-desktop/memory/suggestions/decide",
    // Device-local extraction usage, so Settings can show today's spend and
    // whether the daily budget has paused it.
    memoryExtractionStatus: "minih-agent-desktop/memory/extraction/status",
    // The device-local counters the memory manager shows. They never travel
    // with configuration sync, so this read is about this machine only.
    memoryStats: "minih-agent-desktop/memory/stats",
    toolResolvePermission: "minih-agent-desktop/tool/resolvePermission",
    todosGet: "minih-agent-desktop/todos/get",
    askToolResolve: "minih-agent-desktop/agent/askTool/resolve",
    plansPending: "minih-agent-desktop/plans/pending",
    pendingInteractive: "minih-agent-desktop/agent/pendingInteractive",
    plansResolve: "minih-agent-desktop/plans/resolve",
    /**
     * List every paired remote `agent-host-cli` this desktop knows, redacted so no
     * device token reaches the renderer. See ADR 0286 (R2b pairing UX).
     */
    remoteHostList: "minih-agent-desktop/remoteHost/list",
    /**
     * Pair with a `agent-host-cli` at `url` using a single-use `pairingToken`, mint
     * a device token, persist it encrypted, and open the live connection.
     */
    remoteHostPair: "minih-agent-desktop/remoteHost/pair",
    /** Close the live connection for `hostKey` and drop its persisted record. */
    remoteHostRemove: "minih-agent-desktop/remoteHost/remove",
    /**
     * Install and pair a `agent-host-cli` on a machine the user reaches over SSH:
     * upload the bootstrap script, download and verify the published bundle
     * there, start the host, forward its loopback port, and exchange the
     * pairing token (spec §5.2). Uses the user's own SSH keys; no credential
     * crosses this channel.
     */
    remoteHostBootstrap: "minih-agent-desktop/remoteHost/bootstrap",
    remoteHostReconnect: "minih-agent-desktop/remoteHost/reconnect",
    remoteHostProjects: "minih-agent-desktop/remoteHost/projects",
    remoteHostBrowseProjects: "minih-agent-desktop/remoteHost/browseProjects",
    remoteHostRegisterProject: "minih-agent-desktop/remoteHost/registerProject",
    remoteHostSessions: "minih-agent-desktop/remoteHost/sessions",
    remoteHostCreateSession: "minih-agent-desktop/remoteHost/createSession",
    remoteHostSyncProviders: "minih-agent-desktop/remoteHost/syncProviders",
    /**
     * Desktop as a connected Host (rollout R5, ADR 0331). The desktop dials the
     * user's own Gateway over one outbound Host link; it never listens. The
     * main process owns the link, so these channels only read and steer it —
     * no device token, private key, or mTLS material crosses them.
     */
    remoteGatewayStatus: "minih-agent-desktop/remoteGateway/status",
    remoteGatewaySetEnabled: "minih-agent-desktop/remoteGateway/setEnabled",
    remoteGatewayEnroll: "minih-agent-desktop/remoteGateway/enroll",
    remoteGatewayCreatePairingCode: "minih-agent-desktop/remoteGateway/createPairingCode",
    remoteGatewayListDevices: "minih-agent-desktop/remoteGateway/listDevices",
    remoteGatewayRevokeDevice: "minih-agent-desktop/remoteGateway/revokeDevice",
    /**
     * Account mode (D666). The desktop's answer to one pending `device.request`
     * and the device-local strict-mode switch. Neither carries a token: the
     * device directory mints those in main.
     */
    remoteGatewayDeviceDecision: "minih-agent-desktop/remoteGateway/deviceDecision",
    remoteGatewaySetStrictDevices: "minih-agent-desktop/remoteGateway/setStrictDevices",
    /**
     * ADR amendment 3: "allow same-account computers to join automatically".
     * Device-local like the strict switch, and it never carries a credential.
     */
    remoteGatewaySetDesktopAuto: "minih-agent-desktop/remoteGateway/setDesktopAuto",
    /** Which requests still wait for the dialog after a renderer reload. */
    remoteGatewayPendingDeviceRequests: "minih-agent-desktop/remoteGateway/pendingDeviceRequests",
    /**
     * The confirmation dialog host mounted or unmounted. Unmounting (window
     * closed, renderer reloaded) refuses everything still waiting, so no client
     * waits on a dialog nobody can see.
     */
    remoteGatewayDevicePresence: "minih-agent-desktop/remoteGateway/devicePresence",
    providersList: "minih-agent-desktop/providers/list",
    providersReorder: "minih-agent-desktop/providers/reorder",
    providersCreate: "minih-agent-desktop/providers/create",
    providersUpdate: "minih-agent-desktop/providers/update",
    providersDelete: "minih-agent-desktop/providers/delete",
    /**
     * Set or clear one provider's API key. Separate from `providersUpdate`
     * because a plugin-declared row refuses a generic update while still
     * needing the credential its declaration asks for.
     */
    providersSetSecret: "minih-agent-desktop/providers/setSecret",
    providersTest: "minih-agent-desktop/providers/testConnection",
    /**
     * Minih Router account surface for one saved `minih-router` row: the
     * AccessKey's balance/quotas (`MinihRouterAccount`) and a page of the
     * gateway's model plaza with prices (`MinihRouterModelPage`). Main reads
     * the row's stored key itself; the renderer never handles it.
     */
    providersMinihRouterAccount: "minih-agent-desktop/providers/minihRouter/account",
    providersMinihRouterModels: "minih-agent-desktop/providers/minihRouter/models",
    /**
     * Prices for the models one Router row sends, looked up in the gateway's
     * plaza. Separate from the plaza channel because the panel shows the
     * chosen models first, and those are not a page of it.
     */
    providersMinihRouterModelDetails: "minih-agent-desktop/providers/minihRouter/modelDetails",
    easytierStatus: "minih-agent-desktop/easytier/status",
    easytierConfigure: "minih-agent-desktop/easytier/configure",
    easytierReconnect: "minih-agent-desktop/easytier/reconnect",
    easytierRequestElevation: "minih-agent-desktop/easytier/requestElevation",
    /**
     * Check a TypeSafe key before the Jev settings row keeps it.
     *
     * Jev is not a provider row, so `providersTest` cannot answer this: the
     * key is checked by the same System One round trip the Agent's
     * `JevClassify` tool makes, and only a key that answered is stored.
     */
    jevTest: "minih-agent-desktop/jev/test",
    providersListModels: "minih-agent-desktop/providers/listModels",
    /**
     * Look one model id up in the local models.dev snapshot.
     *
     * `providersListModels` cannot answer this: it describes a saved or
     * reached provider's catalogue, and a hand-typed custom id exists nowhere
     * yet when the settings picker needs its published limits. This is a
     * snapshot read — no provider network access and no host call — so the
     * picker can seed a custom row without probing an endpoint that does not
     * know the id.
     */
    providersLookupModel: "minih-agent-desktop/providers/lookupModel",
    providersRefreshModelCatalog: "minih-agent-desktop/providers/refreshModelCatalog",
    providersModelCatalogStatus: "minih-agent-desktop/providers/modelCatalogStatus",
    providersOauthVendors: "minih-agent-desktop/providers/oauth/vendors",
    providersOauthStart: "minih-agent-desktop/providers/oauth/start",
    providersOauthRespond: "minih-agent-desktop/providers/oauth/respond",
    providersOauthCancel: "minih-agent-desktop/providers/oauth/cancel",
    providersOauthDelete: "minih-agent-desktop/providers/oauth/delete",
    pluginList: "minih-agent-desktop/plugin/list",
    /** A renderer slot component asking its own plugin for one JSON answer. */
    pluginRendererCall: "minih-agent-desktop/plugin/rendererCall",
    /** Invoke a declared, user-facing Composer transform action. */
    pluginComposerTransform: "minih-agent-desktop/plugin/composerTransform",
    /** Plugin-contributed agent extensions (D387/D388, ADR 0214). */
    pluginImportExtension: "minih-agent-desktop/plugin/importExtension",
    extensionsCommandRun: "minih-agent-desktop/extensions/commands/run",
    extensionsUiRespond: "minih-agent-desktop/extensions/ui/respond",
    pluginLoadDev: "minih-agent-desktop/plugin/loadDev",
    /**
     * The answer to a development plugin's permission review. Loading a folder
     * is a two-step: `pluginLoadDev` returns the declaration, and this commits
     * the permissions the user accepted.
     */
    pluginLoadDevConfirm: "minih-agent-desktop/plugin/loadDevConfirm",
    pluginReload: "minih-agent-desktop/plugin/reload",
    /** Commits a reviewed widening for an already-loaded development plugin. */
    pluginReloadConfirm: "minih-agent-desktop/plugin/reloadConfirm",
    pluginCreateFromTemplate: "minih-agent-desktop/plugin/createFromTemplate",
    pluginInstallFromPath: "minih-agent-desktop/plugin/installFromPath",
    pluginInstallFromPackage: "minih-agent-desktop/plugin/installFromPackage",
    pluginEnable: "minih-agent-desktop/plugin/enable",
    pluginDisable: "minih-agent-desktop/plugin/disable",
    pluginSetScope: "minih-agent-desktop/plugin/setScope",
    pluginUninstall: "minih-agent-desktop/plugin/uninstall",
    pluginSetAutoUpdate: "minih-agent-desktop/plugin/setAutoUpdate",
    pluginSettingsGet: "minih-agent-desktop/plugin/settings/get",
    pluginSettingsSet: "minih-agent-desktop/plugin/settings/set",
    pluginOpenPanel: "minih-agent-desktop/plugin/openPanel",
    pluginLauncherToggle: "minih-agent-desktop/pluginLauncher/toggle",
    pluginLauncherDismiss: "minih-agent-desktop/pluginLauncher/dismiss",
    pluginThemes: "minih-agent-desktop/plugin/themes",
    pluginProviderCatalog: "minih-agent-desktop/plugin/providerCatalog",
    pluginScenicThemesDestinations: "minih-agent-desktop/plugin/scenicThemes/destinations",
    pluginScenicThemesSetBlur: "minih-agent-desktop/plugin/scenicThemes/setBlur",
    pluginServices: "minih-agent-desktop/plugin/services",
    pluginViews: "minih-agent-desktop/plugin/views",
    pluginViewOpen: "minih-agent-desktop/plugin/view/open",
    pluginViewClose: "minih-agent-desktop/plugin/view/close",
    pluginViewSetBounds: "minih-agent-desktop/plugin/view/setBounds",
    pluginViewSetVisible: "minih-agent-desktop/plugin/view/setVisible",
    mcpList: "minih-agent-desktop/mcp/list",
    mcpUpsert: "minih-agent-desktop/mcp/upsert",
    mcpRemove: "minih-agent-desktop/mcp/remove",
    mcpSetEnabled: "minih-agent-desktop/mcp/setEnabled",
    mcpSetScope: "minih-agent-desktop/mcp/setScope",
    mcpTransfer: "minih-agent-desktop/mcp/transfer",
    mcpTest: "minih-agent-desktop/mcp/test",
    mcpOauthStart: "minih-agent-desktop/mcp/oauth/start",
    mcpOauthCancel: "minih-agent-desktop/mcp/oauth/cancel",
    mcpImport: "minih-agent-desktop/mcp/import",
    mcpImportScan: "minih-agent-desktop/mcp/importScan",
    mcpImportRun: "minih-agent-desktop/mcp/importRun",
    mcpMarketSearch: "minih-agent-desktop/mcp/market/search",
    skillList: "minih-agent-desktop/skill/list",
    skillBuiltinList: "minih-agent-desktop/skill/builtin/list",
    skillBuiltinSetEnabled: "minih-agent-desktop/skill/builtin/setEnabled",
    skillCreate: "minih-agent-desktop/skill/create",
    skillImport: "minih-agent-desktop/skill/import",
    skillImportScan: "minih-agent-desktop/skill/importScan",
    skillImportRun: "minih-agent-desktop/skill/importRun",
    skillMarketSearch: "minih-agent-desktop/skill/market/search",
    skillMarketFetch: "minih-agent-desktop/skill/market/fetch",
    skillUpdate: "minih-agent-desktop/skill/update",
    skillRemove: "minih-agent-desktop/skill/remove",
    skillSetEnabled: "minih-agent-desktop/skill/setEnabled",
    skillSetScope: "minih-agent-desktop/skill/setScope",
    skillTransfer: "minih-agent-desktop/skill/transfer",
    skillRead: "minih-agent-desktop/skill/read",
    skillReveal: "minih-agent-desktop/skill/reveal",
    subagentList: "minih-agent-desktop/subagent/list",
    subagentCatalog: "minih-agent-desktop/subagent/catalog",
    subagentCreate: "minih-agent-desktop/subagent/create",
    subagentUpdate: "minih-agent-desktop/subagent/update",
    subagentRead: "minih-agent-desktop/subagent/read",
    subagentRemove: "minih-agent-desktop/subagent/remove",
    subagentSetEnabled: "minih-agent-desktop/subagent/setEnabled",
    subagentSetScope: "minih-agent-desktop/subagent/setScope",
    subagentSetBuiltinEnabled: "minih-agent-desktop/subagent/setBuiltinEnabled",
    subagentReveal: "minih-agent-desktop/subagent/reveal",
    marketRefresh: "minih-agent-desktop/market/refresh",
    marketSearch: "minih-agent-desktop/market/search",
    marketGetDetail: "minih-agent-desktop/market/getDetail",
    marketInstall: "minih-agent-desktop/market/install",
    marketCheckUpdates: "minih-agent-desktop/market/checkUpdates",
    marketApplyUpdates: "minih-agent-desktop/market/applyUpdates",
    marketCancelInstall: "minih-agent-desktop/market/cancelInstall",
    commandPaletteSearch: "minih-agent-desktop/commandPalette/search",
    commandPaletteExecute: "minih-agent-desktop/commandPalette/execute",
    logOpenFolder: "minih-agent-desktop/log/openFolder",
    devtoolsToggle: "minih-agent-desktop/devtools/toggle",
    composerPickFiles: "minih-agent-desktop/composer/pickFiles",
    composerPickPhotos: "minih-agent-desktop/composer/pickPhotos",
    composerImportFiles: "minih-agent-desktop/composer/importFiles",
    composerPasteFiles: "minih-agent-desktop/composer/pasteFiles",
    clipboardRecordPaste: "minih-agent-desktop/clipboard/recordPaste",
    composerCommands: "minih-agent-desktop/composer/commands",
    workspaceDiff: "minih-agent-desktop/workspace/diff",
    workspaceReviewRollback: "minih-agent-desktop/workspace/review/rollback",
    browserNavigate: "minih-agent-desktop/browser/navigate",
    browserAction: "minih-agent-desktop/browser/action",
    browserSetBounds: "minih-agent-desktop/browser/setBounds",
    browserSetVisible: "minih-agent-desktop/browser/setVisible",
    browserOpenExternal: "minih-agent-desktop/browser/openExternal",
    browserGetState: "minih-agent-desktop/browser/getState",
    fsList: "minih-agent-desktop/fs/list",
    fsRead: "minih-agent-desktop/fs/read",
    fsReadImageDataUrl: "minih-agent-desktop/fs/readImageDataUrl",
    statsGetTokenUsageHistory: "minih-agent-desktop/stats/getTokenUsageHistory",
    fsReveal: "minih-agent-desktop/fs/reveal",
    /**
     * Show one chat reference in the system file manager. Separate from
     * `fsReveal` on purpose: this one accepts a path outside every allowed root,
     * because showing where a folder or file lives is not reading it.
     */
    fsRevealChatRef: "minih-agent-desktop/fs/revealChatRef",
    fsOpen: "minih-agent-desktop/fs/open",
    fsIndex: "minih-agent-desktop/fs/index",
    fsResolveRef: "minih-agent-desktop/fs/resolveRef",
    windowSetWorkPanelReservation:
      "minih-agent-desktop/window/setWorkPanelReservation",
    windowSetWorkPanelChatWidth: "minih-agent-desktop/window/setWorkPanelChatWidth",
    windowSetBackgroundColor: "minih-agent-desktop/window/setBackgroundColor",
    windowControl: "minih-agent-desktop/window/control",
    closeBehaviorGet: "minih-agent-desktop/window/closeBehavior/get",
    closeBehaviorSet: "minih-agent-desktop/window/closeBehavior/set",
    menuRendererReady: "minih-agent-desktop/menu/rendererReady",
    traySetSessionPreferences: "minih-agent-desktop/tray/setSessionPreferences",
    nativeMenuAction: "minih-agent-desktop/menu/nativeAction",
  },
  event: {
    pluginChanged: "minih-agent-desktop/event/pluginChanged",
    /** Progress of an install or update, while it is still running. */
    pluginInstallProgress: "minih-agent-desktop/plugin/event/installProgress",
    /** Host-originated app settings mutation (e.g. plugin `app.setTheme`). */
    settingsChanged: "minih-agent-desktop/app/event/settingsChanged",
    configSyncChanged: "minih-agent-desktop/configSync/event/changed",
    /** A chat-started background task started, exited, or was stopped. */
    backgroundTasksChanged: "minih-agent-desktop/backgroundTasks/event/changed",
    /** What a running sync is doing, while it is still running. */
    configSyncProgress: "minih-agent-desktop/configSync/event/progress",
    /** What a running project archive export or import is doing. */
    projectArchiveProgress: "minih-agent-desktop/projectArchive/event/progress",
    extensionsUiPrompt: "minih-agent-desktop/extensions/event/uiPrompt",
    extensionsStatus: "minih-agent-desktop/extensions/event/status",
    pluginLauncherShown: "minih-agent-desktop/pluginLauncher/event/shown",
    agentMessage: "minih-agent-desktop/agent/event/message",
    agentQueueChanged: "minih-agent-desktop/agent/event/queueChanged",
    hostStatus: "minih-agent-desktop/app/event/hostStatus",
    /** One `RemoteGatewayStatus` snapshot per link state change (rollout R5). */
    remoteGatewayStatusChanged: "minih-agent-desktop/remoteGateway/event/statusChanged",
    /**
     * A `device.request` awaiting this desktop's user (protocol §11.5). One
     * event per pending request; the answer goes back over
     * `remoteGatewayDeviceDecision`, and an unanswered request is denied when
     * its own `expiresAt` passes.
     */
    remoteGatewayDeviceRequest: "minih-agent-desktop/remoteGateway/event/deviceRequest",
    /** A device minted, adopted from a sibling Host, or revoked (ADR decision 6). */
    remoteGatewayDeviceNotice: "minih-agent-desktop/remoteGateway/event/deviceNotice",
    toast: "minih-agent-desktop/app/event/toast",
    /**
     * The first plaintext hop to an endpoint the user typed, sent once and only
     * until the shell records `networkPolicy.insecureNoticeAcknowledged`. The
     * shell owns the wording, because the address is not a secret and the copy
     * is localized.
     */
    insecureEndpointNotice: "minih-agent-desktop/network/event/insecureEndpointNotice",
    browserState: "minih-agent-desktop/browser/event/state",
    browserPreview: "minih-agent-desktop/browser/event/preview",
    windowMaximized: "minih-agent-desktop/window/event/maximized",
    windowFullScreen: "minih-agent-desktop/window/event/fullscreen",
    windowWorkPanelResize: "minih-agent-desktop/window/event/workPanelResize",
    menuCommand: "minih-agent-desktop/menu/event/command",
    traySessionActivated: "minih-agent-desktop/tray/event/sessionActivated",
    notificationChanged: "minih-agent-desktop/notification/event/changed",
    sessionsChanged: "minih-agent-desktop/session/event/changed",
    remoteInteractions: "minih-agent-desktop/remote/event/interactions",
    notificationActivated: "minih-agent-desktop/notification/event/activated",
    notificationSound: "minih-agent-desktop/notification/event/sound",
    plansChanged: "minih-agent-desktop/plans/event/changed",
    todosChanged: "minih-agent-desktop/todos/event/changed",
    providersOauth: "minih-agent-desktop/providers/oauth/event",
    mcpOauth: "minih-agent-desktop/mcp/oauth/event",
    updatesState: "minih-agent-desktop/updates/event/state",
    voiceStateChanged: "minih-agent-desktop/voice/event/stateChanged",
    voiceModelProgress: "minih-agent-desktop/voice/event/modelProgress",
    liveVoiceChanged: "minih-agent-desktop/voice/live/event/changed",
    liveVoicePort: "minih-agent-desktop/voice/live/event/port",
    liveVoiceControl: "minih-agent-desktop/voice/live/event/control",
    liveVoiceTranscript: "minih-agent-desktop/voice/live/event/transcript",
    liveVoiceWidgetState: "minih-agent-desktop/voice/live/event/widgetState",
    liveVoiceWidgetAction: "minih-agent-desktop/voice/live/event/widgetAction",
  },
} as const;

export const IPC_WHITELIST = new Set<string>([
  ...Object.values(IPC.invoke),
  ...Object.values(IPC.event),
]);
