# 04. Plugin Security

## 1. Threat model

Plugins may come from:
- The user's own development
- Shared by colleagues
- Third parties in a future marketplace

Main risks:
1. Malicious file read/write
2. Malicious command execution
3. Stealing API keys / session content
4. Hijacking agent tools
5. Phishing via the UI
6. Spending the user's model quota, or sending the conversation to another model (`agent.complete` / `session.read`)
7. Triggering work in another durable session or spoofing its sender/provenance

## 2. Default-deny principle

- Undeclared permission = unavailable
- Disabled plugin = code not loaded
- Unconfirmed high-risk action = not executed
- Host API not on the allowlist = does not exist
- `pi.browser.cdp` methods not on the CDP allowlist = `PERMISSION_DENIED` (no
  cookies, storage, Target, or Fetch; no DevTools websocket)

## 3. Isolation strategy

### Must
1. Plugin UI is isolated from the host UI DOM
2. Plugins cannot directly require host modules
3. The secret store is not open to general plugin APIs. Host-owned completions
   (`agent.complete`) resolve credentials in Electron main and never pass keys,
   refresh tokens, or `ModelAuth` to the plugin process. The high-risk
   `provider.oauth` callback is the narrow exception: it can read only the
   encrypted OAuth credential for its own declared provider contribution
4. The plugin-private data directory is separate from the host core library
5. Session transcripts from `session.getLlmContext` are a bounded projection of
   the in-flight tool session only (D336 / D019)
6. Session collaboration is available only through the reviewed
   `desktop.control` catalog. The broker derives the source plugin, Session ID,
   turn ID, and invocation ID from the active Agent tool call; plugin payloads
   cannot provide those identities. Host-core owns the target Session ID,
   delivery ledger, permission ceiling, turn binding, callback, cancellation,
   and transcript provenance.

### Host-rendered scenic Settings destinations

`contributes.scenicThemes` is data only. The host validates both grants,
same-plugin theme ownership, declared preview assets, and the exact bounded
`--nexus-backdrop-blur` variable before it renders cards in Extensions. A plugin
cannot supply Settings HTML, CSS, JavaScript, selectors, DOM, arbitrary actions,
or direct renderer IPC. The host owns the transparent canvas, layout, focus,
native controls, titlebar, Apply action, and lifecycle fallback to General.

Clipboard history is host-owned and remains in the Electron main process only.
It is never written to the plugin data directory or the host database. The host
records explicit clipboard writes and user-initiated Composer paste events; it
does not poll the OS clipboard in the background. A plugin can read history only
through `clipboard.read`, which is also the permission used by `readText`;
every `getHistory` call is audited with its returned entry count. The bounded
in-memory retention limits the privacy exposure to the current app run and is
cleared on exit.

### 3.2 Session collaboration boundary

The Session Orchestrator may create bounded worker sessions, address existing
Agent sessions, inspect bounded status/result projections, and cancel work when
the user grants `desktop.control`. This capability deliberately does not grant
the plugin direct `session.create`, `agent.prompt`, host RPC, SQLite, transcript
file, or MCP-token access. A send or spawn call must run inside the plugin's
currently executing Agent tool invocation; calls from a service, panel, or
ordinary plugin code without that context fail closed. A plugin panel may
request cancellation for that plugin's own deliveries as an explicit user
control, but cancellation cannot create or retarget a delivery.

Host-core snapshots the source permission ceiling and rejects targets above it,
rechecks the target mode before beginning the turn, and enforces inbox,
worker, and autonomous-hop limits. Existing target sessions retain their own
project/model/context configuration. Completion callbacks are host-authored,
at-most-once session messages and cannot authorize tools or trigger another
callback. Restart recovery retains a durable queued delivery but never starts
an interrupted turn unattended. Session-message provenance is immutable across
transcript replacement and regeneration.

### Goals
1. Plugin main runs in a separate process
2. Crash isolation
3. Resource limits (later: CPU/memory/timeout)

## 3.1 Contributed theme CSS

A theme contribution (`ui.theme`) is the one case where plugin-authored content
runs inside the host renderer, so it crosses a sanitizer in the main process
before it is ever sent to the UI:

- Only CSS the browser applies is inspected: comment bodies and string literals
  are blanked first, with one space per masked character so any offset still
  points at the source, and each `url(...)` argument is kept verbatim and judged
  by its target. A sheet that merely *mentions* a banned token in a comment or a
  string is therefore accepted
- Rejected: `@import`, any `url()` target that is neither a `data:` URI nor a
  declared theme asset, a `url(` the parser cannot resolve, `javascript:`,
  `expression(`, and markup sequences (`<style`, `</style`, `<!--`); an empty
  sheet is refused too
- Capped at 256KB per file, 8 themes per plugin
- A theme may declare `assets` using whitelisted image/font extensions: either
  package-relative paths (resolved inside the plugin root; traversal and `node_modules`
  references are rejected) or absolute paths. The total is capped at 4MB.
  Each matching `url()` is rewritten to `plugin-asset://<pluginId>/<path>`
  and served read-only through the loaded plugin's registered list with `nosniff`;
  the registration is revoked when the plugin unloads. `pi.themes.upsert` may
  register the same kind of path at runtime. An unregistered reference is refused,
  and the raw path never reaches the renderer
- A loaded plugin's `manifest.icon` may also be displayed through this scheme.
  The icon-specific path accepts only package-contained PNG, JPEG, WebP or
  AVIF files up to 256 KiB, with a raster signature check; invalid or unloaded
  icons fall back to a host icon. If the same path is already a registered
  theme asset, the existing theme-asset rules continue to apply.
- `contributes.windowAppearance` (`#rrggbb` / `#rrggbbaa` background and an
  integer `cornerRadius` of 0..24 DIP) requires
  `ui.window.appearance` and applies only while one of that plugin's themes is
  the selected one; leaving the theme restores the host background, because the
  appearance is derived from the live catalog rather than remembered. macOS
  keeps `vibrancy` and its native corner behavior; Linux retains native corner
  behavior. Windows defaults to a 12 DIP corner request. On Windows 11 (build
  22000+), radius 0 requests square corners and positive values use the same
  system-rounded preference, while the OS chooses the actual radius; alpha
  backgrounds are composited over the resolved built-in theme color to keep the
  top-level window opaque. Earlier Windows builds retain the requested DIP
  radius
- The CSS is read from disk at load time and delivered whole over IPC; the
  renderer injects it into a single dedicated `<style>` element appended after
  the app's own stylesheets, so it can override tokens but never inject markup.
  Later source order wins only at equal selector specificity: use
  `:root[data-theme="light"]` or `:root[data-theme="dark"]` to match the base
  palette's selector; bare `:root` has lower specificity
- Selecting a theme is a settings value (`plugin:<pluginId>:<themeId>`); if the
  providing plugin is disabled or uninstalled the setting falls back to `system`

CSS cannot script, but it can mislead: a theme is still third-party code shaping
what the user sees, which is why it is a declared, revocable permission.

## 4. Permission-grant UX

At install/load time, show:

- Permission list
- Risk description
- Developer info
- Source path

User actions:
- Accept and enable
- Cancel

First use of a high-risk API may re-confirm.

### 4.1 Declared execution trust

A plugin's entry code runs Node inside the plugin host process; that is not an
OS sandbox, so it can already start local processes with the user's privileges.
No permission name changes that, and none is required to try.

The development-folder review — the host-controlled path a locally built plugin
goes through — therefore renders the manifest's own `safetyNotes` (from the
`i18n` block, resolved for the active locale) beside the permission list, above
the accept action. It is authored copy, not a host verdict: the review presents
it as the plugin's statement and never treats an absent note as evidence of
limited access. A plugin that runs local commands, opens local sockets, or keeps
background work is expected to say so there. The host adds no per-feature "may
run commands" grant, because a label with no enforcement point behind it would
imply a boundary that does not exist. A marketplace install review keeps the
catalog's own `safetyNotes`, which the plugin detail sheet already shows before
install.

This is informed consent for surfaces such as a terminal plugin (ADR
optional-terminal-plugin), not a claim that the plugin is sandboxed.

## 5. Data isolation

Plugins can access:
- Their own settings
- Their own data path

Plugins cannot access:
- Other plugins' data
- Host secrets through a general-purpose API; `provider.oauth` grants access
  only to the callback's own declared provider credential
- The host's full session database (unless a controlled API exists in the future)

## 5.1 Inter-plugin message bus

The bus is the only channel between two plugins, and it is deliberately narrow:

- Both sides declare their traffic in the manifest — `bus.publish` lists concrete
  topics, `bus.subscribe` lists patterns — and the broker refuses anything
  undeclared even when the permission is granted
- Routing lives entirely in the host; a subscriber never learns who else
  subscribes, and a publisher is excluded from its own fan-out
- A message carries only `topic`, `from`, `payload`, and a host-assigned `at`
- Caps: 64KB per payload, 16 subscriptions per plugin, 100 publishes per rolling
  10s window; over-cap calls fail with `LIMIT_EXCEEDED` / `RATE_LIMITED` and are
  audited alongside the topic
- A payload is data, not capability: receiving a message grants nothing the
  subscriber did not already have

Treat a topic as public within the app: any plugin that can declare a matching
pattern and hold `bus.subscribe` will see it. Do not put secrets on the bus.

### Provider OAuth credential boundary

`provider.oauth` is a separate high-risk grant from `provider.register` and
`net.fetch`. It lets `onProviderOAuth` handle login and refresh for a provider
declared by the same plugin. The host encrypts each credential in its secret
store and never sends the refresh token to the renderer or Agent Runtime. The
plugin callback can read that credential because it implements the provider's
OAuth protocol; it cannot read another provider's secret or call a general
secret API. Requests made through the host network API still require
`net.fetch` and `manifest.net.domains`. Plugin entry code is not an OS sandbox
and can use raw Node APIs, so a plugin with this grant must be code the user
trusts. The callback receives an abort signal when login is cancelled, the
plugin unloads, or the host call times out. Sign out clears the credential and
leaves the manifest-owned provider row in place.

The Add Service provider catalog is also Host-rendered. It reads only the
manifest metadata of loaded plugins with `provider.register`, includes only
unconfigured API-key providers with an endpoint, and renders the category and
provider name as text. An optional description is plain tooltip text on hover
or keyboard focus. The chooser does not execute plugin code or return
credentials. Saving a key stores it through the Host's existing provider
secret path; the Host discovers endpoint models after that explicit save, and
the provider service receives the key when the user sends a request through
the provider.

## 6. Path safety

`fs.read` / `fs.write` / `fs.delete` say whether a plugin may touch files;
`manifest.fs` says which ones (see
[02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §5.2 and ADR 0088).
Every `pi.fs.*` call passes four gates in a fixed order, and a later gate can
only refuse:

1. **Permission** — declared *and* granted. The runtime uses the intersection, so
   a permission the user revoked stops working even though the manifest still
   asks for it
2. **Containment** — `realpath` on both the root and the target, so a symlink
   inside the workspace pointing at `~/.ssh` fails here rather than passing a
   string comparison. A path being created resolves through its nearest existing
   ancestor, so a new file is not indistinguishable from an escape. Absolute
   paths and `..` are refused; a path that merely does not exist is reported
   `NOT_FOUND`, not as an escape
3. **Deny-list**, which overrides every root, scope, and grant:
   - credentials: `.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`,
     `id_rsa*` and friends, `*.pem`, `*.p12`, `*.pfx`, `*.keystore`
   - directories, at any depth: `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`,
     `.docker`
   - the host's own data directory, which holds provider keys and the session
     store
   - the root itself, for a delete
4. **Declared scope**, else a native confirmation (§6.2)

`pi.fs.glob` answers to the same rules — a name is a read, so denied paths and
reserved trees are omitted from the results, matches are filtered by the read
scope, and `node_modules` / `.git` / `.venv` / `__pycache__` are never walked.

### 6.1 Deletion

Deletion is the only file operation the user cannot recover by re-running the
plugin, so it is bounded four ways:

- **Two tiers.** With `own: true` the host keeps a write ledger (path plus mtime)
  in the plugin's data directory and lets the plugin remove what it wrote itself,
  no scope and no prompt. If the file's mtime has moved past the recorded one,
  the user has edited it since and it is no longer the plugin's. Deleting
  anything else needs a declared `scope`.
- **The OS trash.** Removal goes through `shell.trashItem`, never `rm`, so a gate
  that got it wrong costs the user a restore rather than the file. The host
  copies none of the user's data to provide this.
- **Never recursive.** A non-empty directory is refused rather than emptied.
- **A rate brake.** 50 removals per rolling 60s per plugin, because
  `recursive: false` bounds one call and not a `glob` followed by a loop. Past
  the brake the user is asked once, with the reason given as rate rather than
  path.

### 6.2 Runtime consent

An access the manifest does not cover reaches a native `dialog.showMessageBox`:
**Deny** / **Allow once** / **Allow this session**. A session grant covers the
containing directory, is held in memory, and dies with the process; nothing is
persisted, and a rate-brake prompt is offered no session option at all. A host
with no consent service refuses — a host that cannot ask must never assume yes.
Both the denial and the grant are audited.

### 6.3 The user-selected root

`pi.fs.requestDirectory()` opens the native directory picker; inside the returned
directory the plugin needs no manifest scope, because the user just pointed at
it. Containment and the deny-list still apply there. The handle is memory-only
and dies with the process, so the plugin holds unlimited reach and zero standing
power — the model the browser's File System Access API uses.

### 6.4 Dropped-file grants

A sandboxed plugin panel may resolve a user-dropped `File` to a local path through
the host preload's `getDroppedFilePath`. The preload reports that path to the
panel host before page code runs. `fs.registerDropped(path)` consumes one of
those short-lived, sender-bound reports and returns a memory-only `grantId`.
The grant covers exactly that one canonical regular file for `fs.stat` and
`fs.readRange`; it does not change `manifest.fs`, grant a directory, or permit
writes, opens, reveals, or deletes. The grant dies with the plugin process and is
never persisted. Protected paths, credentials, symlink replacement, and the
deny-list remain enforced on registration and every subsequent read.

## 7. Agent security

- Plugin tool names are namespaced to avoid collisions using the frozen forced prefix `plugin_<pluginIdSafe>_<toolName>` (D015)
- tool execution timeout
- tools can be disabled by the user in one click
- the prompt-injection API is high-risk by default and requires an explicit permission

## 7.1 Skills and MCP tools reaching the agent

Both surfaces let a plugin change what the agent knows or can do, so both are
bounded before they reach the model:

**Skills** (`agent.prompt.inject`) — the system prompt carries only the catalog
(id, name, one-line description, capped at 240 chars); a body is read on demand
through the built-in `Skill` tool. A plugin may teach at most 32 skills, each
document at most 128KB. Without the permission the skills are simply skipped:
the manifest still validates, nothing reaches the prompt.

**MCP tools** (`mcp.server.local` / `mcp.server.remote`) — discovered tools are
registered under the same `plugin_*` namespace as hand-written plugin tools and
therefore inherit the tool timeout, the audit trail, and the per-plugin disable
switch. They are always registered at `risk: "medium"`: their schema and
description come from a third-party server, so the host cannot trust a
self-declared risk level. A server's catalog is registered whole — the count is
bounded only by the protocol guards in §8.1 — while at most 8 servers per plugin
are admitted.

Plan is an additional host policy boundary for agent tools:

- no plugin tool is visible or executable in Plan;
- the deny precedes manifest risk, declared/granted permissions, session
  grants, and the `auto` permission mode;
- a direct forged `tools.execute` call returns `PLUGIN_DISABLED_IN_PLAN` and is
  audited; it is not forwarded to the plugin runtime;
- plugin commands and panels may remain usable as explicit user UI actions,
  but they cannot become model-callable Plan tools or silently mutate Plan
  state.

## 8. Network and external links

- `net.fetch` is not granted by default
- `openExternal` should confirm. The host parses the URL and opens only
  `http:`, `https:`, and `mailto:` (D330 / ADR 0168); other schemes fail with
  `INVALID_ARGUMENT` and never reach `shell.openExternal`. `fs.openDefault` and
  `fs.reveal` are separate: each accepts only an existing root-relative file
  that already passes the plugin's `fs.read` policy. They are intended for
  explicit file-view actions, not arbitrary URL or absolute-path opening;
  `fs.reveal` only asks the OS file manager to select the file.
- Plugins are forbidden from silently downloading and executing binaries (not done at all in MVP)

### 8.0 Egress allowlist

A permission cannot express "read broadly but leak nothing", so the range lives
in the manifest: `net.domains` is a single per-plugin hostname allowlist and every
outbound path the host owns answers to it.

- **Panel sessions.** `sandbox: true` removes Node, not the network, so a panel
  was previously a full browser that never consulted `net.fetch`. The session now
  runs a `webRequest` filter, refuses every device permission, and denies
  `window.open`, which would otherwise mint a window outside the filtered session
- **`pi.net.fetch`.** Checks the allowlist and follows redirects by hand, because
  an allowed host that 30x-es to an undeclared one would carry the request out.
  The host's shared hop loop owns both default and injected single-hop
  transports. `redirect: "error"` rejects 3xx without visiting the target;
  `manual` returns the original response. The default remains `follow`, with
  the per-hop re-check. See the [API contract](03-plugin-api.md#net) for
  capability detection and error codes.
- **Remote MCP endpoints.** Answer to the same list, not to their permission alone.
  HTTP endpoints may be on a trusted LAN, but plain HTTP is unencrypted and is
  called out during configuration or plugin permission review. The MCP client
  follows redirects manually, allows at most five HTTP(S) hops, and re-checks
  the allowlist before every hop.
- **`pi.net.websocket`.** A `ws://` or `wss://` target whose host is not in
  `manifest.net.domains` is refused at the egress chokepoint before the
  transport is asked to open anything, and the host — which owns the socket,
  not the plugin — closes every socket the plugin still holds when it unloads,
  is disabled, or crashes. Sockets are bounded per plugin (4), inbound and
  outbound frames are capped at 1 MiB, an oversized frame closes the connection
  instead of being buffered, and a send queue above 4 MiB is refused rather
  than grown. Frames are addressed to the owning plugin only.

An absent, empty, or malformed list means no egress at all, and a bare `*` is
refused at install so nobody declares their way out. This is what makes a
generous `fs.read` scope affordable (§6).

Still open, tracked separately: `agent.prompt.inject` (skill text can ask a
shell-capable agent to do the carrying), `shell.openExternal`, a `bus.publish`
relayed to a net-capable plugin, and raw `fetch` inside the plugin process — the
last one needs the sandboxed plugin runtime from ADR 0008 D009. `pi.net.fetch`
narrows none of that: the host applies the allowlist, follows redirects by hand,
and audits the call, but it never retries, throttles, or re-issues a request. An
upstream `429` reaches the plugin as `429` plus whatever `Retry-After` the server
sent, and what the plugin does about it is the plugin's own policy.

## 8.1 MCP server egress and credentials

An MCP server is a second egress path next to `net.fetch`, so it is declarative
and reviewable rather than programmatic — a plugin cannot open a connection the
manifest did not name:

- `transport: "stdio"` spawns a local executable (`mcp.server.local`). The
  `command` must be a bare PATH name or a plugin-relative path; absolute paths
  are refused at validation time. The child gets a minimal environment — the
  declared `env` entries plus the shared allowlist (`child-process-env.ts`)
  and the extra profile/toolchain keys `npx`/`uvx` need (`PATHEXT`, `ComSpec`,
  `FNM_DIR`, …). Unix PATH is the login-shell PATH (D600). Bare `npx`/`uvx`
  resolve to real binaries; official Windows Node uses `node.exe` +
  `npx-cli.js`, and remaining `.cmd` shims start through `cmd.exe` with quoted
  literal args (D624). Provider keys and other host state still never cross.
- `transport: "http"` reaches a remote endpoint (`mcp.server.remote`). The `url`
  may use `http` or `https`; non-loopback HTTP is unencrypted and should only be
  used on a trusted network. Plugin endpoints must also be covered by
  `manifest.net.domains`. Tool arguments leave the machine, which is why the
  permission copy says so plainly.
- `env` and `headers` values resolve **only** from the plugin's own settings via
  `{ "setting": "<key>" }`. The host environment is never passed through, and a
  literal secret in the manifest is a review smell, not a supported pattern
  (D018).
- Connection budget: 10s to complete `initialize`, 100s per `tools/call`, 4MB
  per stdio line. Remote HTTP requests use the budget of the operation they
  carry, so a successful handshake does not impose its 10s limit on a later
  tool call. `tools/list` is followed to its last page under the per-server
  guards of §8.1 — 2048 tools, 100 pages, a cursor that repeats or is malformed,
  and 30s for the whole traversal — and a server that breaks one is refused
  rather than contributing a prefix of its catalog, because MCP tools reach the
  deferred on-demand entries behind `ToolSearch`, not as an always-present list.
  Servers are connected lazily and torn down when the plugin unloads or is
  disabled.
  Stopping the calling session cancels that session's in-flight MCP request and
  sends `notifications/cancelled` to the server. A shared server connection and
  calls owned by other sessions remain active. A request that times out is
  cancelled the same way; `initialize` is never cancelled.

## 8.2 Desktop control and device access

`desktop.control` hands a plugin the reviewed operation catalog the local MCP
control plane exposes (ADR 0203 / D370): project, session, Agent, and
workspace operations, each tagged `read`, `write`, or `dangerous`. The
plugin-only exception covers the six `session/collaboration/*` operations: they
are callable through the plugin gateway but deliberately absent from the
MCP-visible catalog, because they need an authenticated plugin invocation
context and no renderer mutation channel exists for them. The plugin sees ids,
descriptions, and risk, never Electron channel names or the MCP bearer token,
and every invocation crosses the same IPC validation, lifecycle checks,
completion event, and audit entry as an MCP call.

A `dangerous` operation is decided by the user, not by the caller. The
controller's `confirm: true` is only the plugin's acknowledgement (MCP treats
it the same way, D372). After it, the host shows a native dialog that names
the catalog operation id, the catalog description, and a bounded argument
preview, and it deliberately shows no text the plugin or a model behind it
authored, so a prompt-injected transcript cannot relabel `session/delete` as
something benign. Escape and dismissal are refusals. A headless host with no
dialog service refuses every dangerous operation outright.

`ui.microphone` allows only the `media` permission, for audio, inside the
plugin's isolated panel session. Camera and every other device permission stay
denied, and the plugin receives no native handle: capture stays page-owned.

`audio.capture.background` and `audio.playback.background` gate a callable
surface: the ten `pi.audio.*` methods exist in the plugin host process and keep
their permission requirement, but this branch has no device backend, so an
authorized call is refused with a coded `UNSUPPORTED` refusal that is audited
under `audio.<method>` with `ok: false`, and no device is opened (the two
synchronous registration helpers `onInputFrame` / `offInputFrame` throw the
same code instead of registering a handler that could never fire). When the
host service lands, the host owns the device: a plugin exchanges PCM16 frames
and never receives a `MediaStream`, a device handle, an OS device path, or a
Node stream, one input stream per plugin is allowed, and disable, unload,
crash, or permission revocation stops capture and drops queued playback
instead of leaving an orphaned device or timer.

`keyboard.globalShortcut` is implemented and stays inside the host's
registration model. The host owns Electron's `globalShortcut`; a plugin never
receives a keyboard hook, `before-input-event`, raw input device, or key event
stream, so there is no keylogger-shaped surface and no way to see the keys the
user types. A plugin may only map an accelerator to one of its own registered
commands, and an accelerator the OS reserves, that Minih-Agent-Desktop itself currently
spends (the plugin-launcher and window-toggle bindings, `Alt+Space` and
`Alt+Shift+W` by default; a user rebinding one frees it for plugins), or that
another plugin holds is refused with
`LIMIT_EXCEEDED` (at most 8 per plugin) instead of being taken over. A trigger
runs exactly that one command. Register, unregister, and trigger are audited
with the plugin id and the result — a registration and a trigger also name the
accelerator and command — and typed input is never recorded. Every entry is
released on disable, unload, and crash.

Across all four capabilities, an undeclared or ungranted permission denies the
call and is audited before any device, accelerator, or socket is reached.

## 8.3 Raw TCP, inbound webhooks, and host-held resources

Six host capabilities ([ADR plugin-host-capabilities](../../adr/plugin-host-capabilities.md))
move a resource out of the plugin process and into the host: a credential, a
socket, a listening path, a clock, a host-owned list entry, a task. The
security property is the same in all six — **the plugin names what it wants and
receives events; the host holds the secret, the socket, the port and the
clock.** Registered in this change; the enforcement below is the contract the
implementation answers to, and §11 records what exists today.

**`net.tcp` — host-owned raw sockets.** `manifest.net.tcp` is a list of literal
`{ host, port, tls }` endpoints. A wildcard, a port range, a bare `*`, a
duplicate `host:port`, or a missing `tls` fails manifest validation, so the
allowlist can never be widened after review and the host never decides for the
author whether a connection is encrypted.

- `pi.net.tcp.connect` matches the requested endpoint against that list after
  the manifest's own normalization; anything else is `PERMISSION_DENIED` before
  a socket exists.
- **At most four connections open at once per plugin.** This is a concurrency
  ceiling that bounds the host's descriptors and buffers; it is deliberately
  *not* a cap on the allowlist, which stays unbounded so an author with ten
  servers declares ten instead of reaching for Node's own `net` module.
- The plugin gets a `connectionId` and events, never a socket, a stream, a TLS
  session, or a certificate handle. `tls` comes from the manifest, and the host
  performs the handshake itself, so there is no API to downgrade a connection
  or to skip verification.
- Every connection closes on unload, disable, and crash; `connect` and `close`
  are audited with the endpoint and the outcome, never with payload bytes.
- The user's outbound HTTP proxy is not consulted for raw sockets. The install
  review says so, because an author expecting proxy enforcement would otherwise
  assume it.

**`inbound.webhook` — a host-owned listener.**

- A receiver is registered only when its host-generated token exists. It is
  stored in the secret store, compared in constant time, and never returned by
  plugin APIs or events. Main-window IPC opens a native system dialog and
  returns no token; only an explicit action inside that dialog reveals, copies
  or rotates it. Rotation invalidates the old token immediately. Native plugin
  entry code is not an OS sandbox (ADR 0008 D009).
- LAN mode binds `0.0.0.0` and, when available, `::`; local-only mode binds
  `127.0.0.1`. Before reading the body, the host admits loopback, RFC1918,
  CGNAT, link-local, ULA, and direct interface subnets no broader than IPv4
  /16 or IPv6 /48. Others receive `403`. This is not a guarantee against
  internet exposure: a directly connected public subnet can match. See
  [ADR plugin-webhook-listener-boundary](../../adr/plugin-webhook-listener-boundary.md).
- Transport is plain HTTP; install and Settings warn that tokens and request
  contents can be intercepted, consistent with ADR 0142. A token is a filter,
  not confidentiality.
- Bodies over 256 KiB are refused while streaming with `413`; requests past
  120 accepted per minute receive `429`. The manifest may lower either limit.
- Accepted requests become one-way plugin events after durable storage. The
  host returns `202`; the plugin cannot control the response. At most 64
  lowercased headers are retained, each truncated to 4096 characters, and the
  authentication header is removed before storage. The host-named sidecar in
  `plugin_webhook_events.body_ref` contains method, headers and UTF-8 body;
  `source_ip` remains metadata. Unconfirmed events replay at least once, and
  rows and files are removed after seven days or on uninstall.

**`credentials.use` — host-mediated use, not a sandbox.**

- The user fills the slot in Settings. The host has no plugin credential read
  API and does not deliberately return stored values in host-generated messages,
  errors or audit records. Values stay in the existing encrypted secret store,
  never in SQLite; its at-rest design is unchanged.
- Injection happens only on a host-owned egress call naming the slot by
  `credentialRef`, and only when the target is inside both the slot's `scope`
  and `manifest.net.domains`. Calls outside that intersection are refused rather
  than sent unauthenticated.
- Credentials injected into `http://` or `ws://` destinations travel unencrypted
  along the network path; the audit records the destination scheme without the
  credential. Users should prefer HTTPS or WSS where available.
- This is a reviewable, revocable API boundary, not a defence against malicious
  plugins. Plugin entry code has native Node access and is not an OS sandbox;
  install only trusted plugins. A remote service can echo a credential in an
  HTTP response body or WebSocket frame, which the host does not filter.

**`scheduler` — the host owns the clock.** A declared timer is either an
interval of at least one minute or a five-field cron expression, never both. It
does not fire while the plugin is disabled or unloaded, a backlog collapses into
one fire instead of a catch-up storm, and consecutive failures pause the timer
after a bounded number of attempts (`plugin_schedules.paused`) instead of
retrying forever; the pause and its state survive a restart and surface on the
Plugins page. A tick runs plugin code with no model turn and no quota spend.
An idle timer waits for 60 seconds of system idle time. The handler deadline is
five minutes; an exception or timeout counts as one failure and a late answer is
ignored. Five consecutive failures pause the timer; the user may resume it or
reload the plugin, clearing the failure count. Restarting the app alone does not
clear a pause. The first `every` attempt is immediately due; the first cron
attempt waits for its next local-time match. `last_run_at` is written at the
start of an actual attempt, not at registration.

**`mail.draft` and `notify.center` — writing into a host-owned list.** Neither
sends anything: `mail.draft` has no send path, and `notify.center` writes one
inbox row of the `plugin.%` family (`plugin.alert` for one event, `plugin.digest`
for a rolled-up batch) that the user can read, clear, and delete with the
plugin. The inbox keeps its 200-row cap, so a plugin cannot use it as unbounded
storage, and a plugin uninstall removes its rows. Both calls are rate-braked
like every other host queue.
For `notify.center`, each plugin may create at most 60 ordinary rows in a
rolling hour; updates of an existing dedupe key do not consume this budget.
Further new events are counted in one `plugin.digest` row using the reserved
key `__minih_notify_overflow__`. The host records creation timestamps in its
audit log so clearing the inbox or restarting cannot reset the budget.

**`tasks.read` and `tasks.manage` — a narrower employee.** `tasks.read` is a
read-only roster projection. `tasks.manage` creates and drives only tasks this
plugin created, and the new task runs at
`min(manifest.tasks.manage.maxPermission, the employee's own mode)`. `auto` is
never implied: when a manifest declares it, the install review asks for it
separately from the permission list, because it removes the user's own approval
step from work they did not type. A lookup for a task the plugin does not own
answers `NOT_FOUND`, so the API cannot be used to enumerate other employees'
work.

## 9. Auditing and emergency response

Users should be able to:
- View plugin permissions
- View plugin error logs
- Disable in one click
- Uninstall in one click

The host should be able to:
- Auto-disable a plugin on anomaly
- Guarantee the main app can start

## 10. Security acceptance

1. Writing a file fails without the `fs.write` permission, and a write outside
   `manifest.fs.write.scope` prompts the user
2. Deleting a file fails without the `fs.delete` permission, never recurses, lands
   in the OS trash, and is interrupted past 50 removals in a rolling minute
3. After disabling a plugin, its tools are no longer visible
4. A plugin cannot read API keys
5. A plugin panel cannot call arbitrary host IPC
6. An uncaught exception from a plugin does not cause the app to exit
7. A theme CSS file with `@import` or a remote `url()` is refused, and disabling
   the providing plugin drops the app back to the `system` theme
8. Publishing to an undeclared topic fails, and a publisher never receives its
   own message
9. An MCP server declared with an absolute `command` fails manifest validation;
   a non-loopback plain-HTTP URL is accepted only when its host is declared in
   `manifest.net.domains` and the UI shows the unencrypted-connection warning
10. A low-risk or granted plugin tool still fails closed in Plan
10. A low-risk or granted plugin tool still fails closed in Plan
11. A `net.tcp` endpoint with a wildcard host, a port range, or no `tls` fails
    manifest validation; the fifth simultaneous connection is refused and every
    connection closes when the plugin unloads
12. A webhook receiver without a token is not registered, a body above 256 KiB
    is answered `413`, and the plugin cannot set the response status
13. No API and no error message returns a credential value, and an injection
    outside the slot's `scope` or `manifest.net.domains` is refused
14. A timer does not fire while its plugin is disabled, and a `tasks.manage`
    task never runs above the employee's own permission mode

## 11. Implementation status

Current enforcement:

1. Default-deny permission checks in `PluginRuntime`, over the intersection of
   declared and granted, so a revoked permission actually stops working
2. Symlink-safe containment plus an unconditional deny-list for plugin fs APIs,
   with the reach of each file mode bounded by `manifest.fs` and anything outside
   it falling to a native confirmation (§6)
3. Panel windows use sandboxed preload + isolated session partitions. Their
   custom cross-platform titlebar is preload-owned, keeps its controls in a
   closed Shadow DOM, and routes only a fixed sender-validated window-action
   tuple without adding window primitives to `window.pluginBridge`
4. Secrets / host DB remain inaccessible to plugins
5. Marketplace/package install requires explicit permission acceptance in UI
6. Auto-update refuses silent permission expansion
7. Plugin main runs in a dedicated `utilityProcess` per plugin (ADR 0008) with a
   minimal environment from the shared `child-process-env.ts` allowlist (PATH,
   toolchain dirs, `HOME` / `USER` / `USERPROFILE`; no provider keys); all
   `pi.*` calls cross an allowlist + permission gateway in the host, and a
   plugin crash only tears down that plugin
8. Contributed theme CSS is sanitized in the main process before it reaches the
   renderer (§3.1)
9. Bus routing is host-owned with declared topics and hard caps (§5.1)
10. MCP servers are declared, permission-gated, and fed credentials only from
    plugin settings (§8.1)
11. Egress is confined to `manifest.net.domains` at every chokepoint the host
    owns (§8.0)
12. Plugin deletions go to the OS trash, are non-recursive, and are rate-braked
    (§6.1)
13. `manifest.main` and `ui.panel` are validated as relative paths at install
    and resolved with the same inside-the-plugin containment as skills and
    theme CSS before the host loads them
14. A `dangerous` desktop operation from a plugin needs the user's answer to a
    host-owned native dialog after the plugin's own `confirm: true`; the
    dialog shows only catalog text (§8.2)
15. `ui.microphone` grants audio capture only, inside the isolated panel
    session (§8.2)
16. `keyboard.globalShortcut` is host-owned: the registry refuses an
    OS-reserved, host-owned, or other-plugin accelerator, a shortcut can only
    run the owning plugin's own command, and every entry dies on the same
    teardown path as the plugin's commands and tools (§8.2)

`audio.capture.background` and `audio.playback.background` are declared and
present in the plugin API: the methods are gated by those permissions and an
authorized call is refused with a coded `UNSUPPORTED` refusal that is audited,
because this host has no device backend yet, so nothing reaches a device.
`net.websocket` is implemented: connections are host-owned, allowlist-checked,
bounded, and released with the plugin (§8.1).
`notify.center` is implemented with its own permission gate and durable inbox.
`inbound.webhook` is implemented with a host-owned listener and durable
delivery. `scheduler` is implemented by the host-owned clock and the
`schedule:fire` event. `credentials.use` is implemented for host-mediated fetch
and WebSocket calls, with `pi.credentials.list` exposing configuration state
only (§8.3). The remaining §8.3 capabilities (`net.tcp`, `mail.draft`,
`tasks.read` and `tasks.manage`) are registered but not implemented. Their
manifest fields are validated at install (ADR plugin-host-capabilities §5);
unimplemented methods are absent.


Not enforced yet:

- Capability sandboxing inside the plugin process (Node built-ins are reachable
  there, so `fs.*` permissions gate the plugin API, not the process). This is the
  remaining gap that matters: everything in §6 and §8.0 bounds a plugin using the
  API it is supposed to use, not one that bypasses it (ADR 0008 D009)
- CPU / memory limits
- Signature verification (packages are only sha256-checked)
- Declared manifest permissions are auto-granted at load time, subject to the
  user unchecking them at install
- A `userSelected` root does not survive a restart, so a plugin has to ask again
  each session
