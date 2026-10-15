import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");
const { resolveUpdateSources } = await import("../electron/main/update-source.ts");

const MIRROR = "https://dl.example.com/minih";
const GITHUB_FEED = {
  provider: "github",
  owner: "minih-git",
  repo: "minih-agent-desktop",
};
const MIRROR_FEED = { provider: "generic", url: MIRROR };
const NEXT_VERSION = "0.20.2";

/**
 * Feed double with a scripted per-attempt behaviour: `error`, `fail-after`
 * (fails later than the check window), `hang` (never settles), `up-to-date`,
 * and `available` (which starts a download when auto-download is on).
 */
class PlanUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  feeds = [];
  checks = 0;
  cancellations = [];
  plan = [];

  setFeedURL(feed) {
    this.feeds.push(feed);
  }

  async checkForUpdates() {
    this.checks += 1;
    const step = this.plan.shift() ?? { kind: "up-to-date" };
    this.emit("checking-for-update");
    if (step.kind === "hang") return new Promise(() => undefined);
    if (step.kind === "fail-after") {
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          this.emit("error", new Error("feed unreachable"));
          reject(new Error("feed unreachable"));
        }, step.delayMs);
      });
    }
    if (step.kind === "error") {
      this.emit("error", new Error("feed unreachable"));
      throw new Error("feed unreachable");
    }
    if (step.kind === "up-to-date") {
      this.emit("update-not-available");
      return {
        updateInfo: {
          version: NEXT_VERSION,
          files: [],
          path: "",
          sha512: "",
          releaseDate: "",
        },
        cancellationToken: { cancel() {} },
        downloadPromise: null,
      };
    }
    const info = {
      version: NEXT_VERSION,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-13T00:00:00.000Z",
    };
    this.emit("update-available", info);
    const cancellationToken = {
      cancel: () => {
        this.cancellations.push(info.version);
        this.emit("update-cancelled", info);
      },
    };
    const downloadPromise = this.autoDownload ? Promise.resolve([]) : null;
    return { updateInfo: info, cancellationToken, downloadPromise };
  }

  async downloadUpdate() {
    return [];
  }

  quitAndInstall() {}
}

function createController({ updater, mirrors, ...overrides }) {
  const sent = [];
  const controller = new AppUpdaterController({
    logger: { app: () => {} },
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.20.1",
    platform: "darwin",
    isPackaged: true,
    autoUpdater: updater,
    readUpdateSettings: async () => ({}),
    sources: mirrors === undefined ? undefined : resolveUpdateSources(mirrors),
    autoCheckTimeoutMs: 15,
    manualCheckTimeoutMs: 15,
    sourceSettleTimeoutMs: 40,
    downloadStallTimeoutMs: 25,
    downloadRetryBackoffMs: 5,
    ...overrides,
  });
  return { controller, sent };
}

async function waitFor(predicate, label, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a failed check retries on the mirror and remembers the host", async () => {
  const updater = new PlanUpdater();
  updater.plan = [{ kind: "error" }, { kind: "available" }];
  const { controller } = createController({ updater, mirrors: MIRROR });

  await controller.check();
  assert.equal(updater.checks, 1);
  assert.deepEqual(updater.feeds, [GITHUB_FEED, MIRROR_FEED], "the next cycle is already pointed at the mirror");

  await waitFor(
    () => controller.getState().availableVersion === NEXT_VERSION,
    "the mirror to answer",
  );
  assert.equal(updater.checks, 2);
  assert.deepEqual(updater.feeds, [GITHUB_FEED, MIRROR_FEED]);
  assert.equal(controller.getState().feedHost, "dl.example.com");
  assert.equal(controller.getState().status, "downloading");

  // The mirror stays the preferred source for the next cycle.
  await controller.dismiss();
  updater.plan = [{ kind: "up-to-date" }];
  await controller.check();
  assert.equal(updater.checks, 3);
  assert.deepEqual(updater.feeds, [GITHUB_FEED, MIRROR_FEED]);
  assert.equal(controller.getState().feedHost, "dl.example.com");
  assert.equal(controller.getState().status, "up-to-date");
  controller.dispose();
});

test("a manual timeout is reported by code and still reaches the mirror", async () => {
  const updater = new PlanUpdater();
  // The feed answers later than the check window, which is the reported
  // "GitHub hangs on some networks" shape.
  updater.plan = [{ kind: "fail-after", delayMs: 25 }, { kind: "available" }];
  const { controller } = createController({ updater, mirrors: MIRROR });

  await assert.rejects(() => controller.check({ manual: true }));
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorCode, "check-timeout");
  assert.equal(controller.getState().error, "update check timed out");
  assert.equal(updater.checks, 1, "the timed-out attempt is not retried concurrently");

  await waitFor(
    () => controller.getState().availableVersion === NEXT_VERSION,
    "the settled failure to fall back",
  );
  assert.equal(updater.checks, 2);
  assert.equal(controller.getState().feedHost, "dl.example.com");
  assert.equal(controller.getState().errorCode, undefined);
  controller.dispose();
});

test("a request that never settles does not race a second source", async () => {
  const updater = new PlanUpdater();
  updater.plan = [{ kind: "hang" }, { kind: "available" }];
  const { controller } = createController({ updater, mirrors: MIRROR });

  await controller.check();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(updater.checks, 1, "no second feed while the first is in flight");
  // The next cycle starts where the failure left off.
  assert.equal(controller.getState().feedHost, "dl.example.com");
  await controller.check();
  assert.equal(updater.checks, 2);
  assert.deepEqual(updater.feeds, [GITHUB_FEED, MIRROR_FEED]);
  controller.dispose();
});

test("a download that stops progressing retries, then reports the stall", async () => {
  const updater = new PlanUpdater();
  updater.plan = [{ kind: "available" }, { kind: "available" }];
  const { controller, sent } = createController({ updater, mirrors: MIRROR });

  await controller.check();
  assert.equal(controller.getState().status, "downloading");

  await waitFor(() => updater.cancellations.length === 1, "the first stall");
  await waitFor(() => updater.checks === 2, "the retry on the mirror");
  assert.deepEqual(updater.feeds, [GITHUB_FEED, MIRROR_FEED]);
  assert.equal(controller.getState().feedHost, "dl.example.com");

  // The mirror stalls too: one retry per version, then the failure is visible.
  await waitFor(
    () => controller.getState().errorCode === "download-stalled",
    "the stalled download to be reported",
  );
  assert.equal(controller.getState().error, "update download stalled");
  assert.equal(updater.cancellations.length, 2);
  assert.equal(updater.checks, 2);
  const last = sent.at(-1).payload;
  assert.equal(last.errorCode, "download-stalled");
  controller.dispose();
});

test("a build without mirrors never overrides the feed or falls back", async () => {
  const updater = new PlanUpdater();
  updater.plan = [{ kind: "error" }, { kind: "available" }];
  const { controller } = createController({ updater });

  await controller.check();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(updater.checks, 1);
  assert.deepEqual(updater.feeds, [], "the packaged app-update.yml stays the feed");
  assert.equal(controller.getState().feedHost, "github.com");
  controller.dispose();
});

test("an installer failure moves the retry to the other source", async () => {
  const updater = new PlanUpdater();
  updater.plan = [{ kind: "error" }, { kind: "available" }];
  const { controller } = createController({ updater, mirrors: MIRROR });

  await controller.check();
  await waitFor(() => updater.checks === 2, "the mirror attempt");
  assert.equal(controller.getState().feedHost, "dl.example.com");

  // Bytes were in flight when this host failed, so the retry goes to the
  // canonical feed instead of the source that just broke.
  updater.emit("error", new Error("installer unavailable"));
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().feedHost, "github.com");
  assert.deepEqual(updater.feeds, [GITHUB_FEED, MIRROR_FEED, GITHUB_FEED]);
  controller.dispose();
});
