# remote-gateway

Self-hosted RACP Gateway (D665 / ADR 0331). It is the public side of the remote
control topology: agent Hosts dial **out** to it over one mutual-TLS WebSocket
(the Host link), and phones, browsers, and the desktop reach their Host through
HTTPS. The Gateway keeps identity records only — never transcripts, provider
keys, or queued turn commands.

```text
phone / browser ──HTTPS(RACP-HTTP + SSE)──▶ Gateway ◀──wss + mTLS── agent-host-cli / desktop
```

## Install and run

A standalone bundle is a single directory with its own Node runtime:

```sh
pnpm --filter @minih-agent/remote-gateway bundle
./apps/remote-gateway/dist-bundle/remote-gateway-<version>-<platform>-<arch>/bin/remote-gateway serve \
  --data-dir /var/lib/minih-remote-gateway \
  --hostlink-listen 10.0.0.5:8787 \
  --client-listen 127.0.0.1:8788 \
  --allowed-origin https://m.example.com
```

`serve` prints one line on stdout once both listeners are bound:

```text
GATEWAY_READY {"version":"0.21.0","hostlink":{...},"client":{...},"caCertificatePath":".../ca/ca.crt","dataDir":"..."}
```

Every other subcommand prints a single JSON line and exits:

| Command | What it does |
|---|---|
| `enroll-code --label <name>` | Print a one-time enrollment code (15 minutes, single use) |
| `hosts list` | List registered Hosts with fingerprints and revocation state |
| `hosts revoke <hostId>` | Revoke a Host and drop its live link |
| `devices list` | List paired devices |
| `devices revoke <deviceId>` | Revoke a device and close its connections |

`serve` must be running for the mutating subcommands: they go through the
owner-only admin socket (`<data-dir>/admin.sock`, mode 0600) and fail with
`gateway is not running` otherwise. The socket stays below the platform limit
(104 bytes on macOS), so keep `--data-dir` short.

### Bind rules

* `--hostlink-listen` accepts loopback, RFC1918, `100.64.0.0/10`, and an IPv6
  unique-local address, plus any CIDR given with `--hostlink-allow-cidr`.
  `0.0.0.0`, `::`, and public addresses refuse to start (security gate 22).
* `--client-listen` binds loopback by default behind a TLS-terminating proxy.
  A non-loopback bind requires `--client-tls-cert` and `--client-tls-key`
  (gate 23).
* On first start the Gateway creates its CA and Host link certificate in
  `ca/`. Add `--public-name <dns>` to put that name in the certificate SAN when
  Hosts dial a DNS name instead of the listen IP.

### Data directory

| Path | Contents |
|---|---|
| `ca/ca.crt`, `ca/ca.key` | Gateway CA; `ca.crt` is what a Host pins |
| `ca/server.crt`, `ca/server.key` | Host link TLS certificate (re-issued when the listen address changes) |
| `hosts.json` | `hostId`, label, certificate PEM + SHA-256 fingerprint, `registeredAt`, `lastSeenAt`, `revokedAt` |
| `enrollments.json` | Enrollment code **hashes** with `expiresAt`, `usedAt`, `hostId` |
| `devices.json` | `deviceId`, `hostId`, label, token **hash**, `createdAt`, `revokedAt` |
| `audit/YYYY-MM-DD.jsonl` | `{ts, op, hostId?, deviceId?, result, ip}` — never a token or content |
| `gateway-secret` | Random 32-byte CSRF HMAC secret |

Directories are `0700` and files `0600`; every JSON write is an atomic rename.

## Connect a Host

1. On the Gateway: `remote-gateway enroll-code --label build-box` and copy the
   printed code.
2. On the Host: copy `ca/ca.crt` from the Gateway, then

   ```sh
   agent-host-cli enroll \
     --gateway wss://10.0.0.5:8787/v1/hostlink \
     --gateway-ca ./ca.crt \
     --code <code> \
     --label build-box
   agent-host-cli --gateway --data-dir ~/.minih-agent-desktop
   ```

   `enroll` generates the Host key pair locally, sends only the CSR, and writes
   `gateway-link.json` (mode 0600). The Host pins the Gateway CA and refuses any
   other chain. `--gateway` keeps the outbound link open with 1 s–60 s jittered
   backoff; local turns continue while it reconnects.
3. `remote-gateway hosts list` shows the Host, its certificate fingerprint, and
   its revocation state.

## Pair a device

The pairing code is minted **on the Host**, never through the Gateway:

```sh
agent-host-cli remote-pair --lifetime-ms 600000   # prints the pairing code
```

The client then calls `POST /v1/hosts/{hostId}/pair` with
`Authorization: Bearer <pairing code>` and `{deviceLabel, client}`. `client` is
`web` (the Gateway answers with `HttpOnly; Secure; SameSite=Strict` cookies plus
a CSRF cookie and no token in the body) or `ios` / `android` (the token is in
the body for the Keychain or the Keystore).

Host-scoped calls live under `/hosts/{hostId}`, so a client sets
`baseUrl = https://<gateway>/hosts/<hostId>` and uses the shared RACP-HTTP route
table unchanged. Event streams are `GET /hosts/{hostId}/v1/sessions/{sessionId}/events`
and `GET /hosts/{hostId}/v1/events`; both honour `Last-Event-ID`.

## Revoke

```sh
remote-gateway devices list                 # find the deviceId
remote-gateway devices revoke dev_xxx       # new requests get 401; open streams end
remote-gateway hosts revoke host_xxx        # the link is dropped and the certificate refused
```

Revocation takes effect immediately (well inside the five-second requirement):
the admin socket updates the in-memory registry and closes every logical
connection the device or Host holds. A revoked Host cannot re-enroll with an old
code; an administrator must clear `revokedAt` in `hosts.json` first.

## systemd

```ini
# /etc/systemd/system/minih-remote-gateway.service
[Unit]
Description=Minih remote gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minih
Group=minih
StateDirectory=minih-remote-gateway
StateDirectoryMode=0700
ExecStart=/opt/minih-remote-gateway/bin/remote-gateway serve \
  --data-dir /var/lib/minih-remote-gateway \
  --hostlink-listen 10.0.0.5:8787 \
  --client-listen 127.0.0.1:8788 \
  --allowed-origin https://m.example.com
Restart=on-failure
RestartSec=3
# The Gateway needs no capabilities beyond reading its own state directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

## Nginx reverse proxy

Serve the H5 client (`apps/remote-web`) and the Gateway API from the **same
origin**: a browser only sends the pairing cookies when the page and the API
share an origin, and the Gateway's `allowedOrigins` must list that public origin
exactly (`--allowed-origin https://gateway.example.com`, repeatable). The SSE
endpoints must not be buffered, and the stream can stay idle for a long time, so
the read timeout has to outlast the 15-second keepalive comment.

### Native apps (Capacitor shells)

The iOS and Android builds of `apps/remote-web` (PR-5) are not served by the
Gateway: the webview loads the bundle from the app itself and calls the Gateway
cross-origin with the header profile (`Authorization: Bearer`). Allow their
origins explicitly, together with the public origin the browser build uses:

```sh
remote-gateway serve \
  ... \
  --allowed-origin https://gateway.example.com \
  --allowed-origin capacitor://localhost \
  --allowed-origin https://localhost
```

`capacitor://localhost` is the only custom scheme the allowlist accepts: it is
the single origin an iOS WKWebView can have for a bundled page. `https://localhost`
is the default `androidScheme` origin of the Android webview. Both are exact
strings — no wildcard, no other scheme — and a native client still needs a valid
bearer token, so allowing them grants nothing to a page without one. The cookie
profile is unaffected: a cross-site `localhost` page never receives the
`SameSite=Strict` device cookie.

```nginx
server {
  listen 443 ssl http2;
  server_name gateway.example.com;

  ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

  # `pnpm --filter @minih-agent/remote-web build` output.
  root /srv/minih-remote-web;
  index index.html;

  location / {
    try_files $uri /index.html;
  }

  # Gateway API: `/v1/...` (host list, pairing) and `/hosts/...` (RACP-HTTP + SSE).
  location ~ ^/(v1|hosts)/ {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;

    # The Gateway enforces its Origin allowlist on these; forward them as sent.
    proxy_set_header Origin $http_origin;
    proxy_set_header Sec-Fetch-Site $http_sec_fetch_site;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Last-Event-ID $http_last_event_id;

    # Server-Sent Events: never buffer, never time out mid-stream.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    # Pass the Gateway's own `X-Accel-Buffering: no` through untouched.
    proxy_pass_header X-Accel-Buffering;
  }
}
```

`--client-listen` stays on loopback: only the proxy is reachable from the
network, and the Host link listener is the one that binds the overlay address.
Because the proxy forwards `Origin` and `Sec-Fetch-Site` unchanged, the Gateway
sees exactly what the browser sent: a same-origin `GET`/`HEAD` may arrive
without `Origin`, and every other cookie request must carry an allowlisted one.

## Host link port

Bind the Host link listener **only** to the private or overlay address Hosts can
reach (for example the EasyTier address). Never publish it on a public
interface: the Gateway authenticates every Host with mutual TLS, but the port
should still be reachable only from the overlay. Wildcard binds refuse to start.

## Security notes

* A credential never travels in a URL or a query string; the Gateway rejects one
  outright (gate 24).
* A cookie-authenticated request proves its `Origin`: an allowlisted one is
  mandatory, except on a same-origin `GET`/`HEAD` marked
  `Sec-Fetch-Site: same-origin` (browsers omit `Origin` there, which is every H5
  read and event stream). A present but disallowed `Origin` is always rejected,
  a mutation is never exempt, and every mutation carries an `x-csrf-token` equal
  to HMAC-SHA256(`gateway-secret`, `deviceId`). CORS never answers `*` (gate 24).
* Both pairing cookies carry `Max-Age=34560000` (400 days, the Chromium cap), so
  closing the browser does not lose the pairing. Revocation is server-side: a
  revoked token answers `401` however long the cookie has left.
* The Gateway caches only token **hashes**; the Host re-authenticates every
  relayed logical connection with its own credential store, so a stolen Gateway
  file cannot mint access (S8).
* The Gateway declares `approvals: false` and `inputRequests: false` on every
  logical connection. When a Host nevertheless raises a server request, the
  Gateway answers `CAPABILITY_UNAVAILABLE` and never decides for the user.
* Audit records are closed-shape: `{ts, op, hostId?, deviceId?, result, ip}`.
