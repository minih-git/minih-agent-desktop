import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  nextVersion = "0.16.1";
  downloadStarts = [];
  cancellations = [];
  feeds = [];

  setFeedURL(feed) {
    this.feeds.push(feed);
  }

  async checkForUpdates() {
    this.emit("checking-for-update");
    const info = {
      version: this.nextVersion,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-03T00:00:00.000Z",
    };
    this.emit("update-available", info);
    const cancellationToken = {
      cancel: () => {
        this.cancellations.push(info.version);
        this.emit("update-cancelled", info);
      },
    };
    const downloadPromise = this.autoDownload
      ? (this.downloadStarts.push(info.version), Promise.resolve([]))
      : null;
    return { updateInfo: info, cancellationToken, downloadPromise };
  }

  async downloadUpdate() {
    return [];
  }

  quitAndInstall() {}
}

function createController({
  updater,
  settings = {},
  persist = async () => {},
  logger = { app: () => {} },
  ...overrides
}) {
  const sent = [];
  const controller = new AppUpdaterController({
    logger,
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.16.0",
    platform: "darwin",
    isPackaged: true,
    autoUpdater: updater,
    readUpdateSettings: async () => settings,
    persistDismissedVersion: persist,
    ...overrides,
  });
  return { controller, sent };
}

const ACCELERATOR_FEED = {
  provider: "generic",
  url: "https://gh-proxy.org/https://github.com/minih-git/minih-agent-desktop/releases/latest/download",
};

const OFFICIAL_FEED = {
  provider: "github",
  owner: "minih-git",
  repo: "minih-agent-desktop",
};

const ACCELERATOR_PAYLOAD = {
  code: 0,
  message: "success",
  data: {
    sources: [
      { prefix: "https://gh-proxy.org/", label: "gh-proxy.org" },
      { prefix: "https://ghfast.top/", label: "ghfast.top" },
    ],
    ttl_seconds: 3600,
  },
};

test("dismissing an in-app update cancels its download and disables install on quit", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const { controller } = createController({
    updater,
    persist: async (version) => persisted.push(version),
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
  assert.equal(controller.getState().status, "downloading");

  await controller.dismiss();

  assert.deepEqual(updater.cancellations, ["0.16.1"]);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().status, "available");
  assert.equal(controller.getState().dismissed, true);
  assert.deepEqual(persisted, ["0.16.1"]);
  controller.dispose();
});

test("a restored dismissal blocks that release and a newer release resumes automatic delivery", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  let clearDismissal;
  const cleared = new Promise((resolve) => {
    clearDismissal = resolve;
  });
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic", updateDismissedVersion: "0.16.1" },
    persist: async (version) => {
      persisted.push(version);
      if (version === null) clearDismissal();
    },
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().dismissed, true);

  updater.nextVersion = "0.16.2";
  await controller.check();
  await cleared;
  assert.deepEqual(updater.downloadStarts, ["0.16.2"]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(controller.getState().dismissed, false);
  assert.deepEqual(persisted, [null]);
  controller.dispose();
});

test("the router-published accelerator becomes the first source", async () => {
  const updater = new FakeUpdater();
  const { controller } = createController({
    updater,
    settings: { updatePreference: "manual" },
    loadRemoteUpdateSources: async () => ACCELERATOR_PAYLOAD,
  });

  await controller.check();

  assert.deepEqual(
    updater.feeds,
    [ACCELERATOR_FEED],
    "the accelerator feed is applied before the check, not the official one",
  );
  assert.equal(controller.getState().feedHost, "gh-proxy.org");
  assert.equal(controller.getState().availableVersion, "0.16.1");
  controller.dispose();
});

test("a failed accelerator fetch still runs the check on the packaged source", async () => {
  const updater = new FakeUpdater();
  const logs = [];
  const { controller } = createController({
    updater,
    settings: { updatePreference: "manual" },
    logger: { app: (...args) => logs.push(args) },
    loadRemoteUpdateSources: async () => {
      throw new Error("router unreachable");
    },
  });

  await controller.check();

  assert.deepEqual(updater.feeds, [], "the packaged app-update.yml stays the feed");
  assert.equal(controller.getState().feedHost, "github.com");
  assert.equal(controller.getState().availableVersion, "0.16.1");
  assert.ok(
    logs.some(([scope, level]) => scope === "updater" && level === "warn"),
    "the failed fetch is logged as a warning",
  );
  controller.dispose();
});

test("the accelerator list is requested once inside its published TTL", async () => {
  const updater = new FakeUpdater();
  let calls = 0;
  const { controller } = createController({
    updater,
    settings: { updatePreference: "manual" },
    loadRemoteUpdateSources: async () => {
      calls += 1;
      return ACCELERATOR_PAYLOAD;
    },
  });

  await controller.check();
  await controller.check();

  assert.equal(calls, 1, "the TTL keeps the second check off the router");
  assert.equal(controller.getState().feedHost, "gh-proxy.org");
  controller.dispose();
});

test("withdrawing every accelerator restores the official GitHub feed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const updater = new FakeUpdater();
  let payload = ACCELERATOR_PAYLOAD;
  const { controller } = createController({
    updater,
    settings: { updatePreference: "manual" },
    loadRemoteUpdateSources: async () => payload,
  });

  await controller.check();
  assert.deepEqual(
    updater.feeds,
    [ACCELERATOR_FEED],
    "the check runs against the accelerator the router published",
  );
  assert.equal(controller.getState().feedHost, "gh-proxy.org");

  // The router withdraws every accelerator, so the applied feed has to be
  // revoked explicitly: a feed-less packaged source cannot do that.
  payload = { code: 0, message: "success", data: { sources: [], ttl_seconds: 3600 } };
  t.mock.timers.setTime(Date.now() + 3_600_001);
  await controller.check();

  assert.deepEqual(
    updater.feeds,
    [ACCELERATOR_FEED, OFFICIAL_FEED],
    "the withdrawn accelerator is replaced by the official feed, not kept",
  );
  assert.equal(controller.getState().feedHost, "github.com");
  controller.dispose();
});
