/**
 * Data-only index of the settings IA, shared by the settings panel's
 * navigation and the global search dialog.
 *
 * Two levels, never more: seven fixed categories (常规 / AI / 模型 / 能力 /
 * 账户 / 项目 / 系统) and the destinations inside them. Keyword keys are the
 * i18n keys of the rows rendered inside each destination; search matches their
 * translations, so a query like "主题" or "theme" can surface the destination
 * that owns the row, together with the path it lives under.
 */

/** The seven top-level entries of the settings panel. */
export type SettingsCategoryId =
  | "general"
  | "ai"
  | "models"
  | "capabilities"
  | "accounts"
  | "projects"
  | "system";

/**
 * Second-level destinations. Ids are part of the navigation contract: deep
 * links, automation through the capture API, and plugin calls name them.
 */
export type SettingsTabId =
  | "general"
  | "habits"
  | "shortcuts"
  | "ai"
  | "execution"
  | "instructions"
  | "voice"
  | "agent"
  | "skills"
  | "mcp"
  | "subagents"
  | "accounts"
  | "devices"
  | "sync"
  | "advanced"
  | "projects"
  | "network"
  | "storage"
  | "about";

export type SettingsCategory = {
  id: SettingsCategoryId;
  /** Short label on the category bar. */
  labelKey: string;
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { id: "general", labelKey: "settings.category.general" },
  { id: "ai", labelKey: "settings.category.ai" },
  { id: "models", labelKey: "settings.category.models" },
  { id: "capabilities", labelKey: "settings.category.capabilities" },
  { id: "accounts", labelKey: "settings.category.accounts" },
  { id: "projects", labelKey: "settings.category.projects" },
  { id: "system", labelKey: "settings.category.system" },
];

export type SettingsNavEntry = {
  id: SettingsTabId;
  /** Short label used by the category's sub-navigation and search results. */
  labelKey: string;
  /** Descriptive title used at the top of the selected settings page. */
  titleKey: string;
  /** Owning category; the panel shows exactly one category at a time. */
  category: SettingsCategoryId;
  /** i18n keys of the rows inside the page; search matches their translations. */
  keywordKeys: string[];
  /**
   * Destination only exists while `AppSettings.developerMode` is on; the
   * sub-navigation, the page, and settings search drop it together.
   */
  developerOnly?: true;
  /** Surface is omitted from packaged builds; development builds retain it. */
  developmentOnly?: true;
  /** Localized Experimental badge shown beside the tab and the page title. */
  experimentalBadgeKey?: string;
};

export const SETTINGS_NAV: SettingsNavEntry[] = [
  // 常规 — appearance, usage habits, shortcuts.
  {
    id: "general",
    labelKey: "settings.nav.appearance",
    titleKey: "settings.nav.appearance",
    category: "general",
    keywordKeys: [
      "settings.appearance",
      "settings.theme",
      "settings.windowTranslucency",
      "settings.windowTranslucencyDesc",
      "settings.language",
      "settings.languageAuto",
      "settings.font",
      "settings.fontSize",
    ],
  },
  {
    id: "habits",
    labelKey: "settings.nav.habits",
    titleKey: "settings.nav.habits",
    category: "general",
    keywordKeys: [
      "settings.power",
      "settings.keepAwakeWhileRunning",
      "settings.keepAwakeWhileRunningDesc",
      "settings.preventScreenSleep",
      "settings.preventScreenSleepDesc",
      "settings.closeBehaviorTitle",
      "settings.closeBehaviorTray",
      "settings.closeBehaviorQuit",
    ],
  },
  {
    id: "shortcuts",
    labelKey: "settings.nav.shortcuts",
    titleKey: "settings.shortcuts",
    category: "general",
    keywordKeys: [
      "settings.keyboard",
      "settings.shortcutAction.openSearch",
      "settings.shortcutAction.openCommandPalette",
      "settings.shortcutAction.toggleSidebar",
      "settings.shortcutAction.openWorkPanel",
    ],
  },

  // AI — chat experience, execution and permissions, instructions and memory,
  // voice. The model destination stays its own category.
  {
    id: "ai",
    labelKey: "settings.nav.chatExperience",
    titleKey: "settings.nav.chatExperience",
    category: "ai",
    keywordKeys: [
      "settings.enterToSend",
      "settings.smoothStreaming",
      "settings.smoothStreamingDesc",
      "settings.showThinking",
      "settings.showThinkingDesc",
      "settings.transcriptDensity",
      "settings.transcriptDensityDesc",
      "settings.densityCompact",
      "settings.densityStandard",
      "settings.densityDetailed",
      "settings.contextUsageDisplay",
      "settings.contextUsageDisplayRemaining",
      "settings.contextUsageDisplayUsed",
      "settings.linkOpenTarget",
      "settings.largePasteThreshold",
      "settings.sessionTitleCard",
    ],
  },
  {
    id: "execution",
    labelKey: "settings.nav.execution",
    titleKey: "settings.nav.execution",
    category: "ai",
    keywordKeys: [
      "settings.permissions",
      "settings.permissionMode",
      "settings.permissionModeAsk",
      "settings.permissionModeAcceptEdits",
      "settings.permissionModeAuto",
      "settings.defaultsTitle",
      "settings.mode",
      "settings.modeDesc",
      "settings.commandShell",
      "settings.infiniteProviderRetry",
      "settings.infiniteProviderRetryDesc",
    ],
  },
  {
    id: "instructions",
    labelKey: "settings.nav.instructionsMemory",
    titleKey: "settings.nav.instructionsMemory",
    category: "ai",
    keywordKeys: [
      "settings.instructionsGlobal",
      "settings.instructionsPath",
      // Learned memory (ADR agent-long-term-memory) is a Global AI decision.
      "settings.learnedMemory",
      "settings.learnedMemoryRead",
      "settings.learnedMemoryReadDesc",
      "settings.learnedMemoryExtraction",
      "settings.learnedMemoryExtractionDesc",
      "settings.learnedMemoryExtractionNeedsModel",
      "settings.learnedMemoryModel",
      "settings.learnedMemoryModelDesc",
      "settings.learnedMemoryModelNone",
      "settings.learnedMemoryBudget",
      "settings.learnedMemoryBudgetDesc",
      "settings.learnedMemoryUsage",
      "settings.learnedMemoryUsageDesc",
      "settings.learnedMemoryManager",
      "settings.learnedMemoryManagerDesc",
      "settings.learnedMemoryOpen",
    ],
  },
  {
    id: "voice",
    labelKey: "settings.nav.voice",
    titleKey: "liveVoice.title",
    category: "ai",
    keywordKeys: [
      "liveVoice.title",
      "liveVoice.description",
      "liveVoice.enable",
      "liveVoice.provider",
      "liveVoice.model",
      "liveVoice.voice",
      "liveVoice.adapters.codex-live.title",
      "liveVoice.adapters.gemini-live.title",
      "liveVoice.adapters.openai-realtime.title",
    ],
  },

  // 模型 — catalog, defaults, per-model configuration.
  {
    id: "agent",
    labelKey: "settings.nav.models",
    titleKey: "settings.modelsPageTitle",
    category: "models",
    keywordKeys: [
      "settings.models",
      "settings.modelsPageTitle",
      "settings.addModelsTitle",
      "settings.modelsConfigure",
      "settings.modelApiStyle",
      "settings.imageModel",
      "settings.sessionCreateModel",
      "settings.thinkingProtocol",
      "settings.defaultThinkingLevel",
      "settings.modelCapabilities",
      "settings.availableForSubagents",
      "settings.nativeWebSearch",
    ],
  },

  // 能力 — one management page per capability, never one merged list.
  {
    id: "skills",
    labelKey: "settings.nav.skills",
    titleKey: "settings.skills",
    category: "capabilities",
    keywordKeys: [
      "settings.skillsGlobalPath",
      "settings.skillsProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.importSkill",
      "settings.importSkillFromTools",
      "settings.importAgentSkillsTitle",
      "settings.importAgentSkillsDesc",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.skills.add",
      "extensions.skills.edit",
      "extensions.skills.remove",
      "extensions.skills.reveal",
    ],
  },
  {
    id: "mcp",
    labelKey: "settings.nav.mcp",
    titleKey: "settings.mcp",
    category: "capabilities",
    keywordKeys: [
      "settings.mcpGlobalPath",
      "settings.mcpProjectPath",
      "settings.globalScopeDescription",
      "settings.projectScopeDescription",
      "settings.addMcp",
      "settings.importMcpFromTools",
      "settings.importAgentMcpTitle",
      "settings.importAgentMcpDesc",
      "settings.editMcp",
      "settings.transport",
      "settings.capabilityFilterGlobal",
      "settings.capabilityFilterProject",
      "extensions.mcp.test",
      "extensions.mcp.remove",
    ],
  },
  {
    id: "subagents",
    labelKey: "settings.nav.subagents",
    titleKey: "settings.subagents",
    category: "capabilities",
    keywordKeys: [
      "settings.subagentsGlobalPath",
      "settings.subagentsOnlyGlobal",
      "settings.globalScopeDescription",
      "extensions.subagents.add",
      "extensions.subagents.edit",
      "extensions.subagents.remove",
      "extensions.subagents.reveal",
      "extensions.subagents.copy",
      "extensions.subagents.sourceBuiltin",
      "extensions.subagents.resetBuiltin",
      "extensions.subagents.presetExplorerName",
      "extensions.subagents.presetReviewerName",
      "extensions.subagents.presetTestRunnerName",
      "extensions.subagents.presetFixerName",
      "extensions.subagents.presetUiDesignerName",
      "extensions.subagents.tools",
    ],
  },

  // 账户 — account, devices, the one cloud-sync surface, and advanced
  // (SSH hosts and the self-hosted gateway).
  {
    id: "accounts",
    labelKey: "settings.nav.accounts",
    titleKey: "settings.accounts",
    category: "accounts",
    keywordKeys: [
      "settings.providers",
      "settings.apiKey",
      "settings.baseUrl",
      "settings.apiStyle",
      // Subscription accounts share the service list (D625).
      "settings.vendorAccounts",
      "settings.vendorSubscription",
      "settings.importTitle",
      "settings.importModelsScanDesc",
      "settings.importModelsTitle",
      "settings.importSourceClaudeCode",
      "settings.importSourceOpenCode",
      "settings.importSourceCodex",
      "settings.importSourcePi",
      "settings.importSourceCcSwitch",
      "settings.accountsThisComputerTitle",
      "settings.accountsComputerName",
      "settings.remoteGateway.title",
      "settings.remoteGateway.desc",
      "settings.remoteGateway.enabled",
      "settings.remoteGateway.statusTitle",
      "settings.remoteGateway.strictTitle",
      "settings.remoteGateway.pairingTitle",
      "settings.remoteGateway.pairingCreate",
      "settings.remoteGateway.devicesTitle",
    ],
  },
  {
    id: "devices",
    labelKey: "settings.nav.devices",
    titleKey: "settings.accountsDevices.title",
    category: "accounts",
    keywordKeys: [
      "settings.accountsDevices.title",
      "settings.accountsDevices.desc",
      "settings.accountsDevices.computersTitle",
      "settings.accountsDevices.computersEmpty",
      "settings.accountsDevices.online",
      "settings.accountsDevices.offline",
      "settings.accountsDevices.kindComputer",
      "settings.accountsDevices.kindPhone",
    ],
  },
  {
    id: "sync",
    labelKey: "settings.nav.sync",
    titleKey: "settings.configSync.title",
    category: "accounts",
    experimentalBadgeKey: "settings.configSync.experimental",
    keywordKeys: [
      "settings.configSync.experimental",
      "settings.configSync.connectionTitle",
      "settings.configSync.accountTitle",
      "settings.configSync.statusTitle",
      "settings.configSync.categoriesTitle",
      "settings.configSync.approvalsTitle",
      "settings.configSync.syncNow",
    ],
  },
  {
    id: "advanced",
    labelKey: "settings.nav.advanced",
    titleKey: "settings.accountsAdvancedSection.title",
    category: "accounts",
    experimentalBadgeKey: "settings.remoteHosts.experimental",
    keywordKeys: [
      "settings.accountsAdvancedSection.sshTitle",
      "settings.accountsAdvancedSection.sshDesc",
      "settings.remoteGateway.advancedTitle",
      "settings.remoteGateway.url",
      "settings.remoteGateway.caPem",
      "settings.remoteGateway.registrationCode",
      "settings.remoteGateway.enroll",
      "settings.remoteHosts.title",
      "settings.remoteHosts.addTitle",
      "settings.remoteHosts.addSsh",
      "settings.remoteHosts.addPair",
      "settings.remoteHosts.pair",
      "settings.remoteHosts.fieldUrl",
      "settings.remoteHosts.fieldPairingToken",
      "settings.remoteHosts.sshHost",
      "settings.remoteHosts.sshAuthMode",
      "settings.remoteHosts.sshPassword",
      "settings.remoteHosts.statusOnline",
      "settings.remoteHosts.statusOffline",
      "settings.remoteHosts.experimental",
    ],
  },

  // 项目 — the existing project index, archive, and import/export surfaces.
  {
    id: "projects",
    labelKey: "settings.nav.projects",
    titleKey: "settings.projectArchive",
    category: "projects",
    keywordKeys: [
      "project.title",
      "project.searchPlaceholder",
      "project.archive",
      "project.restore",
      "project.delete",
    ],
  },

  // 系统 — network, storage, and about & updates.
  {
    id: "network",
    labelKey: "settings.nav.network",
    titleKey: "settings.network",
    category: "system",
    keywordKeys: [
      "settings.network",
      "settings.proxy",
      "settings.proxySystem",
      "settings.proxyDirect",
      "settings.proxyCustom",
      "settings.proxyUrl",
      "settings.networkRelaxedMode",
      "settings.networkRelaxedModeDesc",
      "settings.networkRelaxedModeStrictDesc",
    ],
  },
  {
    id: "storage",
    labelKey: "settings.nav.storage",
    titleKey: "settings.storage.title",
    category: "system",
    keywordKeys: [
      "settings.storage.title",
      "settings.storage.dataPath",
      "settings.storage.cache",
      "settings.storage.clearCache",
      "settings.storage.backup",
    ],
  },
  {
    id: "about",
    labelKey: "settings.nav.aboutUpdates",
    titleKey: "settings.nav.aboutUpdates",
    category: "system",
    keywordKeys: [
      "settings.application",
      "settings.logs",
      "settings.feedback",
      "updates.title",
      "updates.preferenceTitle",
      "settings.developer",
      "settings.developerMode",
      "settings.devTools",
    ],
  },
];

/**
 * Destinations the current mode offers. Unavailable destinations are omitted
 * from navigation and search rather than disabled.
 */
export function visibleSettingsNav(
  developerMode: boolean,
  includeDevelopmentOnly = true,
): SettingsNavEntry[] {
  return SETTINGS_NAV.filter(
    (entry) =>
      (entry.developerOnly !== true || developerMode) &&
      (entry.developmentOnly !== true || includeDevelopmentOnly),
  );
}

export type VisibleSettingsCategory = {
  id: SettingsCategoryId;
  labelKey: string;
  entries: SettingsNavEntry[];
};

/**
 * The category bar plus its second level, with empty categories dropped so a
 * mode change never leaves a category button that opens nothing.
 */
export function visibleSettingsCategories(
  developerMode: boolean,
  includeDevelopmentOnly = true,
): VisibleSettingsCategory[] {
  const visible = visibleSettingsNav(developerMode, includeDevelopmentOnly);
  return SETTINGS_CATEGORIES.map((category) => ({
    ...category,
    entries: visible.filter((entry) => entry.category === category.id),
  })).filter((category) => category.entries.length > 0);
}

/** The category that owns a destination; unknown ids cannot reach here. */
export function settingsCategoryOf(tab: SettingsTabId): SettingsCategoryId {
  return SETTINGS_NAV.find((entry) => entry.id === tab)?.category ?? "general";
}

/** True when a stale selection points to a destination the current mode hides. */
export function isSettingsDestinationHidden(
  tab: SettingsTabId,
  developerMode: boolean,
  includeDevelopmentOnly = true,
): boolean {
  return !visibleSettingsNav(developerMode, includeDevelopmentOnly).some(
    (entry) => entry.id === tab,
  );
}

/**
 * Destinations that used to be their own entry and now live inside another
 * page.
 *
 * The id is gone from `SettingsTabId`, but a caller can still hold the old
 * string: a selection restored by a reload, an automation call through the
 * capture API, or a plugin that opened the settings page. Rather than landing
 * on an empty pane they are redirected to the page that now owns the surface.
 */
const LEGACY_SETTINGS_TABS: Record<string, SettingsTabId> = {
  // Remote control moved into the accounts page (D666 follow-up): the switch,
  // the devices, and the folded self-hosted gateway all live there now.
  remoteGateway: "accounts",
  // SSH hosts and the self-hosted gateway are the accounts category's
  // advanced page now.
  remoteHosts: "advanced",
};

/**
 * Resolve a possibly stale destination id to one this build has.
 *
 * Anything unknown falls back to Appearance, which is what the settings panel
 * already does with a hidden destination: never an empty pane, never a crash.
 */
export function normalizeSettingsTabId(tab: string): SettingsTabId {
  if (SETTINGS_NAV.some((entry) => entry.id === tab)) return tab as SettingsTabId;
  return LEGACY_SETTINGS_TABS[tab] ?? "general";
}

export type SettingsSearchHit = {
  tab: SettingsTabId;
  /** Owning category, so a result can switch the category bar too. */
  category: SettingsCategoryId;
  categoryLabelKey: string;
  tabLabelKey: string;
  /** Matched row key; null when the destination label itself matched. */
  rowKey: string | null;
};

export type SettingsSearchOptions = {
  limit?: number;
  /** Search mirrors the navigation, so hidden destinations produce no hits. */
  developerMode?: boolean;
  /** Packaged builds omit experimental surfaces, even with developer mode on. */
  includeDevelopmentOnly?: boolean;
};

/**
 * A hit's "category › page › row" path. The component joins these with its own
 * separator so the shape stays one array of i18n keys.
 */
export function settingsHitPath(hit: SettingsSearchHit): string[] {
  return [
    hit.categoryLabelKey,
    hit.tabLabelKey,
    ...(hit.rowKey ? [hit.rowKey] : []),
  ];
}

export function searchSettings(
  query: string,
  t: (key: string) => string,
  {
    limit = 8,
    developerMode = false,
    includeDevelopmentOnly = true,
  }: SettingsSearchOptions = {},
): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const categoryLabel = new Map(
    SETTINGS_CATEGORIES.map((category) => [category.id, category.labelKey]),
  );
  const hits: SettingsSearchHit[] = [];
  for (const entry of visibleSettingsNav(developerMode, includeDevelopmentOnly)) {
    const hit = (rowKey: string | null): SettingsSearchHit => ({
      tab: entry.id,
      category: entry.category,
      categoryLabelKey: categoryLabel.get(entry.category) ?? "settings.title",
      tabLabelKey: entry.labelKey,
      rowKey,
    });
    if (t(entry.labelKey).toLowerCase().includes(q)) hits.push(hit(null));
    for (const key of entry.keywordKeys) {
      if (t(key).toLowerCase().includes(q)) hits.push(hit(key));
    }
  }
  return hits.slice(0, limit);
}