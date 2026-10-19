# ADR: Gateway-issued network center identity

- Status: Accepted for implementation
- Date: 2026-10-19
- Related: `03-runtime/12-provider-config-schema.md` §3 (Minih Router preset),
  [Router-account binding for remote control](remote-control-router-account-binding.md)
  (D666), `06-delivery/04-e2e-test-plan.md`
  (`E2E-NETWORK-CENTER-*`)

## Context

The desktop embeds an EasyTier node so that `minih-router` traffic can take an
encrypted overlay instead of the public internet. That channel needs a network
name, a network secret, bootstrap peers and the Router's own overlay address.
Until now the desktop could invent them: a brand default pair was compiled into
`crates/host-core/src/easytier_net/config.rs`
(`DEFAULT_EASYTIER_NETWORK_SECRET`), a gateway that did not answer
the bootstrap endpoint fell back to those values, and the tunnel started anyway.

Three consequences, all observed:

1. **A published key.** The repository is public, so the shared secret was
   public. Anyone who read it could join the mesh those clients created, and the
   tunnel's confidentiality claim did not hold.
2. **Requests to the wrong gateway.** `resolve_minih_router_endpoint` prefers the
   LAN tunnel whenever it is reachable. A user who pointed the Router row at a
   different deployment still had a tunnel to the brand default mesh, so the
   "LAN first" path served a gateway that did not have their account, while the
   correctly configured public endpoint sat idle behind it. Hungraim builds had
   the same defect in the opposite direction, and a build-time brand switch is
   not a security boundary.
3. **Endpoint changes did not take effect.** The bootstrap cache was keyed by a
   digest of the AccessKey alone, and the only triggers were an explicit
   reconfigure or reconnect. Switching the Router endpoint or rotating the key
   therefore kept serving the previous gateway's identity — for up to seven days.

The gateway side already understands the answer: `GET <root>/api/easytier/bootstrap`
with `Authorization: Bearer <AccessKey>` returns the identity the account should
use, and can spell out its own control-plane URL as `router_lan_access`. It also
rate-limits authentication failures per IP, which rules out retry loops.

## Decision

**The gateway's answer is the only identity a normal install may use.**

- Persisted settings gain `identity: "gateway" | "manual"`, defaulting to
  `gateway`, including for data written before the field existed.
- In `gateway` mode the tunnel starts **only** after a successful bootstrap
  response. Any failure — `404` from a gateway that never shipped the endpoint,
  `401`/`403` from a rejected key, a transport error — leaves the backend
  disabled and reports `state: error`, `usingLan: false`, the public endpoint as
  the active one, and the reason in `EasyTierStatus.bootstrapError`. The chat path
  keeps working against the row's public `baseUrl`; it simply stops pretending the
  overlay is available.
- **No built-in identity, in either language.** `DEFAULT_EASYTIER_NETWORK_SECRET`
  and `EASYTIER_DEFAULT_NETWORK_SECRET` are removed. Brand network parameters stay
  as *prefills* for manual mode and for settings normalization, never as a start
  input.
- The request goes to the Router row's own address (its public endpoint), which
  must be reachable without the tunnel. Fetching the identity through the No-TUN
  forward would be a deadlock: the forward needs the identity. The old
  "start, retry through the forward, restart once" path is deleted.
- The cache key is the control-plane root **plus** the AccessKey digest, so a
  changed endpoint or a rotated key misses. Credential writes on the
  `minih-router` row (`providers.create/update/setSecret/delete`) drop the cache
  and re-read once, asynchronously; nothing polls or retries.
- The credential row is the first `minih-router` row with both a base URL and a
  non-empty AccessKey, in creation order — the same row Settings shows.
- `identity: "manual"` uses exactly what a developer typed and requires a
  non-empty secret; it never asks the gateway. It is reachable only from developer
  mode.
- The settings section renders **only in developer mode**, is titled "Network
  Center" (zh-CN: 网络中心配置), and its user-visible copy does not name EasyTier.
  Internal identifiers, protocol fields and log names are unchanged.

The decision itself lives in `crates/host-core/src/easytier_net/identity.rs` as a
pure function of (saved settings, last bootstrap attempt), so "may we start, and
with what" is testable without a node, an HTTP server or a database.

## Consequences

- **Breaking for some existing installs, by design.** A user whose Router row
  pointed at an overlay address (for example `http://11.11.11.10:3001/v1`) relied
  on the tunnel to reach the very endpoint that issues the identity. After the
  upgrade the request cannot arrive, so the channel holds and requests stay on the
  public endpoint until the row points at a publicly reachable address. A user
  whose gateway does not implement the bootstrap endpoint is in the same position;
  developer mode's manual identity is the documented escape hatch, and the panel
  states both the reason and the requirement.
- **No user-visible switch for most people.** A normal profile does not see the
  section at all, so it also cannot turn the channel off. That is intentional: the
  channel is a transport detail, and the gateway decides whether it exists.
- **One identity per account, issued by the account's gateway.** Two rows on two
  gateways can no longer share a cached answer, and a row that loses its key stops
  being a source of identity rather than silently falling back.
- **Fewer failure modes, more explaining.** Strict mode turns a silent wrong-mesh
  join into a visible hold. Everything that used to be inferred at start time now
  has to be reported, which is why `bootstrapError` is part of the status contract
  and the panel renders it verbatim.
- **Operator work remains.** The identity is only as reachable as each gateway's
  published endpoint; peer addresses still come from the gateway's own
  `public_endpoint` configuration, and `11023/udp` must be reachable for a client
  to join.

## Alternatives

- **Keep the brand default as a last resort.** Rejected: it is the defect. A
  fallback identity is a published key plus a wrong-gateway route, and it fails
  silently by construction.
- **Ask the gateway through the tunnel (start-then-restart).** Rejected: it makes
  the tunnel's own existence depend on a request the tunnel has to carry, and it
  started a node on a network nobody had authorised.
- **Key the cache by AccessKey only and invalidate on endpoint change.** Rejected:
  the invalidation trigger is the same code that failed before, and a manual
  endpoint edit outside the RPC surface would still serve stale identity. Two
  fields in one key cost nothing and cannot be missed.
- **Expose the identity fields to every user and keep the built-in defaults as
  prefills.** Rejected: the fields are the gateway's, and offering them invites
  exactly the wrong-mesh join this ADR removes.
