#!/usr/bin/env node
/** Actual isolated Host processes against a local Minih Router backup fixture. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { startRouterFixture } from "./e2e/config-sync-router-fixture.mjs";
import { MARKERS, PASSWORD, connectRouter, rpc, runSyncJourney, runBackupJourney } from "./e2e/config-sync-journey.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const label = `config-sync-${randomUUID()}`;
const binary = resolveHostBinary();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const base = execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root });
// Record whether the tested tree was exactly the committed candidate.
const workingDiff = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
const dataRoot = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "minih-config-sync-e2e-"));
const hosts = [];
const errors = [];
let store;
let report;
let cleanup;
let currentStep = "setup";
const step = (name) => { currentStep = name; console.log(`CONFIG_SYNC_STEP ${name}`); };
try {
  store = await startRouterFixture(label);
  assert.equal((await store.inventory()).length, 0, "new test account namespace must be empty");
  console.log(`CONFIG_SYNC_NAMESPACE ${label}`);
  for (const name of ["a", "b", "c", "d"]) {
    const home = join(dataRoot, name, "home");
    await mkdir(home, { recursive: true });
    hosts.push(new Host(binary, join(dataRoot, name, "data"), {
      env: { HOME: home, USERPROFILE: home, MINIH_AGENT_AGENTS_DIR: join(home, "agents"), XDG_CONFIG_HOME: join(home, ".config"), DEBUG_HOST: "" },
    }));
  }
  await Promise.all(hosts.map((host) => host.start()));
  await Promise.all(hosts.map((host) => rpc(host, "settings.set", { networkPolicy: { mode: "relaxed" } })));
  const [a, b, c, d] = hosts;
  step("router-account-link");
  // The backup destination is the connected account, so every isolated Host
  // links its own account row to the same fixture before any journey step.
  for (const host of hosts) await connectRouter(host, store.account);
  const context = { a, b, c, d, router: store.account, store, step };
  await runSyncJourney(context);
  await runBackupJourney(context);
  step("ciphertext-retention-and-disconnect");
  const inventory = await store.inventory();
  assert.ok(inventory.some((key) => key.includes("/revisions/")));
  assert.ok(inventory.some((key) => key.includes("/objects/")));
  const inspected = await store.inspect([...MARKERS, PASSWORD, store.account.accessKey]);
  for (const host of hosts) assert.equal((await rpc(host, "configSync.disconnect")).configured, false);
  assert.deepEqual(await store.inventory(), inventory, "disconnect must not delete remote data");
  report = { mode: store.kind, devices: hosts.length, namespace: store.label, candidate: revision, base, workingDiff, binarySha256, ...inspected };
} catch (error) {
  errors.push(error);
} finally {
  const stopped = await Promise.allSettled(hosts.map((host) => host.stop()));
  for (const result of stopped) if (result.status === "rejected") errors.push(result.reason);
  if (store) {
    try {
      assert.ok(stopped.every((result) => result.status === "fulfilled"), "refusing cloud cleanup while a Host may still publish");
      cleanup = await store.cleanup();
      assert.equal(cleanup.remaining, 0);
      assert.equal(cleanup.versions, 0);
    } catch (error) { errors.push(error); }
    try { await store.close(); } catch (error) { errors.push(error); }
  }
  // Retain isolated data if a process could still be using it.
  if (stopped.every((result) => result.status === "fulfilled")) {
    try { await rm(dataRoot, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
}
if (errors.length) {
  // Never print raw live RPC/SDK errors, which may contain endpoint or credential data.
  console.error("CONFIG_SYNC_FAILED " + JSON.stringify({ step: currentStep, namespace: label, cleanup, binarySha256, failures: errors.length, codes: errors.map((error) => ({ code: /^CONFIG_SYNC_[A-Z_]+$/.test(error.errorCode ?? "") ? error.errorCode : undefined, status: error.safeStatus, actual: ["boolean", "number"].includes(typeof error.actual) ? error.actual : undefined, expected: ["boolean", "number"].includes(typeof error.expected) ? error.expected : undefined, diagnostics: error.message?.match(/CONFIG_SYNC_[A-Z_]+|PROJECT_ARCHIVE_[A-Z_]+|PROVIDER_[A-Z_]+|HTTP \d{3}/g), location: error.stack?.split("\n").find((line) => line.includes("config-sync-journey.mjs:"))?.match(/config-sync-journey\.mjs:\d+:\d+/)?.[0] })) }));
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("CONFIG_SYNC_MULTIDEVICE " + JSON.stringify({ ...report, cleanup, result: "passed" }));
}
