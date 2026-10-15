#!/usr/bin/env node
/**
 * Dual-write a release's updater feed and installers to the configured mirror.
 *
 * GitHub Releases stays the canonical source. A release may additionally publish
 * the same `latest*.yml` files, installers, and blockmaps to an S3-compatible
 * mirror (OSS / COS / R2 / MinIO) so desktop clients behind networks that
 * throttle github.com can still update (ADR 0022 amendment,
 * docs/spec/06-delivery/06-release-runbook.md).
 *
 * Usage:
 *   node scripts/publish-update-mirror.mjs [dist-dir] [--dry-run]
 *
 * Required to publish (all read from the environment):
 *   MINIH_UPDATE_MIRROR_S3_BUCKET
 *   MINIH_UPDATE_MIRROR_S3_ACCESS_KEY_ID
 *   MINIH_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY
 * Optional:
 *   MINIH_UPDATE_MIRROR_S3_ENDPOINT      S3-compatible endpoint URL
 *   MINIH_UPDATE_MIRROR_S3_REGION        bucket region
 *   MINIH_UPDATE_MIRROR_S3_PREFIX        key prefix, default "minih-agent-desktop"
 *   MINIH_UPDATE_MIRROR_PUBLIC_URL       public base URL, verified after upload
 *
 * `dist-dir` is resolved against the repository root (default: `dist`).
 *
 * With no bucket configured the script prints a notice and exits 0: a release
 * without a mirror keeps publishing to GitHub only.
 *
 * Feeds are uploaded last, after every artifact they reference, and with
 * `Cache-Control: no-cache`, so a client can never read a feed whose files are
 * still missing from the mirror.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = path.resolve(root, args.find((value) => !value.startsWith("--")) ?? "dist");

const env = {
  bucket: (process.env.MINIH_UPDATE_MIRROR_S3_BUCKET ?? "").trim(),
  endpoint: (process.env.MINIH_UPDATE_MIRROR_S3_ENDPOINT ?? "").trim(),
  region: (process.env.MINIH_UPDATE_MIRROR_S3_REGION ?? "").trim(),
  prefix: (process.env.MINIH_UPDATE_MIRROR_S3_PREFIX ?? "minih-agent-desktop")
    .trim()
    .replace(/^\/+|\/+$/g, ""),
  publicUrl: (process.env.MINIH_UPDATE_MIRROR_PUBLIC_URL ?? "").trim().replace(/\/+$/, ""),
  accessKeyId: (process.env.MINIH_UPDATE_MIRROR_S3_ACCESS_KEY_ID ?? "").trim(),
  secretAccessKey: (process.env.MINIH_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY ?? "").trim(),
};

if (!env.bucket) {
  console.log(
    "[mirror] MINIH_UPDATE_MIRROR_S3_BUCKET is not set; publishing to GitHub Releases only.",
  );
  process.exit(0);
}

if (!existsSync(distDir)) {
  console.error(`[mirror] missing release directory: ${distDir}`);
  process.exit(1);
}

const files = readdirSync(distDir).sort();
const feeds = files.filter((name) => /^latest(-[a-z0-9-]+)?\.yml$/.test(name));
if (feeds.length === 0) {
  console.error(
    `[mirror] no latest*.yml in ${distDir}: refusing to publish an empty mirror`,
  );
  process.exit(1);
}

const versionOf = (feed) => {
  const match = readFileSync(path.join(distDir, feed), "utf8").match(
    /^version:\s*(\S+)\s*$/m,
  );
  return match?.[1] ?? null;
};
const versions = [...new Set(feeds.map(versionOf).filter(Boolean))];
if (versions.length !== 1) {
  console.error(
    `[mirror] feeds disagree on version (${versions.join(", ") || "none"}): refusing to publish`,
  );
  process.exit(1);
}
const version = versions[0];

if (!env.accessKeyId || !env.secretAccessKey) {
  console.error(
    "[mirror] MINIH_UPDATE_MIRROR_S3_BUCKET is set but " +
      "MINIH_UPDATE_MIRROR_S3_ACCESS_KEY_ID / MINIH_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY are missing.",
  );
  process.exit(1);
}

const target = `s3://${env.bucket}${env.prefix ? `/${env.prefix}` : ""}`;
const transport = [];
if (env.endpoint) transport.push("--endpoint-url", env.endpoint);
if (env.region) transport.push("--region", env.region);

/** Run one AWS CLI command, or print it when the caller asked for a preview. */
function run(commandArgs) {
  if (dryRun) {
    console.log(`[dry-run] aws ${commandArgs.join(" ")}`);
    return;
  }
  const result = spawnSync("aws", commandArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: env.accessKeyId,
      AWS_SECRET_ACCESS_KEY: env.secretAccessKey,
      AWS_DEFAULT_REGION: env.region || undefined,
      AWS_EC2_METADATA_DISABLED: "true",
    },
  });
  if (result.error) {
    console.error(`[mirror] aws CLI unavailable: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[mirror] aws ${commandArgs[0]} failed with exit code ${result.status}`);
    process.exit(1);
  }
}

console.log(`[mirror] publishing ${version} to ${target}`);

// Artifacts first: a feed that is visible before its files would make clients
// download 404s.
run([
  "s3",
  "sync",
  distDir,
  target,
  ...transport,
  "--delete",
  "--exclude",
  "latest*.yml",
]);

for (const feed of feeds) {
  run([
    "s3",
    "cp",
    path.join(distDir, feed),
    `${target}/${feed}`,
    ...transport,
    "--cache-control",
    "no-cache",
  ]);
}

if (env.publicUrl) {
  const url = `${env.publicUrl}/${env.prefix ? `${env.prefix}/` : ""}latest.yml`;
  if (dryRun) {
    console.log(`[dry-run] verify ${url} serves ${version}`);
  } else {
    let served = null;
    try {
      const response = await fetch(url, { cache: "no-store" });
      served = response.ok ? await response.text() : `HTTP ${response.status}`;
    } catch (error) {
      console.error(`[mirror] could not read ${url}: ${error.message}`);
      process.exit(1);
    }
    const servedVersion = served.match(/^version:\s*(\S+)\s*$/m)?.[1] ?? null;
    if (servedVersion !== version) {
      console.error(
        `[mirror] ${url} serves ${servedVersion ?? served?.slice(0, 80) ?? "nothing"} instead of ${version}`,
      );
      process.exit(1);
    }
    console.log(`[mirror] verified ${url}`);
  }
}

console.log(`[mirror] ${feeds.length} feed(s) and artifacts published for ${version}`);
