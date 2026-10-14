#!/usr/bin/env bash
# Release build for native macOS: Developer ID-signed and notarized DMG/ZIP.
#
# Local builds without a certificate remain unsigned. This script injects a
# real signing identity and requires notarization credentials:
#
#   MAC_SIGNING_IDENTITY   required — bare common name, e.g. "Name (TEAMID)";
#                          electron-builder rejects the
#                          "Developer ID Application:" prefix
#   APPLE_ID               Apple ID email for notarization
#   APPLE_APP_SPECIFIC_PASSWORD  app-specific password for the Apple ID
#   APPLE_TEAM_ID          Apple Developer Team ID; must match the team id
#                          in MAC_SIGNING_IDENTITY's parentheses
#   MAC_ARCH               optional `arm64` or `x64`; must match the host
#
# Observability: the packaging command runs under
# scripts/macos-signing-watchdog.mjs, which enables the per-file signing trace
# (DEBUG=electron-osx-sign*) and the notarization progress
# (DEBUG=electron-notarize*), prints a heartbeat while electron-builder is
# silent, dumps diagnostics when the signing phase stalls, bounds the phase
# with a hard timeout, and reports per-file codesign timings. The
# `signing Minih-Agent-Desktop.app` line electron-builder emits is otherwise the last
# thing the log shows for minutes, because nested signing, silent full
# retries, and Apple's notarization queue all happen without output.
# See docs/spec/06-delivery/06-release-runbook.md for the full runbook.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: scripts/release-macos.sh must run on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) DEFAULT_MAC_ARCH=arm64 ;;
  x86_64) DEFAULT_MAC_ARCH=x64 ;;
  *)
    echo "error: unsupported macOS runner architecture: $(uname -m)." >&2
    exit 1
    ;;
esac

MAC_ARCH="${MAC_ARCH:-$DEFAULT_MAC_ARCH}"
case "$MAC_ARCH" in
  arm64|x64) ;;
  *)
    echo "error: MAC_ARCH must be arm64 or x64 (got: $MAC_ARCH)." >&2
    exit 1
    ;;
esac

if [[ "$MAC_ARCH" != "$DEFAULT_MAC_ARCH" ]]; then
  echo "error: MAC_ARCH=$MAC_ARCH requires a native $MAC_ARCH macOS runner; this host is $DEFAULT_MAC_ARCH." >&2
  exit 1
fi

if [[ -z "${MAC_SIGNING_IDENTITY:-}" ]]; then
  echo "error: MAC_SIGNING_IDENTITY is required (bare common name, e.g. \"Name (TEAMID)\")." >&2
  echo "For an unsigned local build use: pnpm --filter @minih-agent/desktop dist" >&2
  exit 1
fi
MAC_SIGNING_IDENTITY="${MAC_SIGNING_IDENTITY#Developer ID Application: }"
if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "error: APPLE_TEAM_ID is required for notarization." >&2
  exit 1
fi

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  echo "error: notarization credentials are required (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD)." >&2
  echo "For an unsigned local build use: pnpm --filter @minih-agent/desktop dist" >&2
  exit 1
fi

SIGNING_TEAM="${MAC_SIGNING_IDENTITY##*(}"
SIGNING_TEAM="${SIGNING_TEAM%)}"
if [[ "$APPLE_TEAM_ID" != "$SIGNING_TEAM" ]]; then
  echo "error: APPLE_TEAM_ID ($APPLE_TEAM_ID) must match the team in MAC_SIGNING_IDENTITY (${MAC_SIGNING_IDENTITY})." >&2
  exit 1
fi

echo "==> Building host-core (release)"
cargo build -p host-core --release

echo "==> Building workspace packages"
pnpm -r --filter '!@minih-agent/desktop' build

echo "==> Bundling the agent-runtime sidecar"
pnpm --filter @minih-agent/agent-runtime bundle

echo "==> Building the desktop bundles"
pnpm --filter @minih-agent/desktop exec electron-vite build

echo "==> Packaging the desktop (Developer ID signed + notarized, $MAC_ARCH)"
# `--publish never` keeps a local checkout from publishing to GitHub; the
# Release workflow owns publication. The watchdog is transparent: it forwards
# every line, keeps the child's exit code, and only fails on its own timeout.
# `electron-builder` is intentionally absent from DEBUG: builder-util's
# `executing` line prints every spawned command with only its own stem list
# redacted, which leaves `security set-key-partition-list -k <p12 password>`
# in clear text on a terminal or in a log file.
PI_STAPLER_MAX_ATTEMPTS="${PI_STAPLER_MAX_ATTEMPTS:-6}" \
PI_STAPLER_RETRY_DELAY_SECONDS="${PI_STAPLER_RETRY_DELAY_SECONDS:-10}" \
DEBUG="${DEBUG:-electron-osx-sign*,electron-notarize*}" \
  node scripts/macos-signing-watchdog.mjs --label "release-macos-${MAC_ARCH}" -- \
  pnpm --filter @minih-agent/desktop exec electron-builder --mac "--${MAC_ARCH}" \
    --publish never \
    -c.mac.identity="${MAC_SIGNING_IDENTITY}" \
    -c.mac.forceCodeSigning=true \
    -c.mac.notarize=true

echo "==> Analyzing the packaged app bundle"
node scripts/macos-bundle-inventory.mjs apps/desktop/release

echo "==> Notarizing and stapling the DMG"
scripts/notarize-and-staple-macos-release-dmg.sh apps/desktop/release

echo "==> Verifying the signed and notarized release"
scripts/verify-macos-release.sh apps/desktop/release

echo "==> Done. Artifacts in apps/desktop/release/"
