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
| `account-sessions list` | List live account sessions (account mode) |
| `account-sessions revoke <sessionId>` | Revoke an account session |

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

### Client address and account mode (D666)

Two optional pairs turn on the account directory. Without them nothing changes:
the resolved client address is the TCP peer and no account route exists.

* `--trusted-proxy <cidr>` (repeatable) and `--client-ip-header <name>` are one
  setting. Behind a TLS-terminating proxy the peer is the proxy, so the Gateway
  reads the caller address from `--client-ip-header` — but only when the peer is
  inside a `--trusted-proxy` CIDR. Trusting the header from any other peer would
  let a caller claim any address, so a half-configured pair refuses to start.
  `X-Forwarded-For` is read as a chain: the caller is the rightmost entry
  outside the trusted-proxy set, or the leftmost entry when every entry is
  trusted. Any other header carries exactly one address. An unusable header
  falls back to the peer, which is already trusted. A CIDR that would trust
  every peer — a `/0` prefix, the unspecified network, or an IPv4-mapped
  address that could never match — refuses to start instead of silently doing
  nothing.
* `--router-url <loopback URL>` and `--router-client-ip-header <name>` turn
  account mode on. `--router-url` must be loopback: an AccessKey is presented
  once to `GET /api/auth/session` on that URL and must never leave the machine.
  `--router-client-ip-header` must equal the Router's `CLIENT_IP_HEADER`, and
  the Gateway's loopback peer must be in the Router's `TRUSTED_PROXIES`, so a
  key's `allowed_peer_cidrs` is evaluated against the real caller. Account mode
  adds `POST /v1/account/login`, `GET /v1/account/hosts`,
  `POST /v1/account/devices`, and `GET /v1/account/devices/{requestId}`;
  `GET /v1/hosts` and every `/hosts/{hostId}/...` route still accept device
  tokens only. Account mode
  without the trusted-proxy pair logs a startup warning when the client API
  binds loopback: every caller then resolves to the proxy address, so one caller
  can empty the shared credential-attempt bucket and a key whose
  `allowed_peer_cidrs` is set can never verify. A Gateway that serves TLS itself
  on a non-loopback address needs no proxy and gets no warning.
* The Router's own lockout (`429` + `Retry-After` + `AUTH_LOCKED`, sent after too
  many failed authentications from one address) is reported as a retriable
  `RATE_LIMITED` with that delay in a `Retry-After` header, never as an invalid
  key.

### Device requests (D666)

A logged-in account client asks for a device and one Host of the account approves
it; the resulting device token works on every Host of that account.

```sh
# Ask the account's Hosts to approve a device (account session credential).
curl -X POST http://127.0.0.1:8788/v1/account/devices \
  -H "authorization: Bearer rat1...." -H "content-type: application/json" \
  -d '{"deviceLabel":"iPad","client":"ios"}'
# {"result":{"requestId":"dreq_...","expiresAt":"...","hosts":[{"hostId":"...","label":"...","online":true,"canConfirm":true,"willAcceptGrant":true}]}}

# Poll the outcome; `granted` carries the device token once, to this client.
curl http://127.0.0.1:8788/v1/account/devices/dreq_... -H "authorization: Bearer rat1...."
```

* The Gateway sends `device.request` to every online Host of the account that
  advertised `device.confirm`, and answers the caller with the whole roster so it
  learns at once which Hosts cannot confirm (`canConfirm: false`) instead of
  waiting for an answer that cannot come.
* The approving Host signs the grant with its own Host certificate; the Gateway
  verifies that signature against its own CA before relaying anything and never
  signs a grant itself. The raw token is stripped from the relayed grant and is
  never logged, audited, or stored — only its SHA-256 is, in `devices.json`,
  scoped to the account. The signed `deliverUntil` is relayed byte for byte,
  because it is part of the signature; the Gateway bounds its own retention with
  a separate `relayUntil`.
* The token is handed to the client that asked, once, and stays readable for a
  further thirty seconds so a retried HTTP request still succeeds; after that it
  is gone and the status answer says `tokenDelivered: false`.
* A Host that was offline receives the pending grant and any pending revocation
  when it announces its capabilities on a new link, until `relayUntil` (the
  signed deadline or 24 hours, whichever is sooner); re-delivery is idempotent.
  A grant is offered only to a Host that announced
  `device.accept-sibling-grant`, so a strict Host is never sent one it would
  refuse; a revocation goes to every Host that announced a capability frame at
  all, because a Host that adopted the device earlier may have restarted in
  strict mode since. A Host that never announced anything — one that predates
  these frames — is never sent a device frame.
* `device.revoke` propagates a revocation to the account's other Hosts, and
  `remote-gateway devices revoke <deviceId>` still revokes the Gateway's own
  record.
* The per-account Host roster, the request records, and the pending grants never
  cross accounts: a request id of another account, and one of another session of
  the same account, answer the same `NOT_FOUND` as an unknown one. Every
  `/v1/account/*` response carries `Cache-Control: no-store`, and asking for a
  device is rate limited in its own tighter per-IP bucket.

```sh
remote-gateway serve \
  --data-dir /var/lib/minih-remote-gateway \
  --hostlink-listen 11.12.0.1:8787 \
  --hostlink-allow-cidr 11.12.0.0/24 \
  --client-listen 127.0.0.1:8788 \
  --allowed-origin https://gateway.example.com \
  --trusted-proxy 127.0.0.1/32 \
  --client-ip-header X-Forwarded-For \
  --router-url http://127.0.0.1:3001 \
  --router-client-ip-header X-Forwarded-For
```

### Data directory

| Path | Contents |
|---|---|
| `ca/ca.crt`, `ca/ca.key` | Gateway CA; `ca.crt` is what a Host pins |
| `ca/server.crt`, `ca/server.key` | Host link TLS certificate (re-issued when the listen address changes) |
| `hosts.json` | `hostId`, label, certificate PEM + SHA-256 fingerprint, `registeredAt`, `lastSeenAt`, `revokedAt`, `accountId` (account mode only) |
| `enrollments.json` | Enrollment code **hashes** with `expiresAt`, `usedAt`, `hostId` |
| `devices.json` | `deviceId`, `hostId`, label, token **hash**, `createdAt`, `revokedAt`, `accountId` (account-mode devices) |
| `device-grants.json` | Signed grants held for offline Hosts: `grantId`, `requestId`, `accountId`, `signerHostId`, `deviceId`, token **hash**, `roles`, `issuedAt`, the signed `deliverUntil`, the Gateway's own `relayUntil`, signature, signer certificate — never a token |
| `device-revocations.json` | Signed revocations held for offline Hosts: `revokeId`, `accountId`, `signerHostId`, `deviceId`, `revokedAt`, `relayUntil`, signature, signer certificate |
| `account-sessions.json` | `sessionId`, `accountId`, session token **hash**, `createdAt`, `expiresAt`, `revokedAt` — never the AccessKey |
| `audit/YYYY-MM-DD.jsonl` | `{ts, op, hostId?, deviceId?, accountId?, result, ip}` — never a token or content |
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
remote-gateway account-sessions list        # account mode: find the sessionId
remote-gateway account-sessions revoke acc_xxx   # that session's next request gets 401
```

Revocation takes effect immediately (well inside the five-second requirement):
the admin socket updates the in-memory registry and closes every logical
connection the device or Host holds. An account session holds no logical
connection — it authorizes only the account host list — so revoking one closes
nothing and merely stops that session. A revoked Host cannot re-enroll with an
old code; an administrator must clear `revokedAt` in `hosts.json` first.

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
* Audit records are closed-shape: `{ts, op, hostId?, deviceId?, accountId?, result, ip}`.
* Account mode (D666) never persists, logs, audits, or echoes the Router
  AccessKey. A login stores only the SHA-256 hash of the session credential it
  mints, with a twelve-hour bounded lifetime, and re-verifies the key with the
  Router every time — a positive result is never cached. Enrollment records the
  account on the Host and puts `OU=account:<accountId>` in the issued
  certificate's subject DN, next to `CN=<hostId>`.
* A cross-account attempt is refused before anything is routed. Enrollment by a
  key that does not own the `hostId` answers `HOST_ACCOUNT_MISMATCH` (403), which
  names no account; a Host-scoped route carrying an account session answers the
  same `401 UNAUTHORIZED` a nonexistent Host produces, so a caller cannot tell
  whether another account's Host exists.
* A Host registered through the self-hosted flow is not taken over by an
  AccessKey alone: an account-mode enrollment of an existing unowned `hostId`
  must certify the key that Host's current certificate certifies, so learning a
  `hostId` never lets a key move another user's Host into its own account. The
  operator's recovery for a Host that must change its key is to revoke it and
  clear its record in `hosts.json`.
* Credential attempts are rate-limited per resolved client IP, and account login
  and enrollment by key share that one bucket, so guessing a key cannot spend
  the command budget and cannot be multiplied by spreading guesses across
  accounts.
