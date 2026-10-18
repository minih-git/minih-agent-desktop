/**
 * Static release-configuration test for the Capacitor shells (PR-5, §2/C4/C5).
 *
 * It reads the committed native project files with plain `node:fs` — no jsdom,
 * no simulator — and fails when a rule the client depends on is broken: HTTPS
 * only, no cleartext, no backup of the Keystore-wrapped data, and no push (PR-6
 * adds push separately).
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
    expect([...new Set(bundleIdentifiers)]).toEqual([config.appId]);
    expect(applicationId).toBe(config.appId);
  });

  it("keeps an https webview origin and never points the webview at a remote URL", async () => {
    const { default: config } = await import("../../capacitor.config.js");
    expect(config.server).toEqual({ androidScheme: "https" });
    expect(config.server?.url).toBeUndefined();
    expect(config.server?.cleartext).toBeUndefined();
    // `contentInset` stays default: the layout applies env(safe-area-inset-*).
    expect(config.ios?.contentInset).toBeUndefined();
    // No push configuration of any kind in this PR.
    expect(config.plugins?.PushNotifications).toBeUndefined();
  });
});

describe("ios/App/App/Info.plist", () => {
  it("never allows arbitrary or cleartext loads", () => {
    expect(infoPlist).not.toContain("NSAllowsArbitraryLoads");
    expect(infoPlist).not.toContain("NSExceptionAllowsInsecureHTTPLoads");
    expect(infoPlist).not.toContain("NSAllowsLocalNetworking");
  });

  it("declares no push or background mode", () => {
    expect(infoPlist).not.toContain("UIBackgroundModes");
    expect(infoPlist).not.toContain("aps-environment");
    expect(infoPlist).not.toContain("remote-notification");
    expect(infoPlist).not.toContain("fetch");
  });

  it("carries the display name and no machine-specific identity", () => {
    expect(infoPlist).toContain("<string>Minih Remote</string>");
    expect(infoPlist).not.toMatch(/DEVELOPMENT_TEAM|ProvisioningProfile|apple-team/i);
  });

  it("has no entitlements file and no push capability", () => {
    expect(exists("ios/App/App/App.entitlements")).toBe(false);
    expect(exists("ios/App/App/App.entitlements.plist")).toBe(false);
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

  it("requests the internet permission only", () => {
    const permissions = [...androidManifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((match) => match[1]);
    expect(permissions).toEqual(["android.permission.INTERNET"]);
  });
});

describe("no push artifacts in the repository", () => {
  it("ships no Firebase or APNs configuration", () => {
    expect(exists("android/app/google-services.json")).toBe(false);
    expect(exists("android/app/src/main/google-services.json")).toBe(false);
    expect(exists("GoogleService-Info.plist")).toBe(false);
    expect(exists("ios/App/App/GoogleService-Info.plist")).toBe(false);
  });

  it("depends on no push plugin", () => {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const name of Object.keys(dependencies)) {
      expect(name, name).not.toMatch(/push|firebase|fcm/i);
    }
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
