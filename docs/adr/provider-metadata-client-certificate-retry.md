# ADR: Retry optional client-certificate failures only for provider metadata

- Status: Accepted for implementation
- Date: 2026-10-21
- Source: PI-Desktop `9a69e1d8863bbb94e0bb7d930b13a26bf460864d`
- Related: [outbound proxy](0177-user-configurable-outbound-proxy.md),
  [trusted certificates](provider-system-certificates.md)

## Context

Electron 43 can fail before HTTP when a provider merely requests an optional
client certificate. Globally changing the certificate responder or disabling
TLS verification would affect unrelated traffic. Model discovery and connection
probes are replayable metadata; agent turns are not.

## Decision

Only the exact Chromium client-certificate-needed error may retry once, for
HTTPS GET/OPTIONS metadata. Use a Node HTTPS request without client identity
through the existing authenticated relay, which resolves Chromium's current
route per destination. Keep default plus OS roots, hostname checks, the same
abort budget and manual redirects so discovery retains its origin guards.
No new permissions, persisted credentials, provider endpoint rules or global
TLS defaults are introduced. Minih Router LAN/public selection stays upstream
of this transport and is not replaced.

## Consequences

Optional authentication can proceed without a client certificate; required
client authentication and invalid server identity still fail. Other network
errors and ordinary HTTP responses cannot invoke the fallback. The bounded
socket lifecycle owns cancellation during tunnel establishment, handshake and
body consumption. Unit tests plus a local Electron/TLS fixture must prove
these boundaries; this decision is not a claim of test completion.
