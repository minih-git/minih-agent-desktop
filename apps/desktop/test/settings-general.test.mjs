import {
  readSettingsSource,
  readPluginsSource,
  readMainSource,
  readSharedTypesSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const settingsPageSource = await readSettingsSource();
const settingsSearchSource = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const providersSource = await readFile(
  new URL("../src/components/settings/OtherProvidersSection.tsx", import.meta.url),
  "utf8",
);
const modelsPageSource = await readFile(
  new URL("../src/components/settings/ModelConfigPage.tsx", import.meta.url),
  "utf8",
);
const defaultModelSource = await readFile(
  new URL("../src/components/settings/default-model.ts", import.meta.url),
  "utf8",
);
const scheduledSource = await readFile(
  new URL("../src/pages/ScheduledPage.tsx", import.meta.url),
  "utf8",
);
const scheduledFormatSource = await readFile(
  new URL("../src/features/scheduled/scheduled-format.ts", import.meta.url),
  "utf8",
);
const pluginsPageSource = await readPluginsSource();
// API services and vendor accounts share one list (D625).
const serviceListSource = await readFile(
  new URL("../src/components/settings/ServiceList.tsx", import.meta.url),
  "utf8",
);
const serviceRowSource = await readFile(
  new URL("../src/components/settings/ServiceRow.tsx", import.meta.url),
  "utf8",
);
const serviceRowStatusSource = await readFile(
  new URL("../src/components/settings/service-row-status.ts", import.meta.url),
  "utf8",
);
// Account lifecycle (remove with default repair, save) lives in the hook.
const vendorAccountsHookSource = await readFile(
  new URL("../src/components/settings/useVendorAccounts.ts", import.meta.url),
  "utf8",
);
const vendorAccountDialogSource = await readFile(
  new URL("../src/components/settings/VendorAccountDialog.tsx", import.meta.url),
  "utf8",
);
// Subscriptions are picked in the service chooser since D625.
const serviceChooserSource = await readFile(
  new URL("../src/components/settings/ServiceChooser.tsx", import.meta.url),
  "utf8",
);
const oauthSource = await readFile(
  new URL("../electron/main/oauth.ts", import.meta.url),
  "utf8",
);
const protocolSource = await readFile(
  new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
  "utf8",
);
const languageSource = await readFile(
  new URL("../src/lib/app-language.ts", import.meta.url),
  "utf8",
);
const rendererLanguageSource = await readFile(
  new URL("../src/lib/renderer-language.ts", import.meta.url),
  "utf8",
);
const enLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const zhLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const trLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/tr/index.ts", import.meta.url),
  "utf8",
);
const zhTWLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-TW/index.ts", import.meta.url),
  "utf8",
);
const koLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/ko/index.ts", import.meta.url),
  "utf8",
);
const ptBRLocaleSource = await readFile(
  new URL("../../../packages/i18n/src/locales/pt-BR/index.ts", import.meta.url),
  "utf8",
);
const mainSource = await readFile(
  new URL("../src/main.tsx", import.meta.url),
  "utf8",
);
const electronMainSource = await readMainSource();
const preloadSource = await readFile(
  new URL("../electron/preload/index.ts", import.meta.url),
  "utf8",
);
const sharedTypesSource = await readSharedTypesSource();
const stylesSource = await loadStyles();
const networkProxySource = await readFile(
  new URL("../src/components/settings/NetworkProxySection.tsx", import.meta.url),
  "utf8",
);
const voiceSettingsSource = await readFile(
  new URL("../src/features/settings/voice/VoiceSettingsSection.tsx", import.meta.url),
  "utf8",
);
const settingsNavigationSource = await readFile(
  new URL("../src/features/settings/SettingsNavigation.tsx", import.meta.url),
  "utf8",
);
const settingsDestinationSource = await readFile(
  new URL("../src/features/settings/SettingsDestination.tsx", import.meta.url),
  "utf8",
);
const generalPanelsSource = await readFile(
  new URL("../src/features/settings/panels/general-panels.tsx", import.meta.url),
  "utf8",
);
const aiPanelsSource = await readFile(
  new URL("../src/features/settings/panels/ai-panels.tsx", import.meta.url),
  "utf8",
);
const systemPanelsSource = await readFile(
  new URL("../src/features/settings/panels/system-panels.tsx", import.meta.url),
  "utf8",
);

test("appearance, chat, and execution destinations own separate controls", () => {
  // The general page split: appearance and usage habits are the general
  // category, chat behaviour and execution live under AI, network and storage
  // under System. Each slice below is one destination's real source.
  const generalPanelsStart = generalPanelsSource.indexOf("export function AppearancePanel");
  const habitsStart = generalPanelsSource.indexOf("export function HabitsPanel");
  const appearanceSource = generalPanelsSource.slice(generalPanelsStart, habitsStart);
  const chatStart = aiPanelsSource.indexOf("export function ChatExperiencePanel");
  const executionStart = aiPanelsSource.indexOf("export function ExecutionPanel");
  const memoryStart = aiPanelsSource.indexOf("export function InstructionsMemoryPanel");
  const chatSource = aiPanelsSource.slice(chatStart, executionStart);
  const executionSource = aiPanelsSource.slice(executionStart, memoryStart);

  assert.match(appearanceSource, /<ThemeRow /);
  assert.match(appearanceSource, /<LanguageRow /);
  assert.match(appearanceSource, /<FontFamilyRow /);
  assert.match(appearanceSource, /<FontSizeRow /);
  assert.doesNotMatch(appearanceSource, /NetworkProxySection/);
  assert.doesNotMatch(appearanceSource, /StorageSettingsSection/);
  assert.doesNotMatch(appearanceSource, /defaultMode: value/);
  assert.doesNotMatch(appearanceSource, /enterToSend: !settings\.enterToSend/);
  assert.doesNotMatch(appearanceSource, /settings\.defaultsTitle/);
  // Network and storage stay reachable: they are system destinations now.
  assert.match(systemPanelsSource, /export function NetworkPanel[\s\S]*NetworkProxySection/);
  assert.match(systemPanelsSource, /export function StoragePanel[\s\S]*StorageSettingsSection/);

  assert.match(chatSource, /enterToSend: !settings\.enterToSend/);
  assert.match(chatSource, /LargePasteThresholdRow/);
  assert.match(chatSource, /ContextUsageDisplayRow/);
  assert.match(chatSource, /SessionTitleToggleRow/);
  assert.doesNotMatch(chatSource, /defaultMode: value/);
  assert.doesNotMatch(chatSource, /settings\.defaultsTitle|settings\.executionTitle/);
  assert.doesNotMatch(chatSource, /PromptEnhancementCard|promptEnhancement/);
  assert.doesNotMatch(chatSource, /EnhancementModelCard/);

  assert.match(executionSource, /defaultMode: value/);
  assert.match(executionSource, /settings\.executionTitle/);
  assert.match(executionSource, /CommandShellRow/);
  assert.match(executionSource, /infiniteProviderRetry: settings\.infiniteProviderRetry !== true/);
  assert.match(executionSource, /defaultPermissionMode: mode as GlobalPermissionMode/);
  assert.match(executionSource, /<SettingsMenuSelect\b/);
  assert.match(executionSource, /"accept-edits"/);
  // The picker stays the shared Settings control: a native <select> popup is
  // platform-drawn and cannot carry the shared menu surface or its check mark.
  assert.doesNotMatch(executionSource, /<select/);

  // readSettingsSource() reads the page facade plus every settings module, so
  // the row primitives that own these writes are part of it.
  assert.match(settingsPageSource, /saveSettings\(\{ contextUsageDisplay: value \}\)/);
  for (const key of [
    "settings.contextUsageDisplay",
    "settings.contextUsageDisplayRemaining",
    "settings.contextUsageDisplayUsed",
    "settings.infiniteProviderRetry",
    "settings.infiniteProviderRetryDesc",
  ]) {
    assert.match(settingsSearchSource, new RegExp(key.replaceAll(".", "\\.")));
    assert.match(enLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(zhLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
    assert.match(trLocaleSource, new RegExp(`${key.split(".").at(-1)}:`));
  }
  assert.match(sharedTypesSource, /contextUsageDisplay\?: ContextUsageDisplay/);
  assert.match(sharedTypesSource, /infiniteProviderRetry\?: boolean/);
  assert.match(sharedTypesSource, /ContextUsageDisplay = "remaining" \| "used"/);
  assert.match(sharedTypesSource, /chatContentMaxWidth\?: number/);
  assert.match(settingsSearchSource, /settings\.largePasteThreshold/);
  assert.match(settingsPageSource, /saveSettings\(\{ largePasteThreshold: next \}\)/);
  assert.doesNotMatch(settingsPageSource, /commandShellConfigured/);

  // Voice owns a separate destination; the chat page does not duplicate it.
  assert.doesNotMatch(chatSource, /VoiceSettingsCard|VoiceSettingsSection|voice-settings/);
  assert.match(settingsDestinationSource, /tab === "voice" && !tabHidden && settings && [\s\S]*?<VoiceSettingsSection/);
  assert.match(voiceSettingsSource, /LiveVoiceSettings as VoiceSettingsSection/);
  assert.doesNotMatch(voiceSettingsSource, /voiceIpc|voiceEnable|voiceMicrophone|voiceModel/);
  assert.doesNotMatch(settingsSearchSource, /settings\.voiceEnable|settings\.voiceMicrophone|settings\.voiceModel/);
  assert.match(settingsSearchSource, /liveVoice\.enable/);
  assert.doesNotMatch(settingsSearchSource, /settings\.speech/);
  assert.doesNotMatch(stylesSource, /\.settings-speech/);
  assert.doesNotMatch(enLocaleSource, /speechTitle:|speechVoicePlaceholder:/);
  assert.match(protocolSource, /speechTranscribe: "minih-agent-desktop\/speech\/transcribe"/);
});

test("language persists as part of shared app settings", () => {
  assert.match(
    sharedTypesSource,
    /language\?: "auto" \| "en" \| "zh-CN" \| "zh-TW" \| "tr" \| "de" \| "es" \| "fr" \| "ko"/,
  );
  assert.match(sharedTypesSource, /largePasteThreshold\?: number/);
  assert.match(sharedTypesSource, /fontScale\?: number/);
  assert.match(sharedTypesSource, /networkProxy\?: NetworkProxySettings/);
});

test("General Network card persists a custom HTTP or SOCKS5 proxy and the relaxed network mode", () => {
  assert.match(settingsPageSource, /<NetworkProxySection /);
  assert.match(networkProxySource, /settings\.networkRelaxedMode/);
  // A mode switch saves the current drafts, even when the input blur save has
  // not refreshed `saved` yet, so Custom restores the user's latest values.
  assert.match(
    networkProxySource,
    /settingsForInactiveProxyMode\(mode, saved, urlDraft, bypassDraft\)/,
  );
  assert.match(
    networkProxySource,
    /resolveCustomProxyUrl\(urlDraft, saved\.url\)/,
  );
  assert.match(networkProxySource, /url: resolved\.url/);
  // Fake-IP tolerance belongs to the network mode now, not to the proxy payload.
  assert.doesNotMatch(networkProxySource, /allowFakeIp/);
  assert.match(settingsSearchSource, /settings\.proxy/);
  assert.match(settingsSearchSource, /settings\.proxyCustom/);
  assert.match(settingsSearchSource, /settings\.networkRelaxedMode/);
  assert.match(electronMainSource, /applyNetworkProxyFromAppSettings/);
  assert.match(electronMainSource, /IPC\.invoke\.networkProxyTest/);
  assert.match(protocolSource, /networkProxyTest: "minih-agent-desktop\/network\/testProxy"/);
  for (const source of [
    enLocaleSource,
    zhLocaleSource,
    zhTWLocaleSource,
    trLocaleSource,
    koLocaleSource,
  ]) {
    assert.match(source, /proxyCustom:/);
    assert.match(source, /proxyUrlPlaceholder:/);
    assert.match(source, /networkRelaxedMode:/);
    assert.match(source, /networkRelaxedModeDesc:/);
  }
});

test("basics gates developer tools behind a persisted developer mode", () => {
  assert.match(sharedTypesSource, /developerMode\?: boolean/);
  assert.match(settingsPageSource, /function DeveloperSection/);
  assert.match(settingsPageSource, /<SettingsToggle\s+checked=\{enabled\}/);
  assert.match(settingsPageSource, /saveSettings\(\{ developerMode: !enabled \}\)/);
  assert.match(settingsPageSource, /api\.toggleDevTools\(true\)/);
  assert.match(settingsPageSource, /disabled=\{!enabled\}/);
  for (const key of [
    "settings.developer",
    "settings.developerMode",
    "settings.devTools",
  ]) {
    assert.match(settingsSearchSource, new RegExp(key.replace(".", "\\.")));
  }
});

test("stored language drives i18n and native labels at startup and on settings change", () => {
  assert.match(languageSource, /export function initLanguageSync/);
  assert.match(rendererLanguageSource, /changeLanguage/);
  assert.match(rendererLanguageSource, /resolveLocale/);
  assert.match(mainSource, /initLanguageSync\(\)/);
  assert.match(electronMainSource, /catalogs\[resolveLocale\(locale\)\]/);
});

test("date copy follows the active application locale", () => {
  // The page resolves one locale and hands it to every moment it renders; the
  // formatter is what actually builds the string.
  assert.match(scheduledSource, /const locale = i18n\.resolvedLanguage \?\? i18n\.language;/);
  assert.match(scheduledSource, /locale=\{locale\}/);
  assert.match(
    scheduledFormatSource,
    /new Intl\.DateTimeFormat\(locale \|\| undefined/,
  );
  assert.match(
    modelsPageSource,
    /new Date\(catalogStatus\.fetchedAt\)\.toLocaleString\(locale\)/,
  );
});

test("sandboxed preload receives the OS locale without importing main-only APIs", () => {
  assert.match(electronMainSource, /additionalArguments:\s*\[`--minih-agent-desktop-locale=\$\{app\.getLocale\(\)\}`\]/);
  assert.match(preloadSource, /const LOCALE_ARGUMENT_PREFIX = "--minih-agent-desktop-locale="/);
  assert.match(preloadSource, /process\.argv[\s\S]*startsWith\(LOCALE_ARGUMENT_PREFIX\)/);
  assert.doesNotMatch(preloadSource, /import\s*\{[^}]*\bapp\b[^}]*\}\s*from "electron"/);
  assert.doesNotMatch(preloadSource, /locale:\s*app\.getLocale\(\)/);
});

test("model configuration keeps model defaults; AI owns app behavior defaults", () => {
  assert.match(providersSource, /settings\.defaultModel/);
  assert.doesNotMatch(providersSource, /enterToSend/);
  assert.doesNotMatch(providersSource, /settings\.modeAgent/);
  assert.doesNotMatch(providersSource, /EnhancementModelCard/);
  // The models page shows which model is the app default without owning a
  // second way to change provider defaults.
  assert.match(modelsPageSource, /settings\.modelsDefaultBadge/);
});


test("model configuration lists AI services and vendor accounts together", () => {
  // One list (D625): nothing filters OAuth rows out, and no second section.
  assert.doesNotMatch(providersSource, /authKind !== OAUTH_AUTH_KIND/);
  assert.doesNotMatch(providersSource, /VendorAccountsSection/);
  assert.match(providersSource, /<ServiceList\s+providers=\{providers\}/);
  // Readiness (a key, an OAuth account, or a no-auth provider) now lives in the
  // shared helper, so the page must delegate to it instead of re-inlining the
  // rule next to a second copy that can drift from the picker.
  assert.match(providersSource, /providerServesChatModels\(/);
  assert.match(
    defaultModelSource,
    /provider\.hasSecret \|\| !!provider\.hasOauth \|\| provider\.authKind === "none"/,
  );
  assert.doesNotMatch(providersSource, /provider-config-hero/);
  assert.doesNotMatch(providersSource, /settings-section-subtitle/);
  // An account row still lives and dies through the vendor-account editor and
  // deleteOauthAccount, never through the provider CRUD.
  assert.match(
    providersSource,
    /serviceRowKind\(provider\) === "account"\s*\?\s*setEditingAccountId\(provider\.id\)\s*:\s*setSetupFor\(provider\.id\)/,
  );
  assert.match(
    providersSource,
    /serviceRowKind\(provider\) === "account"\s*\?\s*removeAccount\(provider\)\s*:\s*removeProvider\(provider\)/,
  );
  assert.match(providersSource, /<VendorAccountDialog/);
  assert.match(providersSource, /api\.testProvider\(provider\.id\)/);
  assert.match(vendorAccountsHookSource, /api\.deleteOauthAccount\(provider\.id\)/);
  assert.match(vendorAccountsHookSource, /api\.updateProvider\(/);
  assert.match(vendorAccountsHookSource, /oauthAccountLabel: form\.name\.trim\(\)/);
  assert.match(vendorAccountsHookSource, /defaultModelId: form\.modelId\.trim\(\)/);
  assert.match(vendorAccountsHookSource, /models: form\.models/);
  assert.doesNotMatch(stylesSource, /\.vendor-card-list/);
  assert.doesNotMatch(stylesSource, /vendor-account-row/);
  // Both credential kinds now pick from the same live, service-provided list.
  assert.match(vendorAccountDialogSource, /useProviderModels/);
  assert.match(vendorAccountDialogSource, /<ModelSelectionPanes/);
  assert.doesNotMatch(vendorAccountDialogSource, /<ChosenModelsSummary/);
  assert.match(vendorAccountDialogSource, /modelId: persisted\[0\]\.id/);
  assert.match(vendorAccountsHookSource, /providerIsReady/);
  assert.match(vendorAccountsHookSource, /defaultProviderId: next\?\.id \?\? ""/);
  assert.match(vendorAccountsHookSource, /useAppStore\.setState\(\{ settings: nextSettings \}\)/);
  assert.match(serviceChooserSource, /existing accounts do not disable a\s+vendor/);
  assert.match(serviceChooserSource, /vendors\.map/);
});

test("a service row opens its editor and keeps only a switch and one menu", () => {
  // The row is the way in; every other action sits in the overflow menu.
  assert.match(serviceRowSource, /<CapabilityRowMenu/);
  assert.doesNotMatch(serviceRowSource, /IconPencil|IconTrash|IconCopy|IconPlug|IconStar/);
  assert.match(serviceListSource, /IconPencil[\s\S]*IconTrash/);
  // The click sits on the row so a card drag can start anywhere on it, while
  // presses on the row's own controls never open the editor.
  assert.match(serviceRowSource, /const OWN_CONTROLS = "button, input, select, textarea, a, label/);
  assert.match(serviceRowSource, /event\.target !== event\.currentTarget \|\| !onOpen \|\| busy/);
  // An account has no enable switch; a plugin's switch belongs to the plugin.
  assert.match(serviceRowSource, /kind !== "account" \? \(/);
  assert.match(serviceRowSource, /disabled=\{busy \|\| kind === "plugin"\}/);
  // Plugin-owned rows are not editable, including OAuth account rows; those
  // rows still expose sign-out through the overflow menu.
  assert.match(serviceListSource, /const pluginOAuth = kind === "account" && !!provider\.ownerPluginId/);
  assert.match(
    serviceListSource,
    /if \(kind !== "plugin" && !pluginOAuth\) \{\s*items\.push\(\{\s*key: "edit"/,
  );
  assert.match(serviceListSource, /t\(pluginOAuth\s*\?\s*"settings\.vendorSignOut"/);
  assert.match(serviceListSource, /if \(kind !== "plugin"\) \{\s*const isArmed/);
  // Removal is confirmed inside the menu rather than by a second row button.
  assert.match(serviceListSource, /useArmedDelete\(\)/);
  assert.match(serviceListSource, /settings\.capabilityRemoveConfirm/);
  // D297: the plugin key entry is set apart by spacing, never by a rule.
  const keyEntry = stylesSource.match(/\.model-provider-key-entry\s*\{([^}]*)\}/)?.[1];
  assert.ok(keyEntry, ".model-provider-key-entry rule is missing");
  assert.doesNotMatch(keyEntry, /border/);
});

test("vendor account rows keep the summary to one account name", () => {
  // The account sits in the title beside its vendor; the meta line holds only
  // what service-row-status derives, never the default model id.
  assert.match(
    serviceRowSource,
    /<span className="model-provider-row-account">\{title\.account\}<\/span>/,
  );
  assert.doesNotMatch(serviceRowSource, /defaultModelId|font-mono/);
  assert.match(
    serviceRowStatusSource,
    /return provider\.hasOauth \? \[models\] : \[t\("settings\.vendorDisconnectedDesc"\)\]/,
  );
});

test("OAuth account identity is provider-scoped across IPC and pi-ai", () => {
  assert.match(protocolSource, /providersOauthDelete/);
  assert.doesNotMatch(protocolSource, /providersOauthLogout/);
  assert.match(oauthSource, /accountModels = new Map<string, AccountModels>/);
  assert.match(oauthSource, /fresh provider row/);
  assert.match(oauthSource, /secretRefForProviderOauth\(providerId\)/);
  assert.match(oauthSource, /deleteAccount\(providerId: string\)/);
});


test("settings navigation is a short category bar over a labelled second level", () => {
  // The navigation lives in its own module: two levels, no icons on the host
  // categories, and the plugin theme entries are the only rows with a glyph.
  assert.match(settingsNavigationSource, /categories\.map\(\(category\) =>/);
  assert.match(settingsNavigationSource, /role="tab"/);
  assert.match(settingsNavigationSource, /t\(category\.labelKey\)/);
  assert.match(settingsNavigationSource, /destinations\.map\(\(entry\) =>/);
  assert.match(settingsNavigationSource, /t\(entry\.labelKey\)/);
  assert.match(settingsNavigationSource, /aria-selected=/);
  assert.match(settingsNavigationSource, /pluginViewIcon\(entry\.icon\)/);
  assert.equal((settingsNavigationSource.match(/<span className="settings-nav-icon">/g) ?? []).length, 1);
  // A category that does not fit becomes the shared menu select.
  assert.match(settingsNavigationSource, /className="settings-category-select"/);
  assert.doesNotMatch(settingsNavigationSource, /IconSliders|IconSparkles|IconKeyboard/);
});

test("settings keeps one flat destination index under seven fixed categories", () => {
  assert.match(settingsSearchSource, /export const SETTINGS_CATEGORIES/);
  assert.equal(
    (settingsSearchSource.match(/labelKey: "settings\.category\./g) ?? []).length,
    7,
    "the category bar is seven entries, never an eighth",
  );
  for (const key of ["general", "ai", "models", "capabilities", "accounts", "projects", "system"]) {
    assert.match(settingsSearchSource, new RegExp(`settings\\.category\\.${key}"`));
    for (const locale of [enLocaleSource, zhLocaleSource, zhTWLocaleSource, trLocaleSource]) {
      assert.match(locale, new RegExp(`"?category"?\\s*:\\s*\\{[\\s\\S]*?"?${key}"?:`));
    }
  }
  // Destination order is the panel's order, category by category. Only the
  // SETTINGS_NAV array counts: the category bar above it repeats category ids.
  const navSource = settingsSearchSource.slice(
    settingsSearchSource.indexOf("export const SETTINGS_NAV"),
  );
  const navOrder = [
    "general",
    "habits",
    "shortcuts",
    "ai",
    "execution",
    "instructions",
    "voice",
    "agent",
    "skills",
    "mcp",
    "subagents",
    "accounts",
    "devices",
    "sync",
    "advanced",
    "projects",
    "network",
    "storage",
    "about",
  ].map((id) => navSource.indexOf(`id: "${id}"`));
  assert.ok(navOrder.every((index) => index >= 0));
  assert.deepEqual(navOrder, [...navOrder].sort((a, b) => a - b));
  assert.equal(settingsSearchSource.indexOf('id: "usage"'), -1);

  // Keyword ownership follows the row into its new destination.
  const sliceNav = (from, to) =>
    navSource.slice(navSource.indexOf(`id: "${from}"`), navSource.indexOf(`id: "${to}"`));
  const appearanceEntry = sliceNav("general", "habits");
  const executionEntry = sliceNav("execution", "instructions");
  const networkEntry = sliceNav("network", "storage");
  assert.doesNotMatch(appearanceEntry, /settings\.defaultsTitle/);
  assert.doesNotMatch(appearanceEntry, /settings\.proxyUrl/);
  assert.match(executionEntry, /settings\.defaultsTitle/);
  assert.match(executionEntry, /settings\.commandShell/);
  assert.doesNotMatch(executionEntry, /settings\.promptEnhancementModelTitle/);
  assert.match(networkEntry, /settings\.proxyUrl/);
  assert.match(settingsSearchSource, /keywordKeys/);
  assert.match(settingsSearchSource, /settings\.projectArchive/);

  assert.doesNotMatch(stylesSource, /\.token-usage-page/);
  assert.match(stylesSource, /\.settings-nav-item\s*\{/);
  assert.match(stylesSource, /\.settings-category\s*\{/);
  assert.match(stylesSource, /\.settings-subnav-item\s*\{/);
  // The four titled rail groups are gone with the rail.
  assert.doesNotMatch(stylesSource, /\.settings-nav-group-label/);
  assert.doesNotMatch(settingsPageSource, /SETTINGS_NAV_GROUP_LABELS/);
  assert.match(
    stylesSource,
    /\.settings-row\.settings-row-plain\s*\{[^}]*border-bottom:\s*0/s,
  );
});

test("settings categories and destinations keep short labels and page titles", () => {
  const navKeys = [
    "settings.nav.appearance",
    "settings.nav.habits",
    "settings.nav.shortcuts",
    "settings.nav.chatExperience",
    "settings.nav.execution",
    "settings.nav.instructionsMemory",
    "settings.nav.voice",
    "settings.nav.models",
    "settings.nav.skills",
    "settings.nav.mcp",
    "settings.nav.subagents",
    "settings.nav.accounts",
    "settings.nav.devices",
    "settings.nav.sync",
    "settings.nav.advanced",
    "settings.nav.projects",
    "settings.nav.network",
    "settings.nav.storage",
    "settings.nav.aboutUpdates",
  ];
  const label = (locale, name) => new RegExp(`"?${name}"?:`);
  for (const key of navKeys) {
    assert.match(settingsSearchSource, new RegExp(key.replaceAll(".", "\\.")));
    const name = key.split(".").at(-1);
    for (const locale of [enLocaleSource, zhLocaleSource, zhTWLocaleSource, trLocaleSource]) {
      assert.match(locale, label(locale, name));
    }
  }
  // A page whose own name is not its tab label keeps a descriptive title.
  assert.match(settingsSearchSource, /titleKey: "settings\.accounts"/);
  assert.match(settingsSearchSource, /titleKey: "settings\.modelsPageTitle"/);
  assert.match(settingsSearchSource, /titleKey: "settings\.projectArchive"/);
  assert.match(settingsPageSource, /const activeTitleKey = activeEntry\?\.titleKey/);
  assert.match(settingsDestinationSource, /t\(titleKey\)/);
});

test("Plugins marketplace keeps official refresh without source settings", () => {
  assert.doesNotMatch(
    pluginsPageSource,
    /MarketplaceSourceSettings|pluginMarketSource|pluginMarketCustomUrl|marketProvider|marketCustomUrl|marketSource/,
  );
  assert.match(pluginsPageSource, /api\.marketRefresh\(true\)/);
  assert.match(pluginsPageSource, /refreshMarket\(query, \{ refreshRemote: true \}\)/);
  assert.doesNotMatch(settingsPageSource, /ExtensionMarketSection/);
  assert.doesNotMatch(settingsPageSource, /tab === "extensions"/);
});

test("settings compact pickers hug the current label on the shared menu select", () => {
  assert.match(
    stylesSource,
    /\.settings-language-anchor,\s*\.settings-theme-anchor,\s*\.settings-menu-select-anchor,\s*\.settings-font\s*\{[^}]*width:\s*max-content/s,
  );
  assert.match(
    stylesSource,
    /\.settings-language-trigger,\s*\.settings-theme-trigger,\s*\.settings-menu-select-trigger,\s*\.settings-font-trigger\s*\{[^}]*width:\s*max-content/s,
  );
});

test("native select menus keep readable theme colors across the app on Windows", () => {
  assert.match(
    stylesSource,
    /select option,\s*select optgroup\s*\{[^}]*background-color:\s*var\(--ds-bg-elevated-opaque\);[^}]*color:\s*var\(--ds-text-primary\);/s,
  );
  assert.match(stylesSource, /select\s*\{[^}]*color-scheme:\s*inherit;/s);
  assert.match(
    stylesSource,
    /:root,\s*:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark;/s,
  );
  assert.match(
    stylesSource,
    /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light;/s,
  );
});

test("Live Voice account cards show their options only after a provider is chosen", async () => {
  const source = await readFile(
    new URL("../src/features/settings/voice/LiveVoiceSettings.tsx", import.meta.url),
    "utf8",
  );
  // A card with no provider account bound is the picker and nothing else: the
  // model, voice, and protocol rows belong to a chosen binding instead of
  // rendering as empty disabled controls.
  assert.match(source, /\{current && adapter !== "codex-live" \? \(/);
  assert.match(source, /\{current && adapter === "openai-realtime" \? \(/);
  assert.doesNotMatch(source, /disabled=\{!current/);
});
