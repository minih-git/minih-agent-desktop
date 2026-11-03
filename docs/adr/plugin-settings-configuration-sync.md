# ADR: Host-owned declared plugin settings synchronization

- Status: Accepted for implementation
- Date: 2026-11-03
- Amends: [ADR 0300](0300-host-owned-encrypted-portable-configuration-sync.md), [ADR 0336](0336-global-config-sync-and-project-archive.md)

## Context

The Plugins cloud category previously retained installation metadata only.
Users could enable it and still lose their configured preferences when moving
to another device. SDK settings writes happened in Electron Main while sync
imports run in Host Core; adding another file writer without serialization
would risk overwriting an in-flight save. Copying the whole plugin data tree
would also export credentials, paths, databases and local authorization.

## Decision

Keep the SDK and fixed settings JSON format, but route SDK writes through an
internal Host RPC and atomic settings repository. The AppState mutex serializes
read/modify/write with sync application. The runtime supplies the loaded plugin
identity; plugins cannot choose an RPC method or another plugin id.

Transport only declared, type-validated, saved portable values in a separate
`pluginSettings` domain, gated by the existing Plugins category. Keep install
records separate. Preserve undeclared/reserved fields and device-specific paths
and credentials; never export arbitrary plugin data or permission grants.
Imports require an installed global plugin and local digest-bound approval.
Managed keys without values represent explicit resets. A cloud entity deletion
never deletes the receiving plugin's private settings file.

Use the existing unknown-domain rejection as the compatibility boundary:
all devices must upgrade before publishing this domain. Reusing the old plugin
entity payload would let older clients strip settings or turn them into a
spurious deletion. No SQLite schema migration is needed; existing settings
files and old encrypted revisions remain readable.

## Alternatives and consequences

- Reject exporting all plugin data: it crosses privacy and authorization
  boundaries and cannot distinguish portable preferences from local state.
- Reject a second Electron-owned synchronization scheduler or file writer:
  it would duplicate lifecycle ownership and race the Host import journal.
- Reject embedding settings in installation intent: old clients know that
  domain and would silently discard the additional fields.
- Existing SDK callers retain their interface, but corrupt or oversized files
  now fail writes visibly instead of being reset to defaults.
- A plugin that caches its preferences may need a reload after restore.
- Only declared portable settings are covered; undeclared plugin state and
  installation/activation still need explicit local setup.

Behavior and bounds are specified in
[configuration sync](../spec/03-runtime/22-config-sync.md).
