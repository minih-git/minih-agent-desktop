/**
 * The platform string resources a push needs (protocol §11.6, R5 PR-6).
 *
 * A notification is rendered by the *system*: when the app is in the background
 * or closed, iOS and Android resolve the `loc-key` / `title_loc_key` the Gateway
 * sent against the app bundle's own resources. If those files are missing or
 * stale, the user sees `PUSH.NOTIFY.APPROVAL.REQUESTED.TITLE` or an empty banner
 * — which is the main scenario for a notification, so it is worth a test.
 *
 * `scripts/generate-push-strings.mjs` renders the files from `src/locales`; this
 * test proves the committed files are exactly what that script would write.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "../locales/en.js";
import { zhCN } from "../locales/zh-CN.js";
import { PUSH_STRING_TARGETS, androidResourceName, pushKeys, renderPushStrings } from "./push-strings.js";

const appRoot = join(import.meta.dirname, "..", "..");

describe("push string resources", () => {
  it("commits exactly the files the generator renders from the catalogs", async () => {
    const rendered = renderPushStrings({ en, "zh-CN": zhCN });
    for (const [relative, expected] of Object.entries(rendered)) {
      const actual = await readFile(join(appRoot, relative), "utf8");
      // A catalog edit that is not regenerated fails here, which is the only way
      // to keep a system-rendered notification in the right language.
      expect(actual, `${relative} is stale: run node scripts/generate-push-strings.mjs`).toBe(expected);
    }
  });

  it("covers all eight keys in both languages, and nothing about content", () => {
    const keys = pushKeys();
    expect(keys).toHaveLength(8);
    expect(keys).toContain("push.notify.approval.requested.title");
    expect(keys).toContain("push.notify.turn.failed.body");
    for (const catalog of [en, zhCN]) {
      for (const key of keys) {
        const value = catalog[key as keyof typeof en];
        expect(value, key).toBeTruthy();
        // Fixed copy only: no placeholder, no session title, no tool name.
        expect(value).not.toContain("{{");
      }
    }
  });

  it("names Android resources the way Android requires", () => {
    // Android resource names are [a-z0-9_]: a dotted key would not resolve, and
    // the banner would come up empty.
    expect(androidResourceName("push.notify.approval.requested.title")).toBe("push_notify_approval_requested_title");
    expect(androidResourceName("a.b-c")).toBe("a_b_c");
  });

  it("keeps the generated Android files valid resources with their names preserved", async () => {
    const english = await readFile(join(appRoot, PUSH_STRING_TARGETS["android-en"]), "utf8");
    const chinese = await readFile(join(appRoot, PUSH_STRING_TARGETS["android-zh-rCN"]), "utf8");
    for (const xml of [english, chinese]) {
      expect(xml.startsWith("<?xml")).toBe(true);
      expect(xml.trimEnd().endsWith("</resources>")).toBe(true);
      // The app name stays: the file also carries what Capacitor generated.
      expect(xml).toContain('<string name="app_name">Minih Remote</string>');
      expect(xml).not.toMatch(/name="[^"]*[.-][^"]*"/);
    }
    // The Chinese file must actually be the Chinese copy.
    expect(chinese).toContain("等你批准");
    expect(english).not.toContain("等你批准");
  });

  it("registers the iOS strings with the app target, or they ship nowhere", async () => {
    // A `.strings` file that is not in the Xcode project is simply not in the
    // bundle, and iOS falls back to showing the raw key.
    const project = await readFile(join(appRoot, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
    expect(project).toContain("Localizable.strings in Resources");
    expect(project).toContain('"zh-Hans",');
    const english = await readFile(join(appRoot, PUSH_STRING_TARGETS["ios-en"]), "utf8");
    expect(english).toContain('"push.notify.approval.requested.title" = "Needs your approval";');
  });
});
