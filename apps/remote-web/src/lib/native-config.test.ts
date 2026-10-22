/**
 * Static release-configuration test for the Capacitor shells (PR-5, §2/C4/C5).
 *
 * It reads the committed native project files with plain `node:fs` — no jsdom,
 * no simulator — and fails when a rule the client depends on is broken: HTTPS
 * only, no cleartext, and no backup of the Keystore-wrapped data. Push (R5
 * PR-6) is the native app's: the iOS entitlement is committed and wired into
 * both configurations, because the capability is not a secret and a build
 * without it compiles, runs, and silently receives nothing. Every piece of
 * signing material — the APNs key, the team, the profiles — and the Android
 * Firebase configuration stay the operator's, so the rules below keep those
 * out.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appRoot = new URL("../../", import.meta.url);

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, appRoot)), "utf8");
}

function exists(relativePath: string): boolean {
  return existsSync(fileURLToPath(new URL(relativePath, appRoot)));
}

const infoPlist = read("ios/App/App/Info.plist");
const androidManifest = read("android/app/src/main/AndroidManifest.xml");
const xcodeProject = read("ios/App/App.xcodeproj/project.pbxproj");
const androidAppGradle = read("android/app/build.gradle");
const rootGitignore = read("../../.gitignore");
const packageJson = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

/**
 * The app id lives in three committed places because the Capacitor CLI writes
 * it only when a platform is added (`cap add`), never on `cap sync`. An
 * operator who rebrands the app edits all three, and this test is what keeps
 * them from drifting apart.
 */
describe("native app identifier", () => {
  it("defaults the app id and name in capacitor.config.ts", async () => {
    const { default: config } = await import("../../capacitor.config.js");
    expect(config.appId).toBe("app.minih.remote");
    expect(config.appName).toBe("Minih Remote");
    expect(config.webDir).toBe("dist");
  });

  it("agrees across capacitor.config.ts, the Xcode project, and Gradle", async () => {
    const { default: config } = await import("../../capacitor.config.js");
    const bundleIdentifiers = [...xcodeProject.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map(
      (match) => match[1]!.trim(),
    );
    const applicationId = /applicationId\s+"([^"]+)"/.exec(androidAppGradle)?.[1];
    expect(bundleIdentifiers.length).toBeGreaterThan(0);
    // The app, plus the notification service extension it embeds: an extension
    // must carry a bundle id of its own, and it has to sit inside the app's id so
    // Apple treats it as part of the same product.
    const unique = [...new Set(bundleIdentifiers)].sort();
    expect(unique).toEqual([config.appId, `${config.appId}.notificationservice`].sort());
    expect(xcodeProject).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${config.appId}.notificationservice;`);
    expect(applicationId).toBe(config.appId);
  });

  it("keeps an https webview origin and never points the webview at a remote URL", async () => {
    const { default: config } = await import("../../capacitor.config.js");
    expect(config.server).toEqual({ androidScheme: "https" });
    expect(config.server?.url).toBeUndefined();
    expect(config.server?.cleartext).toBeUndefined();
    // `contentInset` stays default: the layout applies env(safe-area-inset-*).
    expect(config.ios?.contentInset).toBeUndefined();
    // The plugin is present but unconfigured: the operator brings the APNs key
    // to the Gateway and the Firebase file to the Android build, so nothing
    // machine-specific is baked into this repository's Capacitor config.
    expect(config.plugins?.PushNotifications).toBeUndefined();
  });
});

describe("ios/App/App/Info.plist", () => {
  it("never allows arbitrary or cleartext loads", () => {
    expect(infoPlist).not.toContain("NSAllowsArbitraryLoads");
    expect(infoPlist).not.toContain("NSExceptionAllowsInsecureHTTPLoads");
    expect(infoPlist).not.toContain("NSAllowsLocalNetworking");
  });

  it("declares no background mode", () => {
    // A silent push (`content-available`) would need a background mode; this
    // client only ever receives an alert the user taps, so none is declared.
    expect(infoPlist).not.toContain("UIBackgroundModes");
    expect(infoPlist).not.toContain("aps-environment");
    expect(infoPlist).not.toContain("remote-notification");
    expect(infoPlist).not.toContain("fetch");
  });

  it("carries the display name and no machine-specific identity", () => {
    expect(infoPlist).toContain("<string>Minih Remote</string>");
    expect(infoPlist).not.toMatch(/DEVELOPMENT_TEAM|ProvisioningProfile|apple-team/i);
  });

  it("commits the push entitlement, and only the push entitlement", () => {
    // The capability is not a secret, and a build without it compiles, runs and
    // silently receives nothing, so the file is committed and referenced by both
    // configurations. What stays out is the signing material: the APNs `.p8`
    // belongs to the Gateway host, and the team, profiles, and tokens belong to
    // whoever signs the build. The list of keys is the whole rule — a later
    // capability (an App Group for the notification extension) has to update
    // this test on purpose rather than slip in.
    const entitlements = read("ios/App/App/App.entitlements");
    expect(xcodeProject).toContain("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;");
    // The list is the whole rule: a capability has to be added here on purpose.
    const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    expect(keys).toEqual(["aps-environment", "com.apple.security.application-groups", "keychain-access-groups"]);
    expect(entitlements).toContain("<string>development</string>");
  });
});

describe("the notification service extension", () => {
  const appEntitlements = read("ios/App/App/App.entitlements");
  const extensionEntitlements = read("ios/App/MinihNotificationService/MinihNotificationService.entitlements");

  it("shares the same App Group and keychain group as the app", () => {
    // A service extension runs in its own process: without both groups it cannot
    // read the device token the app stored, and every notification falls back to
    // the fixed sentence (spec §17.6.2).
    for (const group of ["group.app.minih.remote"]) {
      expect(appEntitlements).toContain(`<string>${group}</string>`);
      expect(extensionEntitlements).toContain(`<string>${group}</string>`);
    }
    expect(appEntitlements).toContain("<string>$(AppIdentifierPrefix)group.app.minih.remote</string>");
    expect(extensionEntitlements).toContain("<string>$(AppIdentifierPrefix)group.app.minih.remote</string>");
  });

  it("is embedded in the app, or it never runs", () => {
    expect(xcodeProject).toContain("MinihNotificationService.appex in Embed Foundation Extensions");
    expect(xcodeProject).toContain('productType = "com.apple.product-type.app-extension"');
    expect(xcodeProject).toContain("MinihNotificationService/Info.plist");
  });

  it("declares the service extension point, or the system will not call it", () => {
    const info = read("ios/App/MinihNotificationService/Info.plist");
    expect(info).toContain("com.apple.usernotifications.service");
    expect(info).toContain("NotificationService");
  });
});

describe("android/app/src/main/AndroidManifest.xml", () => {
  it("never backs up the Keystore-wrapped secure storage", () => {
    expect(androidManifest).toContain('android:allowBackup="false"');
    expect(androidManifest).not.toContain("android:fullBackupContent");
    expect(androidManifest).not.toContain("android:dataExtractionRules");
  });

  it("never allows cleartext traffic", () => {
    expect(androidManifest).not.toContain("usesCleartextTraffic");
    expect(androidManifest).not.toContain("networkSecurityConfig");
    expect(exists("android/app/src/main/res/xml/network_security_config.xml")).toBe(false);
  });

  it("requests the internet permission, and the notification permission Android 13 asks for", () => {
    const permissions = [...androidManifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((match) => match[1]);
    // POST_NOTIFICATIONS is not a runtime capability grab: it is the prompt the
    // system shows before an app may post, and it exists because the app now draws
    // its own notifications (§17.6.6).
    expect(permissions).toEqual(["android.permission.POST_NOTIFICATIONS", "android.permission.INTERNET"]);
  });
});

describe("operator-supplied push artifacts stay out of the repository", () => {
  it("keeps the Firebase configuration out of the repository", () => {
    // The operator drops `android/app/google-services.json` in place for a local
    // build (spec §17.7), so its presence proves nothing. What must hold is that
    // git never sees it: the file names an app registration, and a build that
    // ships someone else's would be rejected by FCM.
    for (const ignored of ["google-services.json", "GoogleService-Info.plist", "firebase-adminsdk"]) {
      expect(rootGitignore).toContain(ignored);
    }
    expect(exists("android/app/src/main/google-services.json")).toBe(false);
    expect(exists("ios/App/App/GoogleService-Info.plist")).toBe(false);
  });

  it("depends on the Capacitor push plugin and on no Firebase SDK", () => {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    expect(dependencies["@capacitor/push-notifications"]).toBeTruthy();
    // The native side is a platform plugin, not the Firebase JS SDK: no
    // Google/Firebase package belongs in a bundle that ships to app stores.
    for (const name of Object.keys(dependencies)) {
      expect(name, name).not.toMatch(/firebase|fcm/i);
    }
  });
});

describe("push notification resources", () => {
  it("ships the eight localization keys the Gateway can name, in both languages", () => {
    // A notification is rendered by the system when the app is in the background
    // or closed (§11.6), so these files — not the JS catalog — are what the user
    // reads. `push-strings.test.ts` proves they match the catalogs.
    const iosEnglish = read("ios/App/App/en.lproj/Localizable.strings");
    const iosChinese = read("ios/App/App/zh-Hans.lproj/Localizable.strings");
    const androidEnglish = read("android/app/src/main/res/values/strings.xml");
    const androidChinese = read("android/app/src/main/res/values-zh-rCN/strings.xml");
    expect(iosEnglish).toContain('"push.notify.turn.completed.title"');
    expect(iosChinese).toContain('"push.notify.turn.completed.title"');
    expect(androidEnglish).toContain('name="push_notify_turn_completed_title"');
    expect(androidChinese).toContain('name="push_notify_turn_completed_title"');
  });

  it("registers the iOS strings in the app target", () => {
    expect(xcodeProject).toContain("Localizable.strings in Resources");
  });
});

describe("scripts", () => {
  it("builds the native bundle in the native mode and keeps the web build unchanged", () => {
    expect(packageJson.scripts["build"]).toBe("vite build");
    expect(packageJson.scripts["build:native"]).toBe("vite build --mode native");
    expect(packageJson.scripts["cap:sync"]).toBe("cap sync");
  });

  it("keeps the asset generator out of the workspace dependency graph", () => {
    // `@capacitor/assets` pins sharp, whose install script downloads a native
    // libvips binary; as a workspace dependency its build script would run on
    // every install (CI, docs, release) for a one-off icon regeneration.
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    expect(dependencies["@capacitor/assets"]).toBeUndefined();
    expect(packageJson.scripts["cap:assets"]).toBeUndefined();
  });
});

describe(".gitignore", () => {
  it("ignores the generated and machine-local native output", () => {
    for (const pattern of [
      "apps/remote-web/ios/App/Pods/",
      "apps/remote-web/ios/App/DerivedData/",
      "apps/remote-web/ios/App/App/public/",
      "apps/remote-web/ios/App/App/capacitor.config.json",
      "apps/remote-web/ios/**/xcuserdata/",
      "apps/remote-web/ios/**/*.xcuserstate",
      "apps/remote-web/android/.gradle/",
      "apps/remote-web/android/**/build/",
      "apps/remote-web/android/local.properties",
      "apps/remote-web/android/app/src/main/assets/public/",
      "apps/remote-web/android/app/src/main/assets/capacitor.config.json",
      "*.keystore",
      "*.jks",
      "GoogleService-Info.plist",
      "google-services.json",
    ]) {
      expect(rootGitignore, pattern).toContain(pattern);
    }
  });
});
