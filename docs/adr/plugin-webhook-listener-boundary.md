# ADR: Webhook listener boundary and isolated token presentation

- **Status**: Accepted for implementation
- **Related**: [Plugin host capabilities](plugin-host-capabilities.md),
  [ADR 0142](0142-allow-non-loopback-http-mcp.md), ADR 0008 D009
- **Specs**: [Plugin API](../spec/07-plugins/03-plugin-api.md),
  [Plugin security](../spec/07-plugins/04-plugin-security.md),
  [Data storage](../spec/03-runtime/04-data-storage.md)

## Context

An inbound webhook needs to accept events from a directly connected LAN or an
EasyTier network, while the host retains the listener and authentication token.
Some private overlays use publicly allocated address ranges. The original
loopback-or-LAN-interface wording did not define how to admit those networks.
Renderer extensions also run in the main window and can access its generic IPC,
so a token-returning main-window IPC is not an isolated settings surface.

## Decision

1. The host binds IPv4 `0.0.0.0` and, when available, IPv6 `::` in LAN mode;
   local-only mode binds `127.0.0.1`. The default port is 37124; an occupied
   port selects a random available port and the chosen value is persisted. A
   listener exists only while an enabled, granted plugin declares a receiver.
2. Before reading a request body, the host admits only loopback, RFC1918,
   IPv4 link-local, CGNAT, IPv6 link-local, ULA, and directly connected local
   interface subnets with prefixes no broader than IPv4 /16 or IPv6 /48.
   Other peers receive `403`. This is a source-address filter, **not** proof
   that a request came through a particular interface or a guarantee against
   internet exposure; a directly connected public subnet may also match.
3. HTTP is unencrypted. The install and settings warning states that tokens and
   request contents can be intercepted. Users must use a trusted network or
   arrange their own secure transport and firewall rules.
4. The token is host-generated, stored in the secret store, and compared in
   constant time. Plugin APIs and events never return it. The main renderer IPC
   only opens a native system dialog and returns no token; a separate explicit
   user action in that dialog reveals, copies, or rotates it. No plugin-provided
   renderer code runs in the system dialog. ADR 0008 D009 still applies: native
   plugin entry code is not an OS sandbox, so this is not protection from a
   malicious plugin with the same operating-system user privileges.
5. Accepted method, sanitized headers and body are written to a host-owned
   private sidecar before its metadata is inserted. A `202` follows persistence;
   plugin completion is acknowledged separately. Unacknowledged events are
   replayed after restart or reload and retained for seven days. The event is
   delivered at least once, not exactly once.

## Consequences

The default supports LAN and overlay senders without exposing the token through
the main-window IPC. Source filtering and a bearer token are not substitutes for
TLS, a firewall, or sandboxing untrusted native plugin code. A crash between a
file deletion and its row deletion is recovered by retrying retention cleanup
before replay; startup also removes unreferenced host-generated sidecars.
