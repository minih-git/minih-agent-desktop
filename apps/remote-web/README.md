# @minih-agent/remote-web

Browser ("H5") client for a self-hosted RACP Gateway (ADR 0331, decision D665).

A Vite + React single-page app that talks `RACP-HTTP` + SSE to a Gateway. It is
served from the same origin as the Gateway it uses, which is what lets the
credential stay in an `HttpOnly` cookie and the CSP stay at `connect-src 'self'`.

## Commands

```sh
pnpm --filter @minih-agent/remote-web dev        # Vite dev server + Gateway proxy
pnpm --filter @minih-agent/remote-web build      # production bundle in dist/
pnpm --filter @minih-agent/remote-web typecheck
pnpm --filter @minih-agent/remote-web test       # pure-logic vitest suite (no DOM)
```

## Gateway wiring

* Host-scoped calls live under `/hosts/{hostId}`, so the client base URL is
  `/hosts/{hostId}` and the shared RACP-HTTP route table is used unchanged.
* The device cookie is scoped to `Path=/hosts/{hostId}`, so `GET /v1/hosts` is
  deliberately not used: host status is probed with
  `GET /hosts/{hostId}/v1/sessions` (2xx online, 503 offline, 401 revoked).
* Pairing posts to `POST /v1/hosts/{hostId}/pair` with the pairing token in the
  `Authorization` header and `client: "web"`; the Gateway answers with the
  `HttpOnly` device cookie plus a CSRF token in the body.

### Development

`pnpm dev` proxies `/hosts` and `/v1` to `VITE_GATEWAY_ORIGIN`
(default `http://127.0.0.1:8788`) so the browser still sees one origin:

```sh
VITE_GATEWAY_ORIGIN=https://gateway.example.com pnpm --filter @minih-agent/remote-web dev
```

The Gateway must allow the dev origin (`--allowed-origin http://localhost:5173`),
because every cookie-authenticated request must carry an `Origin`.

Two dev-only notes: Vite injects its stylesheet and the React refresh preamble
inline, which the strict `index.html` CSP blocks; production builds are
unaffected. The Gateway must also serve the built `dist/` from the same origin.

## Security posture

* `index.html` carries a strict CSP: `default-src 'self'`, `script-src 'self'`
  (no inline script), `connect-src 'self'`, no external origin or font.
* The device token lives in an `HttpOnly` cookie; `localStorage` holds only
  `{hostId, label, deviceId, csrfToken, pairedAt}` per host.
* Neither the pairing ticket nor any token is logged, put in a URL, or kept in
  memory after pairing.

## Layout

```
src/lib/            pure logic: ticket parsing, registry, credential port,
                    host client, status probe, reconnect policy, stream
                    supervisor, timeline reducer, command builders
src/hooks/          React glue (session stream, host registry)
src/screens/        pair, hosts, sessions, session timeline
src/components/     shell, timeline rows, approval/input cards, composer
src/locales/        own catalog for the nine shipped locales
```
