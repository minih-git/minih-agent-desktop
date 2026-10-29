# ADR: Lossless tool-image storage and bounded history mutations

- Status: Accepted implementation candidate
- Date: 2026-10-29
- Source: PI-Desktop issue #1868; selected content through `68868dfc8`

## Context

Structured tool results can repeat image bytes in content, details and exact JSON
text mirrors. Uploading a retained conversation for a normal delete, interrupted
prompt retraction or revision activation can exceed the existing 64 MiB RPC frame
limit. Removing fields would change the data observed by consumers. Raising the
limit would not remove the full-history transfer or data-loss races.

Minih has independent history and custom storage migrations. Schema v26 already
owns learned memory, so the upstream migration numbers cannot be copied.

## Decision

Keep SQLite and transcript ownership in Rust. Store reversible, record-local
image tables and exact text templates in self-contained transcript, revision and
checkpoint records and in the existing Desktop persistence outbox. Decode before
business consumers observe a record. Do not introduce a shared blob store, global
deduplication, wire compression or a new public message shape.

Append a backed-up v26-to-v27 version gate without changing learned-memory tables.
Continue reading legacy raw records. Convert legacy files only when writing, using
verified temporary output and atomic replacement. Validate existing encoded file
generations before mutation; replacing or changing a file invalidates the proof.

Add Host-owned message-ID deletion and pending-prompt retraction and opt-in
canonical-prefix revision activation. Retain the full-upload APIs and 64 MiB
limit. The Desktop serializes same-session deletions, drains pending durable
appends under the mutation fence and changes projections only after confirmation.
A failed drain preserves the pending entries and reports the operation failure.
The new Desktop mutation channels remain local-only under the existing remote
policy; this is not a new remote editing capability.

## Alternatives

- Dropping repeated structured or text fields is not lossless.
- Raising the transport ceiling retains the failure mode and increases exposure.
- A global image store introduces cross-session ownership and garbage collection
  beyond this requirement. Record-local encoding keeps copies self-contained.
- Renderer-owned canonical rewrites preserve stale-read races. IDs keep the
  authoritative mutation at the existing Host boundary.

## Consequences

The new application reads old records and restores exact decoded values. Unique
payloads may remain large, and arbitrary oversized RPC requests still fail.
Failed conversion does not replace the original file. Revisions/forks may each
own a copy of an image; no cross-record compression ratio is promised.

An older application must refuse the upgraded profile. Rollback requires the
complete pre-upgrade profile backup, not a manual schema-version downgrade.
Validation must cover TS/Rust golden parity, corrupted envelopes, atomic legacy
conversion, outbox drain failures, late events, concurrent deletion, canonical
revisions and Minih's learned-memory migration chain. No user profile is upgraded
as part of development verification.
