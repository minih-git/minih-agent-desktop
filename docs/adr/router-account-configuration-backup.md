# ADR: Router-account hosted configuration backup

- Status: Accepted
- Supersedes: [S3-only configuration backup and synchronization](s3-only-configuration-backup-sync.md)

## Context

Configuration backup previously required every user to bring a private
S3-compatible bucket, endpoint, region, and scoped AWS credentials. The
product now ships with a Minih Router account system: one AccessKey row in
the providers store authenticates chat traffic, balance/quota reads, and the
model plaza. Requiring a second, separately provisioned cloud storage account
duplicates identity, adds setup cost, and leaves the backup destination
outside the account the user already trusts.

The encrypted portable vault, domain allowlists, three-way merge, approvals,
and the conditional-write (CAS) publication contract are unchanged and remain
worth keeping.

## Decision

Move the backup destination into the Minih Router backend, namespaced per
AccessKey:

- The gateway exposes `GET/PUT /api/client-backup/objects/<name>` and
  `POST /api/client-backup/probe` on its control plane, authenticated by the
  account's Bearer AccessKey. Objects are raw bytes with strong quoted ETags;
  writes require `If-None-Match: *` or `If-Match` and the check plus write are
  one database transaction. The backend stores objects in its own database
  (`client_backup_objects`), caps objects at 64 MiB and each account at
  1 GiB, and answers the probe by running the CAS sequence itself.
- Host-core keeps vault encryption, merge, scheduling, and import ownership.
  Its transport resolves the connected account row live (first enabled
  `minih-router` provider with a token), prefers the EasyTier LAN endpoint
  when reachable, and binds the stored configuration to the SHA-256
  fingerprint of the account token. A rotated or switched account requires
  setting the backup up again, mirroring the previous credential-binding
  rules.
- The connected account row itself is device-local and never captured,
  applied, or tombstoned by sync — the account is the transport identity, not
  portable configuration. A second device joins by connecting the same
  account and entering the same vault password.
- The standalone S3 connection UI, SigV4 transport, and connection-credential
  storage are removed. The stored configuration moves to the
  `configSyncRouter` namespace with a fresh local state identity; old S3
  configuration and cloud objects are left untouched and inert, following the
  WebDAV→S3 precedent.

## Consequences

- One account identity covers chat, account reads, and backup storage; no
  third-party storage setup remains.
- End-to-end confidentiality is unchanged: the gateway stores authenticated
  ciphertext and never receives the backup password or vault key. It does
  learn object sizes, timing, and names, as any storage backend does.
- Storage is bounded server-side by the per-account quota instead of being
  the user's own bucket cost; the operator runs the storage.
- A gateway operator can deny service or serve stale valid state to a fresh
  device, exactly as the S3 provider could; local recovery points and the
  activation workflow remain the mitigations.
- A rotated AccessKey invalidates the bound destination until the backup is
  set up again (the server namespace survives rotation, but the client cannot
  prove it, so it conservatively requires re-configuration).

## Alternatives rejected

1. Keep S3 alongside the account backend: preserves a second transport,
   credential surface, and setup path that the account system makes
   unnecessary.
2. Upload plaintext or a database dump to the gateway: removes the
   end-to-end encrypted vault contract.
3. Let the account provider row sync like other providers: it is the
   transport identity; syncing it duplicates rows on receiving devices and
   tombstones their working account.
4. Store backups on the gateway filesystem outside the database: loses
   transactional CAS, per-account isolation, and existing backup/operational
   story.
