import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import {
  createPushRegistrationController,
  type PushRegistrationSnapshot,
} from "../hooks/usePushRegistration.js";
import { buildResources, DEFAULT_LOCALE } from "../locales/index.js";
import { AccountScreen } from "../screens/AccountScreen.js";
import { PairScreen } from "../screens/PairScreen.js";
import { SettingsScreen } from "../screens/SettingsScreen.js";
import type { DirectChatConnection } from "./direct-chat/connection.js";
import type { HostRegistryEntry } from "./host-registry.js";
import type { PushPlugin } from "./push.js";
import {
  APP_VERSION,
  buildAccountCardView,
  describePushSettingsView,
  displayModelName,
  formatDefaultModelRow,
  resolvePrivacyPolicyUrl,
  selectThemePreference,
  subscribeSystemTheme,
  type MediaQueryListSource,
} from "./settings-view.js";
import {
  readThemePreference,
  THEME_PREFERENCE_KEY,
  type ThemeDocument,
  type ThemeStorage,
} from "./theme.js";

function makeModel(overrides: Partial<MinihRouterModel> & { id: string }): MinihRouterModel {
  return {
    upstreamIds: [overrides.id],
    vendor: "OpenAI",
    category: "chat",
    protocols: ["openai-completions"],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: 128_000,
    maxOutput: 16_000,
    outputModalities: ["text"],
    ...overrides,
  };
}

function makeConnection(overrides: Partial<DirectChatConnection> = {}): DirectChatConnection {
  return {
    gatewayRoot: "https://router.example.com",
    accessKeyId: "42",
    keyName: "Work Phone",
    maskedKey: "sk-…9a1f",
    lastModelId: "openai/gpt-5.4",
    lastImageModelId: "openai/gpt-image-2",
    defaultChatModelId: "openai/gpt-5.4",
    defaultImageModelId: "openai/gpt-image-2",
    connectedAt: "2026-10-23T08:00:00.000Z",
    models: [
      makeModel({
        id: "openai/gpt-5.4",
        vendor: "OpenAI",
        outputModalities: ["text"],
        protocols: ["openai-completions"],
      }),
      makeModel({
        id: "deepseek-v4",
        vendor: "DeepSeek",
        outputModalities: ["text"],
        protocols: ["openai-completions"],
      }),
      makeModel({
        id: "openai/gpt-image-2",
        vendor: "OpenAI",
        outputModalities: ["image"],
        protocols: ["openai-images"],
      }),
    ],
    ...overrides,
  };
}

async function renderWithLocale(
  element: Parameters<typeof renderToStaticMarkup>[0],
  locale: string = DEFAULT_LOCALE,
): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    resources: buildResources(),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n, children: element }));
}

describe("buildAccountCardView and formatDefaultModelRow (ADR D6, D2, B13)", () => {
  it("projects the connected account card without inventing a Router balance", () => {
    const conn = makeConnection();
    const card = buildAccountCardView(conn, true);
    expect(card).toEqual({
      connected: true,
      avatarInitial: "W",
      keyName: "Work Phone",
      maskedKey: "sk-…9a1f",
      accessKeyId: "42",
      gatewayRoot: "https://router.example.com",
      modelCount: 3,
      gatewayConfigured: true,
      balance: null,
    });

    const disconnected = buildAccountCardView(null, false);
    expect(disconnected.connected).toBe(false);
    expect(disconnected.balance).toBeNull();
    expect(disconnected.gatewayConfigured).toBe(false);
  });

  it("formats default model rows with clean model name and vendor instead of raw ids (B13)", () => {
    const conn = makeConnection();
    const chatRow = formatDefaultModelRow(conn.models, "openai/gpt-5.4", "chat");
    expect(chatRow).toEqual({
      configured: true,
      id: "openai/gpt-5.4",
      name: "gpt-5.4",
      vendor: "OpenAI",
      summary: "OpenAI · gpt-5.4",
      usable: true,
      monogram: "GP",
      gradientClass: expect.any(String),
    });

    const imageRow = formatDefaultModelRow(conn.models, "openai/gpt-image-2", "image");
    expect(imageRow.name).toBe("gpt-image-2");
    expect(imageRow.vendor).toBe("OpenAI");
    expect(imageRow.summary).toBe("OpenAI · gpt-image-2");
    expect(imageRow.usable).toBe(true);

    const unsetRow = formatDefaultModelRow(conn.models, null, "chat");
    expect(unsetRow.configured).toBe(false);
    expect(unsetRow.name).toBeNull();
    expect(unsetRow.vendor).toBeNull();

    const missingRow = formatDefaultModelRow(conn.models, "anthropic/claude-sonnet-5", "chat");
    expect(missingRow.configured).toBe(true);
    expect(missingRow.name).toBe("claude-sonnet-5");
    expect(missingRow.vendor).toBe("Anthropic");
    expect(missingRow.usable).toBe(false);
    expect(displayModelName("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

describe("createPushRegistrationController and describePushSettingsView (B10)", () => {
  const ORIGIN = "https://gateway.example.com";
  const CRED = { kind: "header" as const, token: "pdt1.device" };

  function makeHost(hostId: string, deviceId = "dev_1"): HostRegistryEntry {
    return {
      hostId,
      label: hostId,
      deviceId,
      pairedAt: "2026-10-20T00:00:00.000Z",
      profile: "native",
    };
  }

  function makeFakePlugin(options: {
    permission?: "granted" | "denied";
    token?: string | null;
  } = {}): PushPlugin & {
    activeListeners: () => number;
    emitToken: (value: string) => void;
    emitError: (error: string) => void;
  } {
    let listenerCount = 0;
    const tokenHandlers: Array<(token: { value: string }) => void> = [];
    const errorHandlers: Array<(err: { error: string }) => void> = [];
    const permission = options.permission ?? "granted";
    const tokenValue = options.token === undefined ? "apns-token-1" : options.token;

    return {
      activeListeners: () => listenerCount,
      emitToken: (value: string) => {
        for (const handler of [...tokenHandlers]) handler({ value });
      },
      emitError: (error: string) => {
        for (const handler of [...errorHandlers]) handler({ error });
      },
      async requestPermissions() {
        return { receive: permission };
      },
      async register() {
        if (tokenValue) {
          setTimeout(() => {
            for (const handler of [...tokenHandlers]) handler({ value: tokenValue });
          }, 0);
        }
      },
      addListener: (async (event: string, handler: (payload: never) => void) => {
        listenerCount += 1;
        if (event === "registration") {
          tokenHandlers.push(handler as unknown as (token: { value: string }) => void);
        }
        if (event === "registrationError") {
          errorHandlers.push(handler as unknown as (err: { error: string }) => void);
        }
        return {
          remove: async () => {
            listenerCount -= 1;
            const idx = tokenHandlers.indexOf(
              handler as unknown as (token: { value: string }) => void,
            );
            if (idx >= 0) tokenHandlers.splice(idx, 1);
          },
        };
      }) as PushPlugin["addListener"],
    };
  }

  it("returns unsupported state when running in a browser without a push plugin", async () => {
    const controller = createPushRegistrationController({
      plugin: null,
      platform: null,
      gatewayOrigin: ORIGIN,
      getHosts: () => [makeHost("h1")],
      credentialFor: () => CRED,
    });
    expect(controller.getSnapshot()).toMatchObject({
      state: "unsupported",
      permission: "unsupported",
      registered: false,
      enabled: false,
      error: null,
    });
    const view = describePushSettingsView(controller.getSnapshot());
    expect(view.statusKey).toBe("settings.notifications.statusUnsupported");
    expect(view.disabled).toBe(true);
    expect(view.checked).toBe(false);
    expect(view.supportsEventToggles).toBe(false);
  });

  it("surfaces registered state, handles master switch disable/enable, and cleans up listeners (B10)", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url) });
      return new Response(
        JSON.stringify({ result: { enabled: true, hostIds: ["h1"] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const plugin = makeFakePlugin({ permission: "granted", token: "apns-token-1" });
    const hosts = [makeHost("h1")];
    const controller = createPushRegistrationController({
      plugin,
      platform: "ios",
      gatewayOrigin: ORIGIN,
      fetchImpl,
      getHosts: () => hosts,
      credentialFor: () => CRED,
    });

    await controller.attachListeners();
    expect(plugin.activeListeners()).toBe(4);

    await controller.syncHosts(hosts);
    expect(controller.getSnapshot()).toMatchObject({
      state: "registered",
      permission: "granted",
      registered: true,
      enabled: true,
      registeredCount: 1,
      error: null,
    });
    expect(calls).toEqual([{ method: "PUT", url: `${ORIGIN}/v1/push/registration` }]);

    // Turning master switch OFF sends DELETE and disposes active listeners
    const disabledOk = await controller.setEnabled(false);
    expect(disabledOk).toBe(true);
    expect(plugin.activeListeners()).toBe(0);
    expect(calls[1]).toEqual({ method: "DELETE", url: `${ORIGIN}/v1/push/registration` });
    expect(controller.getSnapshot()).toMatchObject({
      state: "disabled",
      registered: false,
      enabled: false,
      registeredCount: 0,
      error: null,
    });

    // Turning master switch back ON re-attaches listeners and registers again
    const enabledOk = await controller.setEnabled(true);
    expect(enabledOk).toBe(true);
    expect(plugin.activeListeners()).toBe(4);
    expect(calls[2]).toEqual({ method: "PUT", url: `${ORIGIN}/v1/push/registration` });
    expect(controller.getSnapshot()).toMatchObject({
      state: "registered",
      registered: true,
      enabled: true,
      registeredCount: 1,
      error: null,
    });

    // Unmount cleanup removes all listeners
    await controller.dispose();
    expect(plugin.activeListeners()).toBe(0);
  });

  it("surfaces permission-denied and failed unregistration without swallowing errors", async () => {
    const deniedPlugin = makeFakePlugin({ permission: "denied", token: null });
    const deniedController = createPushRegistrationController({
      plugin: deniedPlugin,
      platform: "ios",
      gatewayOrigin: ORIGIN,
      getHosts: () => [makeHost("h1")],
      credentialFor: () => CRED,
    });
    await deniedController.syncHosts();
    expect(deniedController.getSnapshot()).toMatchObject({
      state: "permission-denied",
      permission: "denied",
      registered: false,
      enabled: false,
      error: "permission",
    });
    expect(describePushSettingsView(deniedController.getSnapshot())).toMatchObject({
      statusKey: "settings.notifications.statusPermissionDenied",
      errorKey: "settings.notifications.errorPermission",
      checked: false,
    });

    // Failed DELETE when disabling push reports request-failed
    let allowDelete = true;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE" && !allowDelete) {
        return new Response("{}", { status: 500 });
      }
      return new Response(
        JSON.stringify({ result: { enabled: true, hostIds: ["h1"] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const plugin = makeFakePlugin({ permission: "granted", token: "apns-2" });
    const controller = createPushRegistrationController({
      plugin,
      platform: "ios",
      gatewayOrigin: ORIGIN,
      fetchImpl,
      getHosts: () => [makeHost("h1")],
      credentialFor: () => CRED,
    });
    await controller.syncHosts();
    expect(controller.getSnapshot().state).toBe("registered");

    allowDelete = false;
    const ok = await controller.setEnabled(false);
    expect(ok).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      state: "failed",
      error: "request-failed",
    });
    expect(describePushSettingsView(controller.getSnapshot()).errorKey).toBe(
      "settings.notifications.errorRequestFailed",
    );
  });
});

describe("Appearance persistence and live OS theme tracking (ADR D4, D6)", () => {
  it("persists theme choices through lib/theme.ts and reacts to OS changes while system is selected", () => {
    const map = new Map<string, string>();
    const storage: ThemeStorage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
    const doc: ThemeDocument = {
      documentElement: {
        dataset: {},
        style: {},
      },
    };

    let systemIsLight = false;
    const listeners = new Set<() => void>();
    const mediaSource: MediaQueryListSource = {
      get matches() {
        return systemIsLight;
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    };
    const matchMedia = (query: string): MediaQueryListSource => {
      if (query.includes("light")) return mediaSource;
      return {
        get matches() {
          return !systemIsLight;
        },
        addEventListener: mediaSource.addEventListener,
        removeEventListener: mediaSource.removeEventListener,
      };
    };

    // Select light explicitly
    expect(selectThemePreference("light", { storage, doc, matchMedia })).toBe("light");
    expect(map.get(THEME_PREFERENCE_KEY)).toBe("light");
    expect(readThemePreference(storage)).toBe("light");
    expect(doc.documentElement.dataset?.theme).toBe("light");
    expect(doc.documentElement.style?.colorScheme).toBe("light");

    // Subscribe to OS changes: while preference is "light", OS flip does not override it
    const unsubscribe = subscribeSystemTheme({ storage, doc, matchMedia });
    systemIsLight = false;
    for (const listener of listeners) listener();
    expect(doc.documentElement.dataset?.theme).toBe("light");

    // Switch to "system": immediately adopts dark (since systemIsLight === false)
    expect(selectThemePreference("system", { storage, doc, matchMedia })).toBe("dark");
    expect(readThemePreference(storage)).toBe("system");
    expect(doc.documentElement.dataset?.theme).toBe("dark");

    // OS switches to light while "system" is selected -> updates live to "light"
    systemIsLight = true;
    for (const listener of listeners) listener();
    expect(doc.documentElement.dataset?.theme).toBe("light");
    expect(doc.documentElement.style?.colorScheme).toBe("light");

    // Cleanup removes listeners
    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});

describe("SettingsScreen markup and B9 / B10 / B12 / B13 regressions", () => {
  const pushSnapshot: PushRegistrationSnapshot = {
    state: "registered",
    permission: "granted",
    registered: true,
    enabled: true,
    busy: false,
    error: null,
    gatewayDisabled: false,
    registeredCount: 2,
    setEnabled: async () => true,
  };

  it("renders functional sections without 'later' stubs or the removed 'Computers' row (B9, B10, B13)", async () => {
    const html = await renderWithLocale(
      createElement(SettingsScreen, {
        connection: makeConnection(),
        gatewayConfigured: true,
        onBack: () => undefined,
        onConnect: () => undefined,
        onDisconnect: async () => undefined,
        onOpenScope: () => undefined,
        pushRegistration: pushSnapshot,
      }),
      "en",
    );

    // Account card: shows connected key name, masked key, model count, and no fake balance
    expect(html).toContain("Work Phone");
    expect(html).toContain("sk-…9a1f · #42");
    expect(html).toContain("3 models");
    expect(html).not.toContain("¥");

    // Default models (B13): shows clean model name and vendor, not raw slash IDs
    expect(html).toContain("Default models");
    expect(html).toContain("OpenAI");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("gpt-image-2");

    // Notifications (B10): shows master switch, registered status, diagnostics, and 1-line explanation
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("On · registered with gateway");
    expect(html).toContain("Active for 2 credential(s)");
    expect(html).toContain("without per-event toggles");

    // Appearance: 3 radio buttons (System, Light, Dark)
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-theme-option="system"');
    expect(html).toContain('data-theme-option="light"');
    expect(html).toContain('data-theme-option="dark"');

    // About: the version is the build's own, and the privacy row exists only
    // when the build was told where the policy is published — a link that goes
    // nowhere would be worse than no link.
    expect(html).toContain(APP_VERSION);
    expect(html).not.toContain("settings.about.privacyPolicy");
    expect(resolvePrivacyPolicyUrl("")).toBeNull();
    expect(resolvePrivacyPolicyUrl("not a url")).toBeNull();
    expect(resolvePrivacyPolicyUrl("https://example.test/privacy")).toBe(
      "https://example.test/privacy",
    );

    // B9: no "Follows the S8 spec" stubs and no "Computers and devices" row
    expect(html).not.toContain("Follows the S8 spec");
    expect(html).not.toContain("Computers and devices");
  });

  it("replaces hard-coded Chinese in AccountScreen and PairScreen across locales (B12)", async () => {
    const pairHtml = await renderWithLocale(
      createElement(PairScreen, {
        onPaired: () => undefined,
        onBack: () => undefined,
      }),
      "en",
    );
    expect(pairHtml).toContain("Switch gateway");
    expect(pairHtml).not.toContain("切换网关");

    const accountHtml = await renderWithLocale(
      createElement(AccountScreen, {
        onAdopted: () => undefined,
        onUseTicket: () => undefined,
        onBack: () => undefined,
      }),
      "en",
    );
    expect(accountHtml).toContain("Switch gateway");
    expect(accountHtml).not.toContain("切换网关");

    // Source-level check that AccountScreen.tsx and PairScreen.tsx contain no CJK literals
    const accountSource = readFileSync(
      fileURLToPath(new URL("../screens/AccountScreen.tsx", import.meta.url)),
      "utf8",
    );
    const pairSource = readFileSync(
      fileURLToPath(new URL("../screens/PairScreen.tsx", import.meta.url)),
      "utf8",
    );
    expect(accountSource).not.toMatch(/[\u4e00-\u9fff]/);
    expect(pairSource).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
