# ADR 0342: Per-address proxy routing for the built-in browser

- Status: Accepted
- Date: 2026-11-25
- Deciders: Minih-Agent-Desktop core
- Related: ADR 0177, D340, `04-ux/06-settings-ia.md`,
  `03-runtime/04-data-storage.md`, `06-delivery/04-e2e-test-plan.md`

## Context

ADR 0177 applied one outbound proxy to every Chromium session, including the
work-panel browser (`persist:work-browser`, shared with the Agent `Browser`
tool). Every session got the same `proxyRules`, or `system`, or `direct`.

That uniform route is wrong for the workflow the in-app browser exists for.
A user behind a corporate proxy reaches the intranet through it and the open
internet through a personal proxy; another wants the intranet direct and
everything else through the proxy. With one global setting they must switch
the proxy by hand before each page, and the model, marketplace, and updater
traffic — which are fine on one route — are forced to follow the switch too.

Browsers solve this with a PAC script: an ordered rule list over host and URL,
compiled into a `FindProxyForURL` function, plus one default exit. SwitchyOmega
("auto switch" profiles) is the reference model users know.

## Decision

1. **Scope is the built-in browser only.** Optional
   `AppSettings.browserProxyRouting` drives `persist:work-browser`; model
   calls, the agent sidecar, host-core `curl`, updates, and plugin panels keep
   the global `networkProxy` of ADR 0177. Absent or `enabled: false` leaves the
   old behaviour exactly: that session follows the global setting.

2. **Model**: `enabled`, `profiles[]` (`id`, `name`, `url`), ordered `rules[]`
   (`id`, `kind`, `pattern`, `target`), and `defaultTarget`. A target is
   `direct` or a profile id. `kind` is `host-wildcard`, `url-wildcard`,
   `host-regex`, `url-regex`, or `ip-cidr`.

3. **Match semantics** follow SwitchyOmega's conditions without its code or
   dependencies (that project is GPL; this is an original implementation):
   `*`/`?` globs, `.example.com` treated as `*.example.com`, `*.example.com`
   matching the domain and its subdomains, `**.example.com` subdomains only,
   `|` alternatives, host patterns case-insensitive, `ip-cidr` matching literal
   IP hosts only. First match wins.

   The URL a rule sees is the URL Chromium hands the script, not the one in
   the address bar: for `https` (and `wss`) it keeps only scheme, host, and
   port, dropping the path, query, and userinfo (verified on Electron 43).
   A path or query rule therefore fires over `http` only. The settings preview
   applies the same trimming, so it reports where a request really goes instead
   of promising a match the browser will not make.

4. **Delivery is a PAC data URL.** Electron main compiles the table into
   `FindProxyForURL` and calls `session.setProxy({ mode: "pac_script",
   pacScript })` on the work-browser session. `data:` PAC URLs are fetched
   without a network round trip (verified on Electron 43), so there is no local
   HTTP server, no listening port, and no PAC file on disk. A credentialed
   profile cannot be expressed in a PAC result, so each one gets the loopback
   SOCKS5 relay from ADR 0177 (issue #490) on its own port, and the PAC points
   at `SOCKS5 127.0.0.1:<port>`.

5. **No `global` target.** A PAC script cannot express System mode — the OS
   proxy — so "follow the global setting" would silently become "direct"
   whenever the global mode was System. Silent re-routing is the failure this
   feature exists to prevent, so `defaultTarget` is `direct` or a profile. A
   user who wants the global route as the fallback pastes that URL into a
   profile, and the table then means one thing in every mode.

6. **Loopback and private hosts stay direct** unless a rule targets them.
   The bypass (loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
   single-label hosts) mirrors the default `networkProxy.bypass`: a local model
   server, NAS, or MCP endpoint must not start failing because a proxy is now
   in the path. Rules are evaluated before the bypass, so an explicit rule wins.
   Chromium's `<local>` also covers IPv6 literals (no dot in the name); the
   preview uses the same rule, so an IPv6 address reads as direct unless a rule
   names it.

7. **Lifecycle.** One relay per referenced credentialed profile, reused while
   its upstream URL is unchanged and closed when the profile stops being
   referenced or its URL changes. Applying installs the new PAC on the session
   first and only then closes the relays it replaced, so no request can land on
   a port that just closed. Applies are serialized so overlapping settings
   writes cannot interleave relay ownership. A table that cannot be applied
   (relay start failure) turns routing off — the previous rules are not left in
   force — and the settings write reports the reason to the renderer, which
   shows it: the write landed, the switch did not. Startup paths only log, so a
   proxy problem never blocks launching, and the message has credentials
   scrubbed before it is logged or shown.

8. **Persistence and validation.** Optional key in the existing host settings
   blob; no schema version bump and no migration. host-core validates the table
   (`validate_browser_proxy_routing`) so an unusable one is refused at write
   time; the renderer validates first to point at the offending rule.

## Consequences

- Split traffic works inside the app: intranet through the company proxy,
  everything else through a personal one, local services direct.
- The built-in browser no longer necessarily follows Settings → Network →
  Proxy. The card says so, and the toggle is off by default.
- Model, marketplace, updater, and plugin traffic still have exactly one route,
  so a wrong global proxy still breaks model calls; routing is not a general
  per-service proxy.
- A PAC script is evaluated per request by Chromium; the compiled table is
  bounded (32 proxies, 200 rules) and rebuilt only when settings change.
- PAC results cannot carry credentials, so credentialed profiles cost one
  loopback listener each while referenced.

## Alternatives

- Per-request `webRequest` interception with `onBeforeRequest` redirects: cannot
  change the proxy for a request, only the URL.
- `session.setProxy` + per-host sessions: a Chromium session cannot be chosen
  per URL, and the browser tab owns one session.
- Compile the rules into `proxyRules`/`proxyBypassRules`: fixed-server rules
  have no ordered first-match semantics and no per-rule target.
- A `global` sentinel resolved at compile time: inexpressible in System mode,
  so it would silently send traffic direct (see Decision 5).