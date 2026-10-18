# ADR 0332: Serve the plugin marketplace from the project's own distribution repository

- Status: Accepted
- Date: 2026-10-18
- Deciders: Minih-Agent-Desktop plugin and distribution maintainers
- Related: ADR 0102, ADR 0276 (this ADR supersedes its official-channel definition), ADR 0006, ADR 0007

## Context

The marketplace's official channel was an external plugin center at
`plugins.aiuo.net`, backed by the upstream PI-Desktop projects
(`vastsa/pi-plugin-center`, `AIUO-Net/pi-desktop-plugins`). The client did not
download the catalog's package URL directly: after refreshing
`https://plugins.aiuo.net/catalog.json` it called the platform's
`POST /api/v1/download/resolve` with `{ deviceId, pluginId, version }`, received
an ordered list of approved GitHub/CNB mirror URLs plus a digest per entry, and
used the catalog's own package URL only as a fallback. ADR 0276 records that
contract in full, including the device identifier host-core derived from the
machine identity and sent as a domain-separated sha256 digest.

That dependency carried costs the project decided it no longer wants to pay:

- A third-party service sat on the install path of every marketplace download,
  so its availability, latency, and deployment state were part of the client's
  own availability. The three-second resolve deadline and the catalog fallback
  existed only to soften that coupling.
- Each install sent an installation-stable device digest to a service the project
  does not operate. It was hashed and domain-separated, but it was still a
  privacy-relevant identifier that exists only because the platform counted and
  rate-limited per device.
- The client needed code for platform-specific semantics — resolve refusals
  (`403 NOT_PUBLISHED`, `403 PLUGIN_ARCHIVED`, `404`), per-device rate limiting,
  `503 NO_DOWNLOAD_SOURCE`, mirror ordering, and mirror-host validation — none of
  which applies to a catalog that names its own packages.
- The project already owns a distribution repository,
  `github.com/minih-git/minih-agent-plugins`, with `catalog.json`,
  `packages/*.piplug`, and plugin sources. Keeping the external center as the
  authoritative listing while also publishing there left two distribution
  authorities for one product surface.

## Decision

### 1. The distribution repository is the catalog

`OFFICIAL_CHANNEL_CATALOG_URL` is
`https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json`,
and it is the only catalog the shipped client reads
(`crates/host-core/src/plugins/marketplace.rs`). The Marketplace page has no
source selector. Persisted `pluginMarketSource` and `pluginMarketCustomUrl`
values remain readable for settings compatibility but are ignored by host-core;
`MINIH_AGENT_PLUGIN_MARKET_URL` keeps overriding the catalog for development and
tests and outranks the channel.

The repository layout stays: `catalog.json` at the root (schema v1,
`provider_id: "official"`), packages under `packages/<id>-<version>.piplug`,
plugin sources under `plugins/<id>/`, and a `README.md`. The catalog's
`artifact_base_url` names the repository's raw base (a relative value is also
valid) and package URLs are relative, so the recorded sha256 verifies the bytes
whether GitHub raw or a CNB mirror of the same repository serves them.

### 2. The resolve mechanism is removed

`crates/host-core/src/plugins/resolve.rs` and `device.rs` are deleted. There is no
`POST /api/v1/download/resolve`, no `deviceId`, no machine-identity derivation,
no persisted fallback device file, no platform-provided mirror list, and no
`InstallPhase::Resolve`.

An install has exactly one route: refresh the catalog, resolve the package URL
from the catalog (absolute, or relative to `artifact_base_url` / the catalog URL),
download once, verify the catalog's declared sha256, unpack, register, enable.
`InstallPhase` is `download`, `verify`, `install`, `enable`. Only the `download`
phase is cancellable, and the install dialog's Escape key is locked only during
`download`.

A failed marketplace install can therefore only report `PLUGIN_NETWORK`,
`PLUGIN_INTEGRITY`, `PLUGIN_MARKET_INVALID`, `PLUGIN_MARKET_UNTRUSTED_HOST`, or
`PLUGIN_CANCELLED`.

### 3. Retired error codes and RPC error numbers

The string codes `PLUGIN_MARKET_NOT_PUBLISHED`, `PLUGIN_MARKET_ARCHIVED`,
`PLUGIN_MARKET_NOT_FOUND`, `PLUGIN_MARKET_RATE_LIMITED`, and
`PLUGIN_MARKET_NO_SOURCE`, and host RPC error numbers `1020`–`1024`, are deleted
from host-core, from the shared error enum, from the host RPC mapping, and from
`apps/desktop/src`. Their names and numbers are retired with the center and are
not reused; `1020`–`1024` stay empty on purpose.

### 4. Publishing is a commit into the same repository

The center console and the MCP publishing skill are no longer part of the flow.
A maintainer packs with `packages/plugin-devkit`, puts the `.piplug` and the
regenerated `catalog.json` into the **same commit**, and pushes. A listed version
and its bytes never live in different commits, so a client cannot see a version
whose package is not published.

Before announcing a release, the repository preflight gates it:

```bash
pnpm check:marketplace -- \
  --url https://raw.githubusercontent.com/minih-git/minih-agent-plugins/main/catalog.json \
  --plugin <plugin-id>
```

It requires a valid semantic version, version uniqueness within the plugin, a
64-character SHA-256, a package URL, a positive package size, and a permissions
array.

### 5. The download allowlist does not change

Package and catalog fetches still require `https` (with `file://` and bare local
paths kept for the built-in catalog and local development catalogs), reject
embedded credentials, and require a host on the existing allowlist —
`github.com`, `githubusercontent.com`, `cnb.cool` — or the host that served the
catalog in effect. Redirects are re-checked against the same rule. An
off-allowlist URL still fails with `PLUGIN_MARKET_UNTRUSTED_HOST` before any
request leaves the machine.

### 6. Trust follows this project's catalog only

`verified` is honoured only when the catalog in effect equals
`OFFICIAL_CHANNEL_CATALOG_URL`. Any other catalog cannot promote itself: a
`verified` claim there degrades to `community`, and an unrecognised tier renders
as `unknown`. The repository currently redistributes third-party community
plugins, so its entries declare `trust: "community"` and `verified: false`.

## Consequences

- One external service leaves the install path. A marketplace install now
  depends on the git host serving the catalog and packages, not on a publishing
  platform's resolve API, deployment state, or uptime.
- A privacy-relevant identifier disappears. No device digest, no machine-identity
  derivation, and no fallback device file remain in the client.
- The client loses what the platform supplied: per-device download counting and
  rate limiting, platform-side archive/unpublish signals, mirror selection, and
  the center's publishing review. The catalog is the only statement of what is
  published; withdrawing a version means editing the catalog, and a broken
  package is caught by the digest rather than by a service refusing to serve it.
- Catalog and packages are maintained in this project's own repository. Catalog
  integrity relies on Git history, branch protection, and review of the
  distribution repository rather than on a platform-side audit trail; anyone who
  can commit to that branch can change what clients install.
- `verified` is now meaningful only for this project's catalog, which is why the
  redistributed community plugins stay `community`: a redistributor does not
  certify a publisher.
- Mirror support becomes ordinary catalog hosting. A CNB or other mirror of the
  same repository works by serving the same files; moving mirrors no longer needs
  a platform change or a client release.
- Five error codes and five host RPC error numbers are gone and stay
  unreassigned. Legacy persisted source settings remain ignored, and caches left
  by an older source are still ignored rather than deleted.

## Rejected alternatives

- **Keep the external center as a backup source.** Two authorities for one
  surface means the client must decide which list is current, and the fallback
  path is exactly the code being removed — resolve, device identity, mirror
  ordering, and platform refusal semantics. A backup that is never exercised is
  not a tested fallback, and keeping the device identifier alive on that path
  keeps the privacy cost.
- **Only change the catalog URL in Settings, keeping the resolve code.** The
  resolve request has no meaning for a static repository: there is no endpoint to
  call, no device counting to justify a `deviceId`, and no mirror list to
  consume. The client would keep dead paths, five unused error codes, and a
  privacy cost it never exercises.
- **Mirror the repository to CNB statically without changing the catalog
  source.** A static mirror of the same files is compatible with this decision,
  but leaving `plugins.aiuo.net` as the catalog source keeps the external center
  authoritative and keeps the resolve dependency. Mirroring is a hosting choice;
  it cannot be a substitute for owning the catalog.
