# ADR: Installation-scoped remote device replacement

- Status: Accepted
- Context: [Router-account remote control](remote-control-router-account-binding.md),
  [Gateway and mobile client](0331-self-hosted-gateway-and-mobile-client.md)

## Context

Device IDs identify credentials, not physical hardware. A new approval or
pairing ticket mints a new token. Previously, replacing the client-side token
left the previous Host/Gateway credential active, so one iPhone accumulated
several indistinguishable `iOS app` entries. Existing first-grant convergence
only collapses approvals of the same request, not later requests.

## Decision

A client may send an optional random UUIDv4 `installationId` on both device
creation routes. Native clients retain one ID per Gateway origin in their
existing non-synchronizing device-local secure store under a separate prefix;
browsers retain it in origin-local storage. Forgetting a Host or signing out
preserves it. Storage failures abort creation visibly. No hardware identifier
or fingerprint is collected.

This is correlation, not authentication. Account requests still require a
valid account session and Host approval. Tickets remain single-use. No role,
permission ceiling, strict-mode rule, or certificate check is relaxed.

The approving Host binds correlation to its approved grant using a separate
`installation: { id, signature }` frame extension. The signature covers the
canonical legacy grant payload and ID with a domain separator. The existing
grant signature is unchanged so old peers can still verify it. New peers reject
a changed/transplanted binding and preserve it through deferred delivery.

Only after storing an approved credential does a Host replace older credentials
of the same installation and account scope, or of the same proven desktop
`applicantHostId`. Ticket grants remain scoped to their individual Host and are
not merged with account grants. Different IDs and legacy records without IDs
are never merged by label. Superseded credentials retain revoked tombstones;
older deferred grants cannot displace newer ones. Same-request first-grant
convergence stays authoritative. Replacement revocations use the existing
signed relay and durable retry mechanism, including recovery from persisted
replacement tombstones on reconnect.

## Compatibility and consequences

All fields are optional extensions to existing JSON records; existing data is
preserved without a destructive migration or database schema change. Legacy
records remain uncorrelated until explicitly revoked. Clearing browser storage
or losing a native secure store creates a new installation and cannot safely
identify a former credential. Mixed old/new deployments remain usable, but
complete replacement requires updated clients, Gateway, and Hosts; old peers
may retain old credentials until a signed revocation arrives.

Settings therefore separates reachable computers from devices allowed to access
the current computer. Grant IDs and localized creation/last-use times distinguish
legacy same-name entries, and each retains an explicit two-step revoke action.
The list is not represented as a count of physical devices.

## Validation

Contract tests cover optional-field validation and unchanged legacy signatures.
Host regressions cover replacement, same-name isolation, rejected approval,
binding tampering, out-of-order delivery, restart, and signed revocations.
Loopback HTTP/mTLS integration covers account and ticket creation and verifies
old-token refusal on the actual Gateway/Host request path. Mobile tests cover
persistence, concurrent identity reads, secure-storage failure, and account flow.
